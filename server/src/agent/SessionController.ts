import { streamText, stepCountIs, type ModelMessage, type ToolResultPart, type ToolSet } from "ai"
import type Database from "better-sqlite3"
import type { AgentRow, SessionRow, SessionStatus } from "./types"
import { createMetaTools } from "./tools"
import { buildSystemPrompt } from "./PersonalAgent"
import { createOpenRouterProvider } from "../openRouterProvider"
import { eventBus } from "../events"

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-20250514"
const MAX_STEPS = 25

export class SessionController {
  private db: Database.Database
  private openrouter: ReturnType<typeof createOpenRouterProvider>

  constructor(db: Database.Database, openRouterApiKey: string) {
    this.db = db
    this.openrouter = createOpenRouterProvider(openRouterApiKey)
  }

  // ================================================================
  // Session CRUD
  // ================================================================

  createSession(agentId: string, opts?: { title?: string; parentSessionId?: string; model?: string }): SessionRow {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()

    this.db.prepare(`
      INSERT INTO agent_sessions (_id, agent_id, title, status, messages, task_stack, parent_session_id, model, notepad, created_on, modified_on)
      VALUES (?, ?, ?, 'idle', '[]', '[]', ?, ?, '', ?, ?)
    `).run(id, agentId, opts?.title ?? null, opts?.parentSessionId ?? null, opts?.model ?? null, now, now)

    eventBus.broadcast("sessions:list", { action: "created", id, agent_id: agentId })

    return this.getSession(id)!
  }

  getSession(sessionId: string): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM agent_sessions WHERE _id = ?").get(sessionId) as SessionRow | undefined
  }

  listSessions(agentId: string): SessionRow[] {
    return this.db.prepare(
      "SELECT * FROM agent_sessions WHERE agent_id = ? AND parent_session_id IS NULL ORDER BY created_on DESC"
    ).all(agentId) as SessionRow[]
  }

  deleteSession(sessionId: string): boolean {
    const result = this.db.prepare("DELETE FROM agent_sessions WHERE _id = ?").run(sessionId)
    if (result.changes > 0) {
      eventBus.broadcast("sessions:list", { action: "deleted", id: sessionId })
    }
    return result.changes > 0
  }

  // ================================================================
  // Message Handling
  // ================================================================

  async handleUserMessage(sessionId: string, content: string): Promise<void> {
    const session = this.getSession(sessionId)
    if (!session) throw new Error("Session not found")
    if (session.status === "completed" || session.status === "error") {
      throw new Error(`Session is in terminal state: ${session.status}`)
    }

    const messages: ModelMessage[] = JSON.parse(session.messages)
    messages.push({ role: "user", content })

    if (!session.title) {
      const title = content.slice(0, 100) + (content.length > 100 ? "…" : "")
      this.db.prepare("UPDATE agent_sessions SET title = ? WHERE _id = ?").run(title, sessionId)
    }

    this.db.prepare("UPDATE agent_sessions SET messages = ?, modified_on = ? WHERE _id = ?")
      .run(JSON.stringify(messages), new Date().toISOString(), sessionId)

    await this.runAgentStep(sessionId)
  }

  async handleToolResponse(sessionId: string, toolCallId: string, result: unknown): Promise<void> {
    const session = this.getSession(sessionId)
    if (!session) throw new Error("Session not found")
    if (session.status !== "waiting_for_input") {
      throw new Error(`Session is not waiting for input (status: ${session.status})`)
    }

    const messages: ModelMessage[] = JSON.parse(session.messages)

    const pending = session.pending_tool_calls ? JSON.parse(session.pending_tool_calls) : []
    const pendingCall = pending.find((tc: any) => tc.toolCallId === toolCallId)
    const toolName = pendingCall?.toolName ?? "unknown"

    messages.push({
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId,
        toolName,
        output: toToolResultOutput(result),
      }],
    })

    this.db.prepare("UPDATE agent_sessions SET messages = ?, pending_tool_calls = NULL, modified_on = ? WHERE _id = ?")
      .run(JSON.stringify(messages), new Date().toISOString(), sessionId)

    await this.runAgentStep(sessionId)
  }

  // ================================================================
  // Agent Step Loop
  // ================================================================

  private async runAgentStep(sessionId: string): Promise<void> {
    const session = this.getSession(sessionId)
    if (!session) throw new Error("Session not found")

    const agent = this.db.prepare("SELECT * FROM agents WHERE _id = ?").get(session.agent_id) as AgentRow | undefined
    if (!agent) throw new Error("Agent not found")

    this.updateStatus(sessionId, "running")

    const messages: ModelMessage[] = JSON.parse(session.messages)
    const systemPrompt = buildSystemPrompt(this.db, agent, session)
    const modelId = session.model ?? agent.model ?? DEFAULT_MODEL
    const model = this.openrouter(modelId)

    const tools = createMetaTools({
      agentId: agent._id,
      sessionId,
      db: this.db,
    }) as ToolSet

    try {
      const result = streamText({
        model,
        system: systemPrompt,
        messages,
        tools,
        stopWhen: stepCountIs(MAX_STEPS),
      })

      for await (const part of result.fullStream) {
        switch (part.type) {
          case "text-delta":
            eventBus.broadcast("session:stream", { id: sessionId, delta: part.text })
            break
          case "tool-call":
            eventBus.broadcast("session:tool_call", {
              id: sessionId,
              tool_call_id: part.toolCallId,
              name: part.toolName,
              args: part.input,
              status: "running",
            })
            break
          case "tool-result":
            eventBus.broadcast("session:tool_call", {
              id: sessionId,
              tool_call_id: part.toolCallId,
              name: part.toolName,
              result: truncateForSSE(part.output),
              status: "complete",
            })
            break
        }
      }

      // Stream finished — persist results
      const steps = await result.steps
      const totalUsage = await result.totalUsage
      const responseMessages = (await result.response).messages

      const allMessages = [...messages, ...responseMessages]

      // Detect pending tool calls (pausing tools like ask_user that have no execute)
      const lastStep = steps[steps.length - 1]
      const resolvedCallIds = new Set(lastStep?.toolResults?.map((tr: any) => tr.toolCallId) ?? [])
      const pendingToolCalls = (lastStep?.toolCalls ?? []).filter(
        (tc: any) => !resolvedCallIds.has(tc.toolCallId)
      )

      const newStatus: SessionStatus = pendingToolCalls.length > 0 ? "waiting_for_input" : "idle"
      const now = new Date().toISOString()

      this.db.prepare(`
        UPDATE agent_sessions
        SET messages = ?, status = ?, token_usage = token_usage + ?, pending_tool_calls = ?, modified_on = ?
        WHERE _id = ?
      `).run(
        JSON.stringify(allMessages),
        newStatus,
        totalUsage?.totalTokens ?? 0,
        pendingToolCalls.length > 0 ? JSON.stringify(pendingToolCalls) : null,
        now,
        sessionId,
      )

      this.updateStatus(sessionId, newStatus)

      for (const tc of pendingToolCalls) {
        eventBus.broadcast("session:pending_input", {
          id: sessionId,
          tool_call_id: tc.toolCallId,
          name: tc.toolName,
          args: tc.input,
        })
      }

      const lastText = steps[steps.length - 1]?.text
      if (lastText) {
        eventBus.broadcast("session:message", {
          id: sessionId,
          message: { role: "assistant", content: lastText },
        })
      }

    } catch (err) {
      console.error(`Agent step error (session ${sessionId}):`, err)
      const now = new Date().toISOString()
      this.db.prepare("UPDATE agent_sessions SET status = 'error', modified_on = ? WHERE _id = ?").run(now, sessionId)
      this.updateStatus(sessionId, "error")
      eventBus.broadcast("session:message", {
        id: sessionId,
        message: { role: "assistant", content: `Error: ${err instanceof Error ? err.message : String(err)}` },
      })
    }
  }

  private updateStatus(sessionId: string, status: SessionStatus) {
    eventBus.broadcast("session:status", { id: sessionId, status })
  }
}

function truncateForSSE(value: unknown): unknown {
  const str = typeof value === "string" ? value : JSON.stringify(value)
  if (str && str.length > 500) return str.slice(0, 500) + "…"
  return value
}

function toToolResultOutput(value: unknown): ToolResultPart["output"] {
  return value as ToolResultPart["output"]
}
