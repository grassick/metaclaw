import Database from "better-sqlite3"
import path from "node:path"
import fs from "node:fs"

const DATA_DIR = path.join(process.cwd(), "data")

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

let _appDb: Database.Database | null = null

export function getAppDb(): Database.Database {
  if (_appDb) return _appDb
  ensureDir(DATA_DIR)
  const db = new Database(path.join(DATA_DIR, "metaclaw.db"))
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  initSchema(db)
  seedDefaults(db)
  _appDb = db
  return db
}

const agentDbs = new Map<string, Database.Database>()

export function getAgentDb(agentId: string): Database.Database {
  const existing = agentDbs.get(agentId)
  if (existing) return existing
  ensureDir(DATA_DIR)
  const db = new Database(path.join(DATA_DIR, `agent_data_${agentId}.db`))
  db.pragma("journal_mode = WAL")
  agentDbs.set(agentId, db)
  return db
}

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      _id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      system_prompt TEXT NOT NULL DEFAULT '',
      model TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_on TEXT NOT NULL,
      modified_on TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_sessions (
      _id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(_id) ON DELETE CASCADE,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      messages TEXT NOT NULL DEFAULT '[]',
      pending_tool_calls TEXT,
      task_stack TEXT NOT NULL DEFAULT '[]',
      parent_session_id TEXT REFERENCES agent_sessions(_id),
      parent_tool_call_id TEXT,
      forked_from_session_id TEXT REFERENCES agent_sessions(_id),
      model TEXT,
      token_limit INTEGER,
      token_usage INTEGER NOT NULL DEFAULT 0,
      notepad TEXT NOT NULL DEFAULT '',
      created_on TEXT NOT NULL,
      modified_on TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_tools (
      _id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(_id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      parameter_schema TEXT NOT NULL,
      code TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_on TEXT NOT NULL,
      modified_on TEXT NOT NULL,
      PRIMARY KEY (_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS agent_functions (
      _id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(_id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      parameter_schema TEXT NOT NULL,
      code TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_on TEXT NOT NULL,
      modified_on TEXT NOT NULL,
      PRIMARY KEY (_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS agent_libraries (
      _id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(_id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      code TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      created_on TEXT NOT NULL,
      modified_on TEXT NOT NULL,
      PRIMARY KEY (_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS agent_ui_components (
      _id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(_id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      code TEXT NOT NULL,
      props_schema TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_on TEXT NOT NULL,
      modified_on TEXT NOT NULL,
      PRIMARY KEY (_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS agent_state (
      agent_id TEXT NOT NULL REFERENCES agents(_id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      modified_on TEXT NOT NULL,
      PRIMARY KEY (agent_id, key)
    );

    CREATE TABLE IF NOT EXISTS agent_secrets (
      _id TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_on TEXT NOT NULL,
      modified_on TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_reminders (
      _id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES agent_sessions(_id) ON DELETE CASCADE,
      message TEXT NOT NULL,
      at TEXT NOT NULL,
      created_on TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_scheduled_tasks (
      _id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(_id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      task TEXT NOT NULL,
      type TEXT NOT NULL,
      at TEXT,
      cron TEXT,
      model TEXT,
      token_limit INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run TEXT,
      last_run TEXT,
      created_on TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_skills (
      _id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(_id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'user',
      version INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_on TEXT NOT NULL,
      modified_on TEXT NOT NULL,
      PRIMARY KEY (_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS agent_mcp_servers (
      _id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(_id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      transport TEXT NOT NULL,
      command TEXT,
      args TEXT,
      url TEXT,
      headers TEXT,
      env TEXT,
      tool_prefix TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_on TEXT NOT NULL,
      modified_on TEXT NOT NULL,
      PRIMARY KEY (_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS agent_files (
      _id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mime_type TEXT,
      size INTEGER NOT NULL DEFAULT 0,
      disk_path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'upload',
      source_session_id TEXT,
      created_on TEXT NOT NULL,
      modified_on TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_session_scratch (
      session_id TEXT NOT NULL REFERENCES agent_sessions(_id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      modified_on TEXT NOT NULL,
      PRIMARY KEY (session_id, key)
    );

    CREATE TABLE IF NOT EXISTS agent_config_history (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL REFERENCES agents(_id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      system_prompt TEXT NOT NULL,
      created_on TEXT NOT NULL
    );
  `)
}

const DEFAULT_SYSTEM_PROMPT = `You are a personal AI assistant that can modify itself. You can edit your own system prompt, create and manage tools, store persistent state, and interact with the user through questions and rendered UI.

Use your tools to accomplish tasks efficiently. When a task involves multiple steps, use begin_task/end_task to keep the conversation context clean.

Use the session notepad to track your working state — plans, findings, decisions — so important context survives if the conversation is compacted.

When you learn something about the user's preferences, append it to your system prompt so you remember it in future sessions.`

function seedDefaults(db: Database.Database) {
  const exists = db.prepare("SELECT 1 FROM agents WHERE _id = 'default'").get()
  if (exists) return
  const now = new Date().toISOString()
  db.prepare(
    "INSERT INTO agents (_id, name, system_prompt, version, created_on, modified_on) VALUES (?, ?, ?, 1, ?, ?)"
  ).run("default", "Default Agent", DEFAULT_SYSTEM_PROMPT, now, now)
}
