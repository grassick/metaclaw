import path from "node:path"
import fs from "node:fs"
import { generateFileId } from "../../utils/fileId"
import { eventBus } from "../../events"

export const FILES_DIR = path.join(process.cwd(), "data", "files")

export interface FileRow {
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

export function deriveScope(row: FileRow): string {
  return row.session_id ? "session" : "agent"
}

export function fileToResult(row: FileRow) {
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

export function getVisibleFile(db: any, fileId: string, agentId: string, sessionId: string): FileRow | undefined {
  const row = db.prepare("SELECT * FROM agent_files WHERE _id = ? AND agent_id = ?").get(fileId, agentId) as FileRow | undefined
  if (!row) return undefined
  if (row.session_id && row.session_id !== sessionId) return undefined
  return row
}

export function getDiskPath(row: FileRow): string {
  return path.join(FILES_DIR, row.disk_path)
}

export function validatePath(p: string): string | null {
  if (!p || p.startsWith("/")) return "Path must not start with /"
  if (p.includes("..")) return "Path must not contain .."
  if (p.includes("\\")) return "Path must not contain backslashes"
  return null
}

export function ensureFilesDir() {
  if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true })
}

/**
 * Create a new derived file row in the database and on disk.
 * Returns the new FileRow.
 */
export function createDerivedFile(
  db: any,
  agentId: string,
  sessionId: string,
  filePath: string,
  mimeType: string,
  buffer: Buffer,
): FileRow {
  const fileId = generateFileId()
  const ext = path.extname(filePath)
  const diskFilename = fileId + ext
  const diskPath = path.join(FILES_DIR, diskFilename)

  ensureFilesDir()
  fs.writeFileSync(diskPath, buffer)

  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO agent_files (_id, agent_id, path, mime_type, size, disk_path, session_id, source, source_session_id, created_on, modified_on)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'derived', ?, ?, ?)
  `).run(fileId, agentId, filePath, mimeType, buffer.length, diskFilename, sessionId, sessionId, now, now)

  eventBus.broadcast("file:created", {
    id: fileId, path: filePath, size: buffer.length, mime_type: mimeType,
    scope: "session", session_id: sessionId, source_session_id: sessionId,
  })

  return db.prepare("SELECT * FROM agent_files WHERE _id = ?").get(fileId) as FileRow
}
