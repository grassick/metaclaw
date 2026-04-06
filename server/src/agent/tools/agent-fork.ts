import { tool } from "ai"
import { z } from "zod"
import path from "node:path"
import fs from "node:fs"
import type { MetaToolContext } from "../types"
import type { AgentRow } from "../types"
import { getAgentDb } from "../../db/init"
import { eventBus } from "../../events"

const DATA_DIR = path.join(process.cwd(), "data")
const FILES_DIR = path.join(DATA_DIR, "files")

const SLUG_REGEX = /^[a-z][a-z0-9-]*$/

interface FileRow {
  _id: string
  agent_id: string
  path: string
  mime_type: string | null
  size: number
  disk_path: string
  session_id: string | null
  source: string
  source_session_id: string | null
  created_on: string
  modified_on: string
}

export function createAgentForkTools(ctx: MetaToolContext) {
  const { agentId, sessionId, db, openRouterApiKey } = ctx

  return {
    fork_agent_from_session: tool({
      description: "Spin out the current session into a new isolated Agent. Copies the agent's capabilities (tools, functions, UI components, libraries, skills, system prompt) and optionally data (database, state). Session files are promoted to agent-scoped in the new agent.",
      inputSchema: z.object({
        slug: z.string().describe("Unique slug for the new agent (e.g. 'taxes-2025')"),
        name: z.string().describe("Human-readable display name (e.g. '2025 Taxes')"),
        copy_data: z.boolean().optional().describe("If true, copies the SQLite database and state KV store. Default: true."),
        promote_files: z.boolean().optional().describe("If true, session-scoped files are promoted to agent-scoped in the new agent. Default: true."),
      }),
      execute: async ({ slug, name, copy_data, promote_files }) => {
        if (!SLUG_REGEX.test(slug)) {
          return { error: "Slug must be lowercase letters, digits, and hyphens, starting with a letter" }
        }

        const existing = db.prepare("SELECT 1 FROM agents WHERE _id = ?").get(slug)
        if (existing) return { error: `Agent with slug '${slug}' already exists` }

        const sourceAgent = db.prepare("SELECT * FROM agents WHERE _id = ?").get(agentId) as AgentRow | undefined
        if (!sourceAgent) return { error: "Source agent not found" }

        const now = new Date().toISOString()
        const shouldCopyData = copy_data !== false
        const shouldPromoteFiles = promote_files !== false

        db.prepare(
          "INSERT INTO agents (_id, name, system_prompt, model, version, created_on, modified_on) VALUES (?, ?, ?, ?, 1, ?, ?)"
        ).run(slug, name, sourceAgent.system_prompt, sourceAgent.model, now, now)

        copyTable(db, "agent_tools", agentId, slug, now)
        copyTable(db, "agent_functions", agentId, slug, now)
        copyTable(db, "agent_libraries", agentId, slug, now)
        copyTable(db, "agent_ui_components", agentId, slug, now)
        copyTable(db, "agent_skills", agentId, slug, now)

        if (shouldCopyData) {
          const stateRows = db.prepare(
            "SELECT key, value, modified_on FROM agent_state WHERE agent_id = ?"
          ).all(agentId) as { key: string; value: string; modified_on: string }[]

          for (const row of stateRows) {
            db.prepare(
              "INSERT INTO agent_state (agent_id, key, value, modified_on) VALUES (?, ?, ?, ?)"
            ).run(slug, row.key, row.value, row.modified_on)
          }

          const sourceDbPath = path.join(DATA_DIR, `agent_data_${agentId}.db`)
          const destDbPath = path.join(DATA_DIR, `agent_data_${slug}.db`)
          if (fs.existsSync(sourceDbPath)) {
            fs.copyFileSync(sourceDbPath, destDbPath)
            const walPath = sourceDbPath + "-wal"
            if (fs.existsSync(walPath)) fs.copyFileSync(walPath, destDbPath + "-wal")
            const shmPath = sourceDbPath + "-shm"
            if (fs.existsSync(shmPath)) fs.copyFileSync(shmPath, destDbPath + "-shm")
          }
        }

        let filesPromoted = 0

        if (shouldPromoteFiles) {
          const sessionFiles = db.prepare(
            "SELECT * FROM agent_files WHERE agent_id = ? AND session_id = ?"
          ).all(agentId, sessionId) as FileRow[]

          for (const file of sessionFiles) {
            const { generateFileId } = await import("../../utils/fileId")
            const newFileId = generateFileId()
            const ext = path.extname(file.disk_path)
            const newDiskFilename = newFileId + ext
            const sourceDisk = path.join(FILES_DIR, file.disk_path)
            const destDisk = path.join(FILES_DIR, newDiskFilename)

            if (fs.existsSync(sourceDisk)) {
              fs.copyFileSync(sourceDisk, destDisk)
            }

            db.prepare(`
              INSERT INTO agent_files (_id, agent_id, path, mime_type, size, disk_path, session_id, source, source_session_id, created_on, modified_on)
              VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
            `).run(
              newFileId, slug, file.path, file.mime_type, file.size,
              newDiskFilename, file.source, file.source_session_id, now, now,
            )
            filesPromoted++
          }
        }

        const agentFiles = db.prepare(
          "SELECT * FROM agent_files WHERE agent_id = ? AND session_id IS NULL"
        ).all(agentId) as FileRow[]

        for (const file of agentFiles) {
          const { generateFileId } = await import("../../utils/fileId")
          const newFileId = generateFileId()
          const ext = path.extname(file.disk_path)
          const newDiskFilename = newFileId + ext
          const sourceDisk = path.join(FILES_DIR, file.disk_path)
          const destDisk = path.join(FILES_DIR, newDiskFilename)

          if (fs.existsSync(sourceDisk)) {
            fs.copyFileSync(sourceDisk, destDisk)
          }

          db.prepare(`
            INSERT INTO agent_files (_id, agent_id, path, mime_type, size, disk_path, session_id, source, source_session_id, created_on, modified_on)
            VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
          `).run(
            newFileId, slug, file.path, file.mime_type, file.size,
            newDiskFilename, file.source, file.source_session_id, now, now,
          )
        }

        eventBus.broadcast("agents:list", { action: "created", id: slug })

        return { id: slug, name, files_promoted: filesPromoted }
      },
    }),
  }
}

function copyTable(db: any, tableName: string, fromAgentId: string, toAgentId: string, now: string) {
  const rows = db.prepare(`SELECT * FROM ${tableName} WHERE agent_id = ?`).all(fromAgentId) as any[]
  if (rows.length === 0) return

  for (const row of rows) {
    const columns = Object.keys(row)
    const values = columns.map(col => {
      if (col === "agent_id") return toAgentId
      if (col === "created_on") return now
      if (col === "modified_on") return now
      if (col === "version") return 1
      return row[col]
    })

    const placeholders = columns.map(() => "?").join(", ")
    db.prepare(`INSERT INTO ${tableName} (${columns.join(", ")}) VALUES (${placeholders})`).run(...values)
  }
}
