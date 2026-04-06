import { Router } from "express"
import multer from "multer"
import path from "node:path"
import fs from "node:fs"
import type Database from "better-sqlite3"
import { generateFileId } from "../utils/fileId"
import { eventBus } from "../events"

const DATA_DIR = path.join(process.cwd(), "data")
const FILES_DIR = path.join(DATA_DIR, "files")

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

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

function fileToJson(row: FileRow) {
  return {
    id: row._id,
    path: row.path,
    size: row.size,
    mime_type: row.mime_type,
    scope: deriveScope(row),
    session_id: row.session_id,
    source: row.source,
    created_on: row.created_on,
    modified_on: row.modified_on,
  }
}

const upload = multer({
  dest: path.join(DATA_DIR, "uploads_tmp"),
  limits: { fileSize: 50 * 1024 * 1024 },
})

export function createFileRoutes(db: Database.Database): Router {
  const router = Router()
  ensureDir(FILES_DIR)

  router.post("/upload", upload.array("files", 50), async (req, res) => {
    const agentId = req.body.agent_id ?? "default"
    const sessionId = req.body.session_id || null
    const files = req.files as Express.Multer.File[] | undefined
    if (!files || files.length === 0) {
      return res.status(400).json({ error: "No files provided" })
    }

    const agent = db.prepare("SELECT 1 FROM agents WHERE _id = ?").get(agentId)
    if (!agent) return res.status(404).json({ error: "Agent not found" })

    const now = new Date().toISOString()
    const results: ReturnType<typeof fileToJson>[] = []

    const paths: string[] = Array.isArray(req.body.paths) ? req.body.paths
      : req.body.paths ? [req.body.paths]
      : []

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const fileId = generateFileId()
      const ext = path.extname(file.originalname)
      const diskFilename = fileId + ext
      const diskPath = path.join(FILES_DIR, diskFilename)

      fs.renameSync(file.path, diskPath)

      let mimeType = file.mimetype || "application/octet-stream"
      try {
        const { fileTypeFromFile } = await import("file-type")
        const detected = await fileTypeFromFile(diskPath)
        if (detected) mimeType = detected.mime
      } catch {
        // fall back to multer-provided mime
      }

      const filePath = paths[i] || file.originalname

      const stat = fs.statSync(diskPath)

      db.prepare(`
        INSERT INTO agent_files (_id, agent_id, path, mime_type, size, disk_path, session_id, source, source_session_id, created_on, modified_on)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'upload', ?, ?, ?)
      `).run(fileId, agentId, filePath, mimeType, stat.size, diskFilename, sessionId, sessionId, now, now)

      const row = db.prepare("SELECT * FROM agent_files WHERE _id = ?").get(fileId) as FileRow
      const json = fileToJson(row)
      results.push(json)

      eventBus.broadcast("file:created", {
        id: json.id,
        path: json.path,
        size: json.size,
        mime_type: json.mime_type,
        scope: json.scope,
        session_id: json.session_id,
        source_session_id: sessionId,
      })
    }

    res.status(201).json(results)
  })

  router.get("/:id/download", (req, res) => {
    const row = db.prepare("SELECT * FROM agent_files WHERE _id = ?").get(req.params.id) as FileRow | undefined
    if (!row) return res.status(404).json({ error: "File not found" })

    const diskPath = path.join(FILES_DIR, row.disk_path)
    if (!fs.existsSync(diskPath)) return res.status(404).json({ error: "File missing from disk" })

    const filename = path.basename(row.path)
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`)
    if (row.mime_type) res.setHeader("Content-Type", row.mime_type)
    res.setHeader("Content-Length", row.size)
    fs.createReadStream(diskPath).pipe(res)
  })

  router.get("/", (req, res) => {
    const agentId = req.query.agent_id as string ?? "default"
    const sessionId = req.query.session_id as string | undefined
    const scope = req.query.scope as string | undefined

    let rows: FileRow[]

    if (scope === "session" && sessionId) {
      rows = db.prepare(
        "SELECT * FROM agent_files WHERE agent_id = ? AND session_id = ? ORDER BY path"
      ).all(agentId, sessionId) as FileRow[]
    } else if (scope === "agent") {
      rows = db.prepare(
        "SELECT * FROM agent_files WHERE agent_id = ? AND session_id IS NULL ORDER BY path"
      ).all(agentId) as FileRow[]
    } else if (sessionId) {
      rows = db.prepare(
        "SELECT * FROM agent_files WHERE agent_id = ? AND (session_id = ? OR session_id IS NULL) ORDER BY path"
      ).all(agentId, sessionId) as FileRow[]
    } else {
      rows = db.prepare(
        "SELECT * FROM agent_files WHERE agent_id = ? ORDER BY path"
      ).all(agentId) as FileRow[]
    }

    res.json(rows.map(fileToJson))
  })

  router.get("/:id", (req, res) => {
    const row = db.prepare("SELECT * FROM agent_files WHERE _id = ?").get(req.params.id) as FileRow | undefined
    if (!row) return res.status(404).json({ error: "File not found" })
    res.json(fileToJson(row))
  })

  router.delete("/:id", (req, res) => {
    const row = db.prepare("SELECT * FROM agent_files WHERE _id = ?").get(req.params.id) as FileRow | undefined
    if (!row) return res.status(404).json({ error: "File not found" })

    db.prepare("DELETE FROM agent_files WHERE _id = ?").run(req.params.id)
    const diskPath = path.join(FILES_DIR, row.disk_path)
    try { fs.unlinkSync(diskPath) } catch { /* ok if already gone */ }

    eventBus.broadcast("file:deleted", { id: row._id })
    res.json({ deleted: true })
  })

  router.post("/:id/promote", (req, res) => {
    const row = db.prepare("SELECT * FROM agent_files WHERE _id = ?").get(req.params.id) as FileRow | undefined
    if (!row) return res.status(404).json({ error: "File not found" })

    if (!row.session_id) {
      return res.json(fileToJson(row))
    }

    const now = new Date().toISOString()
    db.prepare("UPDATE agent_files SET session_id = NULL, modified_on = ? WHERE _id = ?")
      .run(now, row._id)

    const updated = db.prepare("SELECT * FROM agent_files WHERE _id = ?").get(row._id) as FileRow
    res.json(fileToJson(updated))
  })

  return router
}

export { FILES_DIR, FileRow, fileToJson, deriveScope }
