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
  }

  return fns
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
};
`
  }

  return code
}
