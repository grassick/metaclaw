import { executeScript, type ExecutionResult } from "../scriptExecutorIsolated"
import { getAgentDb } from "../db/init"
import { generateText, generateObject } from "ai"
import { jsonSchema as aiJsonSchema } from "ai"
import { createOpenRouterProvider } from "../openRouterProvider"
import type Database from "better-sqlite3"
import { eventBus } from "../events"

export interface SandboxExecutionContext {
  agentId: string
  sessionId?: string
  appDb: Database.Database
  openRouterApiKey: string
  callDepth?: number
}

const INTELLIGENCE_MODELS: Record<string, string> = {
  low: "anthropic/claude-3.5-haiku",
  medium: "anthropic/claude-sonnet-4.6",
  high: "anthropic/claude-opus-4",
}

const MAX_CALL_DEPTH = 5
const MAX_DB_ROWS = 1000

export async function executeSandbox(
  code: string,
  ctx: SandboxExecutionContext,
  options?: {
    args?: Record<string, any>
    timeout?: number
  }
): Promise<ExecutionResult> {
  const agentDb = getAgentDb(ctx.agentId)
  const callDepth = ctx.callDepth ?? 0

  if (callDepth > MAX_CALL_DEPTH) {
    return {
      success: false,
      error: `Maximum sandbox call depth (${MAX_CALL_DEPTH}) exceeded`,
      logs: [],
    }
  }

  const libraries = ctx.appDb.prepare(
    "SELECT _id, code FROM agent_libraries WHERE agent_id = ?"
  ).all(ctx.agentId) as { _id: string; code: string }[]

  const libCode: Record<string, string> = {}
  for (const lib of libraries) {
    libCode[lib._id] = lib.code
  }

  const secretRows = ctx.appDb.prepare("SELECT _id, value FROM agent_secrets").all() as { _id: string; value: string }[]
  const secrets: Record<string, string> = {}
  for (const s of secretRows) {
    secrets[s._id] = s.value
  }

  const globals: Record<string, unknown> = {
    __libCode: libCode,
    secrets,
  }
  if (options?.args) {
    globals.args = options.args
  }

  const globalFunctions = buildGlobalFunctions(ctx, agentDb, callDepth)
  const preamble = buildPreamble(!!ctx.sessionId)

  const fullCode = `${preamble}
const __innerFn = async () => {
${code}
};
const __retVal = await __innerFn();
return __didResolve ? __resolveValue : __retVal;
`

  return executeScript(fullCode, {
    timeoutMs: options?.timeout ?? 30000,
    memoryLimit: 128 * 1024 * 1024,
    globals,
    globalFunctions,
  })
}

function buildGlobalFunctions(
  ctx: SandboxExecutionContext,
  agentDb: Database.Database,
  callDepth: number
): Record<string, (...args: any[]) => any> {
  const fns: Record<string, (...args: any[]) => any> = {}

  // ====================================================================
  // state.*
  // ====================================================================
  fns._api_state_get = async (key: string) => {
    const row = ctx.appDb.prepare(
      "SELECT value FROM agent_state WHERE agent_id = ? AND key = ?"
    ).get(ctx.agentId, key) as { value: string } | undefined
    return row ? JSON.parse(row.value) : null
  }

  fns._api_state_set = async (key: string, value: any) => {
    const now = new Date().toISOString()
    const json = JSON.stringify(value)
    ctx.appDb.prepare(
      "INSERT INTO agent_state (agent_id, key, value, modified_on) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id, key) DO UPDATE SET value = ?, modified_on = ?"
    ).run(ctx.agentId, key, json, now, json, now)
    eventBus.broadcast("state:change", { key, value })
    return null
  }

  fns._api_state_delete = async (key: string) => {
    const result = ctx.appDb.prepare(
      "DELETE FROM agent_state WHERE agent_id = ? AND key = ?"
    ).run(ctx.agentId, key)
    if (result.changes > 0) {
      eventBus.broadcast("state:change", { key, value: null, deleted: true })
    }
    return result.changes > 0
  }

  fns._api_state_keys = async (prefix?: string) => {
    let rows: { key: string }[]
    if (prefix) {
      rows = ctx.appDb.prepare(
        "SELECT key FROM agent_state WHERE agent_id = ? AND key LIKE ?"
      ).all(ctx.agentId, prefix + "%") as { key: string }[]
    } else {
      rows = ctx.appDb.prepare(
        "SELECT key FROM agent_state WHERE agent_id = ?"
      ).all(ctx.agentId) as { key: string }[]
    }
    return rows.map(r => r.key)
  }

  // ====================================================================
  // db.*
  // ====================================================================
  fns._api_db_sql = async (sql: string, params?: any[]) => {
    const trimmed = sql.trim().toUpperCase()
    const isRead = trimmed.startsWith("SELECT") || trimmed.startsWith("WITH") || trimmed.startsWith("EXPLAIN") || trimmed.startsWith("PRAGMA")

    if (trimmed.startsWith("ATTACH")) {
      throw new Error("ATTACH DATABASE is not allowed")
    }

    if (isRead) {
      const stmt = agentDb.prepare(sql)
      let columns: string[]
      try {
        columns = stmt.columns().map(c => c.name)
      } catch {
        columns = []
      }
      const rows = stmt.all(...(params || []))
      if (columns.length === 0 && rows.length > 0) {
        columns = Object.keys(rows[0] as any)
      }
      const truncated = rows.length > MAX_DB_ROWS
      const sliced = rows.slice(0, MAX_DB_ROWS)
      return {
        columns,
        rows: sliced.map(row => columns.map(col => (row as any)[col])),
        row_count: sliced.length,
        truncated,
      }
    } else {
      const result = agentDb.prepare(sql).run(...(params || []))
      return {
        changes: result.changes,
        last_insert_rowid: Number(result.lastInsertRowid),
      }
    }
  }

  fns._api_db_schema = async () => {
    const tables = agentDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all() as { name: string }[]

    return {
      tables: tables.map(t => {
        const columns = agentDb.prepare(`PRAGMA table_info("${t.name}")`).all() as {
          name: string; type: string; notnull: number; pk: number
        }[]
        const countRow = agentDb.prepare(`SELECT COUNT(*) as cnt FROM "${t.name}"`).get() as { cnt: number }
        return {
          name: t.name,
          columns: columns.map(c => ({
            name: c.name,
            type: c.type,
            notnull: c.notnull === 1,
            pk: c.pk > 0,
          })),
          row_count: countRow.cnt,
        }
      }),
    }
  }

  // ====================================================================
  // llm.generate()
  // ====================================================================
  fns._api_llm_generate = async (prompt: string, options?: any) => {
    const opts = options ?? {}
    const intelligence = opts.intelligence ?? "low"
    const modelId = INTELLIGENCE_MODELS[intelligence] ?? INTELLIGENCE_MODELS.low
    const openrouter = createOpenRouterProvider(ctx.openRouterApiKey)
    const model = openrouter(modelId)

    if (opts.schema) {
      const result = await generateObject({
        model,
        prompt,
        system: opts.system,
        schema: aiJsonSchema(opts.schema),
        maxOutputTokens: opts.maxTokens ?? 4096,
        temperature: opts.temperature ?? 0,
      })
      const raw = result.usage.raw as { cost?: number } | undefined
      const costPart = raw?.cost != null ? ` cost=$${Number(raw.cost).toFixed(6)}` : ""
      console.log(
        `[llm sandbox] generateObject tokens in=${result.usage.inputTokens ?? "?"} out=${result.usage.outputTokens ?? "?"}${costPart}`,
      )
      return {
        text: JSON.stringify(result.object),
        parsed: result.object,
        usage: {
          input_tokens: result.usage.inputTokens ?? 0,
          output_tokens: result.usage.outputTokens ?? 0,
        },
      }
    } else {
      const result = await generateText({
        model,
        prompt,
        system: opts.system,
        maxOutputTokens: opts.maxTokens ?? 4096,
        temperature: opts.temperature ?? 0,
      })
      const raw = result.usage.raw as { cost?: number } | undefined
      const costPart = raw?.cost != null ? ` cost=$${Number(raw.cost).toFixed(6)}` : ""
      console.log(
        `[llm sandbox] generateText tokens in=${result.usage.inputTokens ?? "?"} out=${result.usage.outputTokens ?? "?"}${costPart}`,
      )
      return {
        text: result.text,
        usage: {
          input_tokens: result.usage.inputTokens ?? 0,
          output_tokens: result.usage.outputTokens ?? 0,
        },
      }
    }
  }

  // ====================================================================
  // functions.call()
  // ====================================================================
  fns._api_fn_call = async (name: string, fnArgs?: any) => {
    const args = fnArgs ?? {}
    const fnRow = ctx.appDb.prepare(
      "SELECT code, parameter_schema, enabled FROM agent_functions WHERE _id = ? AND agent_id = ?"
    ).get(name, ctx.agentId) as { code: string; parameter_schema: string; enabled: number } | undefined

    if (!fnRow) throw new Error(`Function not found: ${name}`)
    if (!fnRow.enabled) throw new Error(`Function is disabled: ${name}`)

    const fnResult = await executeSandbox(fnRow.code, {
      ...ctx,
      sessionId: undefined,
      callDepth: callDepth + 1,
    }, {
      args,
    })

    if (!fnResult.success) {
      throw new Error(`Function ${name} failed: ${fnResult.error}`)
    }
    return fnResult.result
  }

  // ====================================================================
  // files.*
  // ====================================================================
  fns._api_files_list = async (pattern?: string) => {
    const sessionId = ctx.sessionId
    let rows: any[]
    if (sessionId) {
      rows = ctx.appDb.prepare(
        "SELECT * FROM agent_files WHERE agent_id = ? AND (session_id = ? OR session_id IS NULL) ORDER BY path"
      ).all(ctx.agentId, sessionId)
    } else {
      rows = ctx.appDb.prepare(
        "SELECT * FROM agent_files WHERE agent_id = ? AND session_id IS NULL ORDER BY path"
      ).all(ctx.agentId)
    }

    if (pattern) {
      const re = globToRegex(pattern)
      rows = rows.filter((r: any) => re.test(r.path))
    }

    return rows.map((r: any) => ({
      id: r._id, path: r.path, size: r.size, mime_type: r.mime_type,
      scope: r.session_id ? "session" : "agent", modified_on: r.modified_on,
    }))
  }

  fns._api_files_info = async (id: string) => {
    const row = ctx.appDb.prepare(
      "SELECT * FROM agent_files WHERE _id = ? AND agent_id = ?"
    ).get(id, ctx.agentId) as any
    if (!row) throw new Error(`File not found: ${id}`)
    return {
      id: row._id, path: row.path, size: row.size, mime_type: row.mime_type,
      scope: row.session_id ? "session" : "agent",
      session_id: row.session_id, source: row.source,
      created_on: row.created_on, modified_on: row.modified_on,
    }
  }

  fns._api_files_read_text = async (id: string, options?: any) => {
    const row = ctx.appDb.prepare(
      "SELECT * FROM agent_files WHERE _id = ? AND agent_id = ?"
    ).get(id, ctx.agentId) as any
    if (!row) throw new Error(`File not found: ${id}`)

    const fs = await import("node:fs")
    const path = await import("node:path")
    const diskPath = path.join(process.cwd(), "data", "files", row.disk_path)
    const lines = fs.readFileSync(diskPath, "utf-8").split("\n")
    const totalLines = lines.length

    if (options?.startLine || options?.endLine) {
      const s = (options.startLine ?? 1) - 1
      const e = options.endLine ?? totalLines
      return { content: lines.slice(Math.max(0, s), Math.min(totalLines, e)).join("\n"), totalLines }
    }
    return { content: lines.join("\n"), totalLines }
  }

  fns._api_files_write_text = async (id: string, content: string) => {
    const row = ctx.appDb.prepare(
      "SELECT * FROM agent_files WHERE _id = ? AND agent_id = ?"
    ).get(id, ctx.agentId) as any
    if (!row) throw new Error(`File not found: ${id}`)

    const fs = await import("node:fs")
    const path = await import("node:path")
    const diskPath = path.join(process.cwd(), "data", "files", row.disk_path)
    fs.writeFileSync(diskPath, content, "utf-8")
    const stat = fs.statSync(diskPath)
    const now = new Date().toISOString()
    ctx.appDb.prepare("UPDATE agent_files SET size = ?, modified_on = ? WHERE _id = ?")
      .run(stat.size, now, id)
    return null
  }

  fns._api_files_create = async (filePath: string, mime?: string) => {
    const { generateFileId } = await import("../utils/fileId")
    const fs = await import("node:fs")
    const pathMod = await import("node:path")

    const fileId = generateFileId()
    const ext = pathMod.extname(filePath)
    const diskFilename = fileId + ext
    const filesDir = pathMod.join(process.cwd(), "data", "files")
    if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true })
    const diskPath = pathMod.join(filesDir, diskFilename)
    fs.writeFileSync(diskPath, "", "utf-8")

    const now = new Date().toISOString()
    const sessionId = ctx.sessionId ?? null
    ctx.appDb.prepare(`
      INSERT INTO agent_files (_id, agent_id, path, mime_type, size, disk_path, session_id, source, source_session_id, created_on, modified_on)
      VALUES (?, ?, ?, ?, 0, ?, ?, 'created', ?, ?, ?)
    `).run(fileId, ctx.agentId, filePath, mime ?? "text/plain", diskFilename, sessionId, sessionId, now, now)

    return { id: fileId, path: filePath }
  }

  fns._api_files_delete = async (id: string) => {
    const row = ctx.appDb.prepare(
      "SELECT * FROM agent_files WHERE _id = ? AND agent_id = ?"
    ).get(id, ctx.agentId) as any
    if (!row) throw new Error(`File not found: ${id}`)

    ctx.appDb.prepare("DELETE FROM agent_files WHERE _id = ?").run(id)
    const fs = await import("node:fs")
    const path = await import("node:path")
    try { fs.unlinkSync(path.join(process.cwd(), "data", "files", row.disk_path)) } catch {}
    return null
  }

  fns._api_files_promote = async (id: string) => {
    const row = ctx.appDb.prepare(
      "SELECT * FROM agent_files WHERE _id = ? AND agent_id = ?"
    ).get(id, ctx.agentId) as any
    if (!row) throw new Error(`File not found: ${id}`)
    if (row.session_id) {
      const now = new Date().toISOString()
      ctx.appDb.prepare("UPDATE agent_files SET session_id = NULL, modified_on = ? WHERE _id = ?")
        .run(now, id)
    }
    return null
  }

  // ====================================================================
  // files.pdf.* (delegates to the same logic as the meta-tools)
  // ====================================================================
  const getFileRow = (id: string) => {
    const row = ctx.appDb.prepare(
      "SELECT * FROM agent_files WHERE _id = ? AND agent_id = ?"
    ).get(id, ctx.agentId) as any
    if (!row) throw new Error(`File not found: ${id}`)
    if (row.session_id && ctx.sessionId && row.session_id !== ctx.sessionId) {
      throw new Error(`File not visible: ${id}`)
    }
    return row
  }

  const getFileDiskPath = (row: any) => {
    const pathMod = require("node:path")
    return pathMod.join(process.cwd(), "data", "files", row.disk_path)
  }

  fns._api_pdf_info = async (id: string) => {
    const row = getFileRow(id)
    const { PDFDocument } = await import("pdf-lib")
    const bytes = (await import("node:fs")).readFileSync(getFileDiskPath(row))
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
    const pages = doc.getPages().map((p, i) => ({
      page: i + 1, width: Math.round(p.getWidth()), height: Math.round(p.getHeight()),
    }))
    const form = doc.getForm()
    return {
      id: row._id, path: row.path, page_count: doc.getPageCount(), pages,
      title: doc.getTitle() ?? null, author: doc.getAuthor() ?? null,
      has_forms: form.getFields().length > 0, form_field_count: form.getFields().length,
    }
  }

  fns._api_pdf_extract_text = async (id: string, options?: any) => {
    const row = getFileRow(id)
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
    const data = new Uint8Array((await import("node:fs")).readFileSync(getFileDiskPath(row)))
    const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise
    const totalPages = doc.numPages
    const targetPages = options?.pages ?? Array.from({ length: totalPages }, (_: any, i: number) => i + 1)
    const results: { page: number; text: string }[] = []
    for (const num of targetPages) {
      if (num < 1 || num > totalPages) continue
      const page = await doc.getPage(num)
      const content = await page.getTextContent()
      const text = content.items.filter((item: any) => "str" in item).map((item: any) => item.str).join("")
      results.push({ page: num, text })
    }
    doc.destroy()
    return { pages: results, total_pages: totalPages }
  }

  fns._api_pdf_page_to_image = async (id: string, pageNum: number, options?: any) => {
    const row = getFileRow(id)
    const { renderPdfPageToPng } = await import("../agent/tools/pdf")
    const { createDerivedFile } = await import("../agent/tools/file-utils")
    const pathMod = await import("node:path")

    const dpi = options?.dpi ?? 150
    const pngBuffer = await renderPdfPageToPng(getFileDiskPath(row), pageNum, dpi)
    const baseName = pathMod.basename(row.path, pathMod.extname(row.path))
    const dir = pathMod.dirname(row.path) === "." ? "" : pathMod.dirname(row.path) + "/"
    const derivedPath = `${dir}${baseName}_page${pageNum}.png`
    const newFile = createDerivedFile(ctx.appDb, ctx.agentId, ctx.sessionId ?? "", derivedPath, "image/png", pngBuffer)
    return { id: newFile._id, path: newFile.path, size: newFile.size }
  }

  fns._api_pdf_get_form_fields = async (id: string) => {
    const row = getFileRow(id)
    const { PDFDocument } = await import("pdf-lib")
    const bytes = (await import("node:fs")).readFileSync(getFileDiskPath(row))
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
    const form = doc.getForm()
    const fields = form.getFields().map(field => {
      const type = field.constructor.name.replace("PDF", "").replace("Field", "").toLowerCase()
      let value: any = null
      try {
        if ("getText" in field) value = (field as any).getText()
        else if ("isChecked" in field) value = (field as any).isChecked()
        else if ("getSelected" in field) value = (field as any).getSelected()
      } catch {}
      return { name: field.getName(), type, value, read_only: field.isReadOnly() }
    })
    return { fields, count: fields.length }
  }

  fns._api_pdf_fill_form = async (id: string, fieldValues: Record<string, string>, options?: any) => {
    const row = getFileRow(id)
    const { PDFDocument } = await import("pdf-lib")
    const fsMod = await import("node:fs")
    const bytes = fsMod.readFileSync(getFileDiskPath(row))
    const doc = await PDFDocument.load(bytes)
    const form = doc.getForm()
    const filled: string[] = []
    const errors: { field: string; error: string }[] = []
    for (const [name, value] of Object.entries(fieldValues)) {
      try {
        const field = form.getFieldMaybe(name)
        if (!field) { errors.push({ field: name, error: "Field not found" }); continue }
        const typeName = field.constructor.name
        if (typeName.includes("Text")) (field as any).setText(value)
        else if (typeName.includes("CheckBox")) {
          if (value === "true" || value === "1" || value === "yes") (field as any).check()
          else (field as any).uncheck()
        } else if (typeName.includes("Dropdown") || typeName.includes("OptionList")) (field as any).select(value)
        else if (typeName.includes("RadioGroup")) (field as any).select(value)
        else { errors.push({ field: name, error: `Unsupported type: ${typeName}` }); continue }
        filled.push(name)
      } catch (e: any) { errors.push({ field: name, error: e.message }) }
    }
    if (options?.flatten) form.flatten()
    const saved = await doc.save()
    fsMod.writeFileSync(getFileDiskPath(row), saved)
    const now = new Date().toISOString()
    ctx.appDb.prepare("UPDATE agent_files SET size = ?, modified_on = ? WHERE _id = ?").run(saved.length, now, id)
    return { filled, errors, filled_count: filled.length, error_count: errors.length }
  }

  fns._api_pdf_merge = async (ids: string[], outputPath: string) => {
    const { PDFDocument } = await import("pdf-lib")
    const fsMod = await import("node:fs")
    const { createDerivedFile } = await import("../agent/tools/file-utils")
    const merged = await PDFDocument.create()
    for (const id of ids) {
      const row = getFileRow(id)
      const bytes = fsMod.readFileSync(getFileDiskPath(row))
      const src = await PDFDocument.load(bytes)
      const pages = await merged.copyPages(src, src.getPageIndices())
      for (const page of pages) merged.addPage(page)
    }
    const saved = await merged.save()
    const newFile = createDerivedFile(ctx.appDb, ctx.agentId, ctx.sessionId ?? "", outputPath, "application/pdf", Buffer.from(saved))
    return { id: newFile._id, path: newFile.path, page_count: merged.getPageCount(), size: newFile.size }
  }

  fns._api_pdf_split_pages = async (id: string, ranges: { start: number; end: number }[]) => {
    const { PDFDocument } = await import("pdf-lib")
    const fsMod = await import("node:fs")
    const pathMod = await import("node:path")
    const { createDerivedFile } = await import("../agent/tools/file-utils")
    const row = getFileRow(id)
    const bytes = fsMod.readFileSync(getFileDiskPath(row))
    const src = await PDFDocument.load(bytes)
    const results: any[] = []
    for (const { start, end } of ranges) {
      if (start < 1 || end > src.getPageCount() || start > end) {
        throw new Error(`Invalid range ${start}-${end} (PDF has ${src.getPageCount()} pages)`)
      }
      const newDoc = await PDFDocument.create()
      const indices = Array.from({ length: end - start + 1 }, (_, j) => start - 1 + j)
      const pages = await newDoc.copyPages(src, indices)
      for (const page of pages) newDoc.addPage(page)
      const saved = await newDoc.save()
      const baseName = pathMod.basename(row.path, pathMod.extname(row.path))
      const dir = pathMod.dirname(row.path) === "." ? "" : pathMod.dirname(row.path) + "/"
      const splitPath = `${dir}${baseName}_pages${start}-${end}.pdf`
      const newFile = createDerivedFile(ctx.appDb, ctx.agentId, ctx.sessionId ?? "", splitPath, "application/pdf", Buffer.from(saved))
      results.push({ id: newFile._id, path: newFile.path, pages: `${start}-${end}`, size: newFile.size })
    }
    return { files: results }
  }

  // ====================================================================
  // skills.* (read-only)
  // ====================================================================
  fns._api_skills_list = async (tag?: string) => {
    let rows = ctx.appDb.prepare(
      "SELECT _id, title, description, tags FROM agent_skills WHERE agent_id = ? AND enabled = 1 ORDER BY _id"
    ).all(ctx.agentId) as { _id: string; title: string; description: string; tags: string }[]

    if (tag) {
      rows = rows.filter(r => {
        const tags: string[] = JSON.parse(r.tags)
        return tags.includes(tag)
      })
    }

    return rows.map(r => ({
      name: r._id, title: r.title, description: r.description, tags: JSON.parse(r.tags),
    }))
  }

  fns._api_skills_read = async (name: string) => {
    const row = ctx.appDb.prepare(
      "SELECT * FROM agent_skills WHERE _id = ? AND agent_id = ?"
    ).get(name, ctx.agentId) as any
    if (!row) throw new Error(`Skill not found: ${name}`)
    return {
      name: row._id, title: row.title, description: row.description,
      content: row.content, tags: JSON.parse(row.tags),
    }
  }

  // ====================================================================
  // session.notepad.* (only when sessionId is present)
  // ====================================================================
  if (ctx.sessionId) {
    const sid = ctx.sessionId

    fns._api_notepad_read = async () => {
      const row = ctx.appDb.prepare(
        "SELECT notepad FROM agent_sessions WHERE _id = ?"
      ).get(sid) as { notepad: string } | undefined
      return row?.notepad ?? ""
    }

    fns._api_notepad_write = async (content: string) => {
      ctx.appDb.prepare(
        "UPDATE agent_sessions SET notepad = ?, modified_on = ? WHERE _id = ?"
      ).run(content, new Date().toISOString(), sid)
      return null
    }

    fns._api_notepad_append = async (text: string) => {
      const row = ctx.appDb.prepare(
        "SELECT notepad FROM agent_sessions WHERE _id = ?"
      ).get(sid) as { notepad: string } | undefined
      const updated = (row?.notepad ?? "") + text
      ctx.appDb.prepare(
        "UPDATE agent_sessions SET notepad = ?, modified_on = ? WHERE _id = ?"
      ).run(updated, new Date().toISOString(), sid)
      return null
    }

    // ====================================================================
    // session.scratch.* (session-scoped structured scratch storage)
    // ====================================================================
    fns._api_scratch_get = async (key: string) => {
      const row = ctx.appDb.prepare(
        "SELECT value FROM agent_session_scratch WHERE session_id = ? AND key = ?"
      ).get(sid, key) as { value: string } | undefined
      return row ? JSON.parse(row.value) : null
    }

    fns._api_scratch_set = async (key: string, value: any) => {
      const now = new Date().toISOString()
      const json = JSON.stringify(value)
      ctx.appDb.prepare(
        "INSERT INTO agent_session_scratch (session_id, key, value, modified_on) VALUES (?, ?, ?, ?) ON CONFLICT(session_id, key) DO UPDATE SET value = ?, modified_on = ?"
      ).run(sid, key, json, now, json, now)
      return null
    }

    fns._api_scratch_delete = async (key: string) => {
      const result = ctx.appDb.prepare(
        "DELETE FROM agent_session_scratch WHERE session_id = ? AND key = ?"
      ).run(sid, key)
      return result.changes > 0
    }

    fns._api_scratch_keys = async (prefix?: string) => {
      let rows: { key: string }[]
      if (prefix) {
        rows = ctx.appDb.prepare(
          "SELECT key FROM agent_session_scratch WHERE session_id = ? AND key LIKE ?"
        ).all(sid, prefix + "%") as { key: string }[]
      } else {
        rows = ctx.appDb.prepare(
          "SELECT key FROM agent_session_scratch WHERE session_id = ?"
        ).all(sid) as { key: string }[]
      }
      return rows.map(r => r.key)
    }

    // ====================================================================
    // session.beginTask / session.endTask
    // ====================================================================
    fns._api_session_begin_task = async (description: string) => {
      const session = ctx.appDb.prepare(
        "SELECT task_stack, messages FROM agent_sessions WHERE _id = ?"
      ).get(sid) as { task_stack: string; messages: string } | undefined
      if (!session) throw new Error("Session not found")

      const stack = JSON.parse(session.task_stack) as { task_id: string; description: string; message_index: number }[]
      const messages = JSON.parse(session.messages)
      const taskId = crypto.randomUUID()
      const depth = stack.length + 1
      if (depth > 4) throw new Error("Maximum task nesting depth (4) exceeded")

      stack.push({ task_id: taskId, description, message_index: messages.length })
      ctx.appDb.prepare("UPDATE agent_sessions SET task_stack = ?, modified_on = ? WHERE _id = ?")
        .run(JSON.stringify(stack), new Date().toISOString(), sid)

      return { task_id: taskId, depth }
    }

    fns._api_session_end_task = async (summary: string) => {
      const session = ctx.appDb.prepare(
        "SELECT task_stack FROM agent_sessions WHERE _id = ?"
      ).get(sid) as { task_stack: string } | undefined
      if (!session) throw new Error("Session not found")

      const stack = JSON.parse(session.task_stack) as { task_id: string; description: string; message_index: number }[]
      if (stack.length === 0) throw new Error("No open task scope to end")

      stack.pop()
      ctx.appDb.prepare("UPDATE agent_sessions SET task_stack = ?, modified_on = ? WHERE _id = ?")
        .run(JSON.stringify(stack), new Date().toISOString(), sid)

      return { messages_collapsed: 0 }
    }
  }

  return fns
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

function buildPreamble(hasSession: boolean): string {
  let code = `
let __didResolve = false;
let __resolveValue;
function resolve(value) { __didResolve = true; __resolveValue = value; }

const state = {
  get: async (key) => _api_state_getAsync(key),
  set: async (key, value) => { await _api_state_setAsync(key, value); },
  delete: async (key) => _api_state_deleteAsync(key),
  keys: async (prefix) => _api_state_keysAsync(prefix),
};

const db = {
  sql: async (sql, params) => _api_db_sqlAsync(sql, params || []),
  schema: async () => _api_db_schemaAsync(),
};

const llm = {
  generate: async (prompt, options) => _api_llm_generateAsync(prompt, options || {}),
};

const functions = {
  call: async (name, fnArgs) => _api_fn_callAsync(name, fnArgs || {}),
};

const files = {
  list: async (pattern) => _api_files_listAsync(pattern),
  info: async (id) => _api_files_infoAsync(id),
  create: async (path, mime) => _api_files_createAsync(path, mime),
  delete: async (id) => { await _api_files_deleteAsync(id); },
  promote: async (id) => { await _api_files_promoteAsync(id); },
  readText: async (id, options) => _api_files_read_textAsync(id, options || {}),
  writeText: async (id, content) => { await _api_files_write_textAsync(id, content); },
  pdf: {
    info: async (id) => _api_pdf_infoAsync(id),
    extractText: async (id, options) => _api_pdf_extract_textAsync(id, options || {}),
    pageToImage: async (id, pageNum, options) => _api_pdf_page_to_imageAsync(id, pageNum, options || {}),
    getFormFields: async (id) => _api_pdf_get_form_fieldsAsync(id),
    fillForm: async (id, fields, options) => _api_pdf_fill_formAsync(id, fields, options || {}),
    merge: async (ids, outputPath) => _api_pdf_mergeAsync(ids, outputPath),
    splitPages: async (id, ranges) => _api_pdf_split_pagesAsync(id, ranges),
  },
};

const skills = {
  list: async (tag) => _api_skills_listAsync(tag),
  read: async (name) => _api_skills_readAsync(name),
};

const __libCache = {};
const __libStack = [];
function require(name) {
  if (name in __libCache) return __libCache[name];
  if (__libStack.indexOf(name) !== -1) {
    throw new Error('Circular dependency: ' + __libStack.join(' -> ') + ' -> ' + name);
  }
  if (typeof __libCode === 'undefined' || !(name in __libCode)) {
    throw new Error('Library not found: ' + name);
  }
  if (__libStack.length >= 10) {
    throw new Error('Max require depth (10) exceeded');
  }
  __libStack.push(name);
  try {
    var module = { exports: {} };
    var _exports = module.exports;
    var _fn = (0, eval)('(function(module, exports, require) {\\n' + __libCode[name] + '\\n})');
    _fn(module, _exports, require);
    __libCache[name] = module.exports;
    return module.exports;
  } finally {
    __libStack.pop();
  }
}
`

  if (hasSession) {
    code += `
const session = {
  notepad: {
    read: async () => _api_notepad_readAsync(),
    write: async (content) => { await _api_notepad_writeAsync(content); },
    append: async (text) => { await _api_notepad_appendAsync(text); },
  },
  scratch: {
    get: async (key) => _api_scratch_getAsync(key),
    set: async (key, value) => { await _api_scratch_setAsync(key, value); },
    delete: async (key) => _api_scratch_deleteAsync(key),
    keys: async (prefix) => _api_scratch_keysAsync(prefix),
  },
  beginTask: async (description) => _api_session_begin_taskAsync(description),
  endTask: async (summary) => _api_session_end_taskAsync(summary),
};
`
  }

  return code
}
