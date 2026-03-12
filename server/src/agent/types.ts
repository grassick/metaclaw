import type Database from "better-sqlite3"

export type SessionStatus =
  | "idle"
  | "running"
  | "waiting_for_input"
  | "completed"
  | "error"
  | "token_limit_reached"

export interface AgentRow {
  _id: string
  name: string
  system_prompt: string
  model: string | null
  version: number
  created_on: string
  modified_on: string
}

export interface SessionRow {
  _id: string
  agent_id: string
  title: string | null
  status: SessionStatus
  messages: string
  pending_tool_calls: string | null
  task_stack: string
  parent_session_id: string | null
  parent_tool_call_id: string | null
  forked_from_session_id: string | null
  model: string | null
  token_limit: number | null
  token_usage: number
  notepad: string
  created_on: string
  modified_on: string
}

export interface TaskScope {
  task_id: string
  description: string
  message_index: number
}

export interface ToolContext {
  agentId: string
  sessionId: string
  db: Database.Database
  emitEvent: (type: string, data: unknown) => void
}
