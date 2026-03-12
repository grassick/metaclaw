import { tool } from "ai"
import { z } from "zod"
import type Database from "better-sqlite3"
import type { AgentRow, SessionRow, TaskScope } from "./types"
import { eventBus } from "../events"

/**
 * Context needed by meta-tools during execution.
 * Passed to createMetaTools so each tool closes over the right session/agent.
 */
export interface MetaToolContext {
  agentId: string
  sessionId: string
  db: Database.Database
}

/**
 * Creates all Phase 1 built-in meta-tools.
 * Tools with `execute` run immediately; tools without (ask_user) pause the agent loop.
 */
export function createMetaTools(ctx: MetaToolContext) {
  const { agentId, sessionId, db } = ctx

  return {
    // ================================================================
    // Self-Modification
    // ================================================================
    read_system_prompt: tool({
      description: "Read the current stored system prompt",
      inputSchema: z.object({}),
      execute: async () => {
        const row = db.prepare("SELECT system_prompt, version FROM agents WHERE _id = ?").get(agentId) as AgentRow | undefined
        if (!row) return { error: "Agent not found" }
        return { prompt: row.system_prompt, version: row.version }
      },
    }),

    edit_system_prompt: tool({
      description: "Edit the system prompt (replace, find_replace, append, prepend, delete)",
      inputSchema: z.object({
        operation: z.enum(["replace", "find_replace", "append", "prepend", "delete"]).describe("The type of edit to perform"),
        content: z.string().optional().describe("For replace: the new full prompt. For append/prepend: text to add. For delete: text to remove."),
        find: z.string().optional().describe("For find_replace: the exact substring to find"),
        replace: z.string().optional().describe("For find_replace: the replacement text"),
        replace_all: z.boolean().optional().describe("For find_replace: replace all occurrences. Default: false."),
      }),
      execute: async ({ operation, content, find, replace, replace_all }) => {
        const row = db.prepare("SELECT system_prompt, version FROM agents WHERE _id = ?").get(agentId) as AgentRow | undefined
        if (!row) return { error: "Agent not found" }

        const now = new Date().toISOString()
        let newPrompt = row.system_prompt

        switch (operation) {
          case "replace":
            if (!content) return { error: "content is required for replace" }
            newPrompt = content
            break
          case "find_replace":
            if (!find || replace === undefined) return { error: "find and replace are required for find_replace" }
            if (!newPrompt.includes(find)) return { error: `Could not find: "${find}"` }
            newPrompt = replace_all ? newPrompt.replaceAll(find, replace) : newPrompt.replace(find, replace)
            break
          case "append":
            if (!content) return { error: "content is required for append" }
            newPrompt = newPrompt + content
            break
          case "prepend":
            if (!content) return { error: "content is required for prepend" }
            newPrompt = content + newPrompt
            break
          case "delete":
            if (!content) return { error: "content is required for delete" }
            if (!newPrompt.includes(content)) return { error: `Could not find text to delete` }
            newPrompt = newPrompt.replace(content, "")
            break
        }

        const newVersion = row.version + 1

        // Save history for rollback
        db.prepare(
          "INSERT INTO agent_config_history (agent_id, version, system_prompt, created_on) VALUES (?, ?, ?, ?)"
        ).run(agentId, row.version, row.system_prompt, now)

        db.prepare(
          "UPDATE agents SET system_prompt = ?, version = ?, modified_on = ? WHERE _id = ?"
        ).run(newPrompt, newVersion, now, agentId)

        return { version: newVersion }
      },
    }),

    // ================================================================
    // State Management
    // ================================================================
    get_state: tool({
      description: "Read a persistent state value by key",
      inputSchema: z.object({
        key: z.string().describe("The state key to read"),
      }),
      execute: async ({ key }) => {
        const row = db.prepare("SELECT value FROM agent_state WHERE agent_id = ? AND key = ?").get(agentId, key) as { value: string } | undefined
        return { value: row ? JSON.parse(row.value) : null }
      },
    }),

    set_state: tool({
      description: "Write a persistent state value",
      inputSchema: z.object({
        key: z.string().describe("The state key to write"),
        value: z.any().describe("Any JSON-serializable value"),
      }),
      execute: async ({ key, value }) => {
        const now = new Date().toISOString()
        db.prepare(
          "INSERT INTO agent_state (agent_id, key, value, modified_on) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id, key) DO UPDATE SET value = ?, modified_on = ?"
        ).run(agentId, key, JSON.stringify(value), now, JSON.stringify(value), now)

        eventBus.broadcast("state:change", { key, value })
        return { ok: true }
      },
    }),

    delete_state: tool({
      description: "Delete a persistent state key",
      inputSchema: z.object({
        key: z.string().describe("The state key to delete"),
      }),
      execute: async ({ key }) => {
        const result = db.prepare("DELETE FROM agent_state WHERE agent_id = ? AND key = ?").run(agentId, key)
        if (result.changes > 0) {
          eventBus.broadcast("state:change", { key, value: null, deleted: true })
        }
        return { deleted: result.changes > 0 }
      },
    }),

    list_state_keys: tool({
      description: "List all state keys, optionally filtered by prefix",
      inputSchema: z.object({
        prefix: z.string().optional().describe("Optional prefix to filter keys by"),
      }),
      execute: async ({ prefix }) => {
        let rows: { key: string }[]
        if (prefix) {
          rows = db.prepare("SELECT key FROM agent_state WHERE agent_id = ? AND key LIKE ?").all(agentId, prefix + "%") as { key: string }[]
        } else {
          rows = db.prepare("SELECT key FROM agent_state WHERE agent_id = ?").all(agentId) as { key: string }[]
        }
        return { keys: rows.map(r => r.key) }
      },
    }),

    // ================================================================
    // Session Notepad
    // ================================================================
    read_notepad: tool({
      description: "Read the session notepad content",
      inputSchema: z.object({}),
      execute: async () => {
        const row = db.prepare("SELECT notepad FROM agent_sessions WHERE _id = ?").get(sessionId) as { notepad: string } | undefined
        return { content: row?.notepad ?? "" }
      },
    }),

    write_notepad: tool({
      description: "Replace the entire session notepad content",
      inputSchema: z.object({
        content: z.string().describe("The new notepad content (replaces everything)"),
      }),
      execute: async ({ content }) => {
        db.prepare("UPDATE agent_sessions SET notepad = ?, modified_on = ? WHERE _id = ?")
          .run(content, new Date().toISOString(), sessionId)
        return { ok: true }
      },
    }),

    update_notepad: tool({
      description: "Surgical edit of the session notepad (find_replace, append, prepend, delete)",
      inputSchema: z.object({
        operation: z.enum(["find_replace", "append", "prepend", "delete"]).describe("The type of edit"),
        content: z.string().optional().describe("For append/prepend: text to add. For delete: text to remove."),
        find: z.string().optional().describe("For find_replace: text to find"),
        replace: z.string().optional().describe("For find_replace: replacement text"),
      }),
      execute: async ({ operation, content, find, replace }) => {
        const row = db.prepare("SELECT notepad FROM agent_sessions WHERE _id = ?").get(sessionId) as { notepad: string } | undefined
        if (!row) return { error: "Session not found" }

        let notepad = row.notepad

        switch (operation) {
          case "find_replace":
            if (!find || replace === undefined) return { error: "find and replace are required" }
            if (!notepad.includes(find)) return { error: `Could not find: "${find}"` }
            notepad = notepad.replace(find, replace)
            break
          case "append":
            if (!content) return { error: "content is required" }
            notepad = notepad + content
            break
          case "prepend":
            if (!content) return { error: "content is required" }
            notepad = content + notepad
            break
          case "delete":
            if (!content) return { error: "content is required" }
            if (!notepad.includes(content)) return { error: "Text not found in notepad" }
            notepad = notepad.replace(content, "")
            break
        }

        db.prepare("UPDATE agent_sessions SET notepad = ?, modified_on = ? WHERE _id = ?")
          .run(notepad, new Date().toISOString(), sessionId)
        return { ok: true }
      },
    }),

    // ================================================================
    // User Interaction
    // ================================================================
    ask_user: tool({
      description: "Ask the user a question. Pauses until the user replies.",
      inputSchema: z.object({
        question: z.string().describe("The question to ask"),
        options: z.array(z.string()).optional().describe("Optional list of choices. If provided, renders as buttons instead of free-text input."),
      }),
      // No execute — this is a pausing tool. The SDK stops the loop here.
    }),

    send_message: tool({
      description: "Send a text message that appears in the chat. Does NOT pause the agent loop.",
      inputSchema: z.object({
        text: z.string().describe("Message text (supports markdown)"),
      }),
      execute: async ({ text }) => {
        eventBus.broadcast("session:message", {
          id: sessionId,
          message: { role: "assistant", content: text, source: "send_message" },
        })
        return { ok: true }
      },
    }),

    // ================================================================
    // Task Scoping
    // ================================================================
    begin_task: tool({
      description: "Mark the start of a collapsible task scope. Use for multi-step work to keep context clean.",
      inputSchema: z.object({
        description: z.string().describe("Short description of the task being started"),
      }),
      execute: async ({ description }) => {
        const session = db.prepare("SELECT task_stack, messages FROM agent_sessions WHERE _id = ?").get(sessionId) as SessionRow | undefined
        if (!session) return { error: "Session not found" }

        const stack: TaskScope[] = JSON.parse(session.task_stack)
        const messages = JSON.parse(session.messages)
        const taskId = crypto.randomUUID()
        const depth = stack.length + 1

        if (depth > 4) return { error: "Maximum task nesting depth (4) exceeded" }

        stack.push({ task_id: taskId, description, message_index: messages.length })
        db.prepare("UPDATE agent_sessions SET task_stack = ?, modified_on = ? WHERE _id = ?")
          .run(JSON.stringify(stack), new Date().toISOString(), sessionId)

        return { task_id: taskId, depth }
      },
    }),

    end_task: tool({
      description: "Close the most recent task scope. Everything between begin_task and this is collapsed into the summary.",
      inputSchema: z.object({
        summary: z.string().describe("Summary of what was accomplished. Replaces all intermediate messages in context."),
      }),
      execute: async ({ summary }) => {
        const session = db.prepare("SELECT task_stack FROM agent_sessions WHERE _id = ?").get(sessionId) as SessionRow | undefined
        if (!session) return { error: "Session not found" }

        const stack: TaskScope[] = JSON.parse(session.task_stack)
        if (stack.length === 0) return { error: "No open task scope to end" }

        const scope = stack.pop()!
        db.prepare("UPDATE agent_sessions SET task_stack = ?, modified_on = ? WHERE _id = ?")
          .run(JSON.stringify(stack), new Date().toISOString(), sessionId)

        // Actual message collapsing will be applied when loading messages for the next LLM call.
        // For now, we record the scope end and summary.
        return { ok: true, messages_collapsed: 0, task_id: scope.task_id, summary }
      },
    }),

    cancel_task: tool({
      description: "Discard the most recent task scope. Leaves a one-line cancellation marker.",
      inputSchema: z.object({
        reason: z.string().describe("Short reason for cancellation"),
      }),
      execute: async ({ reason }) => {
        const session = db.prepare("SELECT task_stack FROM agent_sessions WHERE _id = ?").get(sessionId) as SessionRow | undefined
        if (!session) return { error: "Session not found" }

        const stack: TaskScope[] = JSON.parse(session.task_stack)
        if (stack.length === 0) return { error: "No open task scope to cancel" }

        const scope = stack.pop()!
        db.prepare("UPDATE agent_sessions SET task_stack = ?, modified_on = ? WHERE _id = ?")
          .run(JSON.stringify(stack), new Date().toISOString(), sessionId)

        return { ok: true, messages_collapsed: 0, cancelled: true, task_id: scope.task_id, reason }
      },
    }),
  }
}
