import { tool } from "ai"
import { z } from "zod"
import path from "node:path"
import fs from "node:fs"
import type { MetaToolContext } from "../types"
import { generateFileId } from "../../utils/fileId"
import { eventBus } from "../../events"

const FILES_DIR = path.join(process.cwd(), "data", "files")

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

function deriveScope(row: FileRow): string {
  return row.session_id ? "session" : "agent"
}

function fileToResult(row: FileRow) {
  return {
    id: row._id,
    path: row.path,
    size: row.size,
    mime_type: row.mime_type,
    scope: deriveScope(row),
    session_id: row.session_id,
    modified_on: row.modified_on,
  }
}

function visibleFilesQuery(agentId: string, sessionId: string, db: any, scope?: string) {
  if (scope === "session") {
    return db.prepare(
      "SELECT * FROM agent_files WHERE agent_id = ? AND session_id = ? ORDER BY path"
    ).all(agentId, sessionId) as FileRow[]
  }
  if (scope === "agent") {
    return db.prepare(
      "SELECT * FROM agent_files WHERE agent_id = ? AND session_id IS NULL ORDER BY path"
    ).all(agentId) as FileRow[]
  }
  return db.prepare(
    "SELECT * FROM agent_files WHERE agent_id = ? AND (session_id = ? OR session_id IS NULL) ORDER BY path"
  ).all(agentId, sessionId) as FileRow[]
}

function getVisibleFile(db: any, fileId: string, agentId: string, sessionId: string): FileRow | undefined {
  const row = db.prepare("SELECT * FROM agent_files WHERE _id = ? AND agent_id = ?").get(fileId, agentId) as FileRow | undefined
  if (!row) return undefined
  if (row.session_id && row.session_id !== sessionId) return undefined
  return row
}

function validatePath(p: string): string | null {
  if (!p || p.startsWith("/")) return "Path must not start with /"
  if (p.includes("..")) return "Path must not contain .."
  if (p.includes("\\")) return "Path must not contain backslashes"
  return null
}

function getDiskPath(row: FileRow): string {
  return path.join(FILES_DIR, row.disk_path)
}

function readFileLines(diskPath: string): string[] {
  return fs.readFileSync(diskPath, "utf-8").split("\n")
}

export function createFileTools(ctx: MetaToolContext) {
  const { agentId, sessionId, db } = ctx

  return {
    file_list: tool({
      description: "List files visible to the current session. Returns session-scoped + agent-scoped files.",
      inputSchema: z.object({
        pattern: z.string().optional().describe("Glob pattern to filter files by path"),
        scope: z.enum(["session", "agent", "all"]).optional().describe("Filter to a specific scope. Default: all visible."),
      }),
      execute: async ({ pattern, scope }) => {
        let rows = visibleFilesQuery(agentId, sessionId, db, scope === "all" ? undefined : scope)

        if (pattern) {
          const re = globToRegex(pattern)
          rows = rows.filter(r => re.test(r.path))
        }

        return { files: rows.map(fileToResult) }
      },
    }),

    file_info: tool({
      description: "Get full metadata for a file by ID",
      inputSchema: z.object({
        id: z.string().describe("File ID"),
      }),
      execute: async ({ id }) => {
        const row = getVisibleFile(db, id, agentId, sessionId)
        if (!row) return { error: "File not found or not visible" }
        return fileToResult(row)
      },
    }),

    file_read_text: tool({
      description: "Read text content from a file, optionally a line range",
      inputSchema: z.object({
        id: z.string().describe("File ID"),
        start_line: z.number().optional().describe("First line (1-based). Omit for start."),
        end_line: z.number().optional().describe("Last line (inclusive). Omit for end."),
      }),
      execute: async ({ id, start_line, end_line }) => {
        const row = getVisibleFile(db, id, agentId, sessionId)
        if (!row) return { error: "File not found or not visible" }

        const diskPath = getDiskPath(row)
        if (!fs.existsSync(diskPath)) return { error: "File missing from disk" }

        const lines = readFileLines(diskPath)
        const totalLines = lines.length
        const s = (start_line ?? 1) - 1
        const e = end_line ?? totalLines
        const content = lines.slice(Math.max(0, s), Math.min(totalLines, e)).join("\n")

        return { content, total_lines: totalLines }
      },
    }),

    file_write_text: tool({
      description: "Write (overwrite) the entire content of a text file",
      inputSchema: z.object({
        id: z.string().describe("File ID"),
        content: z.string().describe("Full text content to write"),
      }),
      execute: async ({ id, content }) => {
        const row = getVisibleFile(db, id, agentId, sessionId)
        if (!row) return { error: "File not found or not visible" }

        const diskPath = getDiskPath(row)
        fs.writeFileSync(diskPath, content, "utf-8")
        const stat = fs.statSync(diskPath)
        const now = new Date().toISOString()

        db.prepare("UPDATE agent_files SET size = ?, modified_on = ? WHERE _id = ?")
          .run(stat.size, now, id)

        eventBus.broadcast("file:modified", { id, path: row.path, size: stat.size, modified_on: now })

        return { ok: true, size: stat.size }
      },
    }),

    file_replace_lines: tool({
      description: "Replace a range of lines in a text file",
      inputSchema: z.object({
        id: z.string().describe("File ID"),
        start_line: z.number().describe("First line to replace (1-based)"),
        end_line: z.number().describe("Last line to replace (inclusive)"),
        content: z.string().describe("Replacement text"),
      }),
      execute: async ({ id, start_line, end_line, content }) => {
        const row = getVisibleFile(db, id, agentId, sessionId)
        if (!row) return { error: "File not found or not visible" }

        const diskPath = getDiskPath(row)
        if (!fs.existsSync(diskPath)) return { error: "File missing from disk" }

        const lines = readFileLines(diskPath)
        const newLines = content.split("\n")
        lines.splice(start_line - 1, end_line - start_line + 1, ...newLines)
        const newContent = lines.join("\n")
        fs.writeFileSync(diskPath, newContent, "utf-8")

        const stat = fs.statSync(diskPath)
        const now = new Date().toISOString()
        db.prepare("UPDATE agent_files SET size = ?, modified_on = ? WHERE _id = ?")
          .run(stat.size, now, id)

        eventBus.broadcast("file:modified", { id, path: row.path, size: stat.size, modified_on: now })

        return { ok: true, total_lines: lines.length }
      },
    }),

    file_create: tool({
      description: "Create a new file at a logical path",
      inputSchema: z.object({
        path: z.string().describe("Logical file path (e.g. 'report.xlsx' or 'output/summary.pdf')"),
        content: z.string().optional().describe("Optional initial text content"),
        mime_type: z.string().optional().describe("Optional MIME type. Auto-detected if omitted."),
        scope: z.enum(["session", "agent"]).optional().describe("Override default scope. Default: session."),
      }),
      execute: async ({ path: filePath, content, mime_type, scope }) => {
        const pathErr = validatePath(filePath)
        if (pathErr) return { error: pathErr }

        const fileId = generateFileId()
        const ext = path.extname(filePath)
        const diskFilename = fileId + ext
        const diskPath = path.join(FILES_DIR, diskFilename)

        if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true })
        fs.writeFileSync(diskPath, content ?? "", "utf-8")

        const stat = fs.statSync(diskPath)
        const now = new Date().toISOString()
        const fileSessionId = scope === "agent" ? null : sessionId

        let mimeType = mime_type ?? "text/plain"
        if (!mime_type && content) {
          const extLower = ext.toLowerCase()
          if (extLower === ".json") mimeType = "application/json"
          else if (extLower === ".html") mimeType = "text/html"
          else if (extLower === ".css") mimeType = "text/css"
          else if (extLower === ".js") mimeType = "text/javascript"
          else if (extLower === ".csv") mimeType = "text/csv"
          else if (extLower === ".md") mimeType = "text/markdown"
        }

        db.prepare(`
          INSERT INTO agent_files (_id, agent_id, path, mime_type, size, disk_path, session_id, source, source_session_id, created_on, modified_on)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?)
        `).run(fileId, agentId, filePath, mimeType, stat.size, diskFilename, fileSessionId, sessionId, now, now)

        const resultScope = fileSessionId ? "session" : "agent"

        eventBus.broadcast("file:created", {
          id: fileId, path: filePath, size: stat.size, mime_type: mimeType,
          scope: resultScope, session_id: fileSessionId, source_session_id: sessionId,
        })

        return { id: fileId, path: filePath, scope: resultScope }
      },
    }),

    file_delete: tool({
      description: "Delete a file by ID",
      inputSchema: z.object({
        id: z.string().describe("File ID"),
      }),
      execute: async ({ id }) => {
        const row = getVisibleFile(db, id, agentId, sessionId)
        if (!row) return { error: "File not found or not visible" }

        db.prepare("DELETE FROM agent_files WHERE _id = ?").run(id)
        try { fs.unlinkSync(getDiskPath(row)) } catch { /* ok */ }

        eventBus.broadcast("file:deleted", { id })
        return { deleted: true }
      },
    }),

    file_download: tool({
      description: "Download a URL into the file workspace (server-side fetch + save)",
      inputSchema: z.object({
        url: z.string().describe("URL to download"),
        path: z.string().optional().describe("Optional file path. Inferred from URL if omitted."),
      }),
      execute: async ({ url, path: filePath }) => {
        try {
          const response = await fetch(url)
          if (!response.ok) return { error: `HTTP ${response.status}: ${response.statusText}` }

          const inferredPath = filePath ?? new URL(url).pathname.split("/").pop() ?? "download"
          const pathErr = validatePath(inferredPath)
          if (pathErr) return { error: pathErr }

          const fileId = generateFileId()
          const ext = path.extname(inferredPath)
          const diskFilename = fileId + ext
          const diskPath = path.join(FILES_DIR, diskFilename)

          if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true })

          const buffer = Buffer.from(await response.arrayBuffer())
          fs.writeFileSync(diskPath, buffer)

          let mimeType = response.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream"
          try {
            const { fileTypeFromFile } = await import("file-type")
            const detected = await fileTypeFromFile(diskPath)
            if (detected) mimeType = detected.mime
          } catch { /* keep header-derived type */ }

          const stat = fs.statSync(diskPath)
          const now = new Date().toISOString()

          db.prepare(`
            INSERT INTO agent_files (_id, agent_id, path, mime_type, size, disk_path, session_id, source, source_session_id, created_on, modified_on)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?)
          `).run(fileId, agentId, inferredPath, mimeType, stat.size, diskFilename, sessionId, sessionId, now, now)

          eventBus.broadcast("file:created", {
            id: fileId, path: inferredPath, size: stat.size, mime_type: mimeType,
            scope: "session", session_id: sessionId, source_session_id: sessionId,
          })

          return { id: fileId, path: inferredPath, size: stat.size, mime_type: mimeType, scope: "session" }
        } catch (err) {
          return { error: `Download failed: ${err instanceof Error ? err.message : String(err)}` }
        }
      },
    }),

    promote_file: tool({
      description: "Promote a file from session scope to agent scope",
      inputSchema: z.object({
        id: z.string().describe("File ID"),
        target_scope: z.enum(["agent"]).describe("New scope for the file"),
      }),
      execute: async ({ id }) => {
        const row = getVisibleFile(db, id, agentId, sessionId)
        if (!row) return { error: "File not found or not visible" }

        if (!row.session_id) {
          return { id: row._id, scope: "agent" }
        }

        const now = new Date().toISOString()
        db.prepare("UPDATE agent_files SET session_id = NULL, modified_on = ? WHERE _id = ?")
          .run(now, id)

        return { id: row._id, scope: "agent" }
      },
    }),

    file_search: tool({
      description: "Search across all text files visible to the current session",
      inputSchema: z.object({
        pattern: z.string().describe("Regex pattern to search for"),
        glob: z.string().optional().describe("Path glob to filter which files to search"),
        scope: z.enum(["session", "agent", "all"]).optional().describe("Narrow to a specific scope. Default: all visible."),
      }),
      execute: async ({ pattern, glob, scope }) => {
        let rows = visibleFilesQuery(agentId, sessionId, db, scope === "all" ? undefined : scope)

        if (glob) {
          const re = globToRegex(glob)
          rows = rows.filter(r => re.test(r.path))
        }

        const textTypes = ["text/", "application/json", "application/javascript", "application/xml", "application/csv"]
        const textFiles = rows.filter(r =>
          r.mime_type && textTypes.some(t => r.mime_type!.startsWith(t))
        )

        const MAX_FILES = 50
        const MAX_MATCHES = 100
        let totalMatches = 0
        const matches: { file_id: string; path: string; mime_type: string; excerpts: { line: number; text: string }[] }[] = []

        const re = new RegExp(pattern, "gi")

        for (const file of textFiles.slice(0, MAX_FILES)) {
          if (totalMatches >= MAX_MATCHES) break
          const diskPath = getDiskPath(file)
          if (!fs.existsSync(diskPath)) continue

          try {
            const lines = readFileLines(diskPath)
            const excerpts: { line: number; text: string }[] = []
            for (let i = 0; i < lines.length && totalMatches < MAX_MATCHES; i++) {
              if (re.test(lines[i])) {
                excerpts.push({ line: i + 1, text: lines[i] })
                totalMatches++
              }
              re.lastIndex = 0
            }
            if (excerpts.length > 0) {
              matches.push({ file_id: file._id, path: file.path, mime_type: file.mime_type ?? "", excerpts })
            }
          } catch { /* skip unreadable files */ }
        }

        return {
          matches,
          files_searched: Math.min(textFiles.length, MAX_FILES),
          truncated: totalMatches >= MAX_MATCHES || textFiles.length > MAX_FILES,
        }
      },
    }),
  }
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<<GLOBSTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<<GLOBSTAR>>>/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`)
}
