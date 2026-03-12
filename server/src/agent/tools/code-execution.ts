import { tool } from "ai"
import { z } from "zod"
import { executeSandbox } from "../../sandbox/SandboxHost"
import type { MetaToolContext } from "../types"

export function createCodeExecutionTools(ctx: MetaToolContext) {
  return {
    run_sandbox_code: tool({
      description: "Execute ad-hoc JavaScript in the isolated sandbox. Has the same runtime context as agent-created tools: fetch, state, db, llm, functions, require, session notepad, session scratch, secrets, parseCSV, btoa/atob. Use for quick exploration, data transformation, or testing logic before committing it to a tool. Each invocation runs in a fresh context — local variables do NOT persist between calls, but you can persist structured data across calls using session.scratch (key-value, session-scoped, auto-deleted when the session ends). Use session.scratch for temporary working data; use db.sql() for durable data that should survive across sessions.",
      inputSchema: z.object({
        code: z.string().describe("JavaScript code to execute. Must return a value or call `resolve(value)`."),
      }),
      execute: async ({ code }) => {
        const result = await executeSandbox(code, {
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          appDb: ctx.db,
          openRouterApiKey: ctx.openRouterApiKey,
        })

        if (result.success) {
          return { result: result.result, logs: result.logs }
        } else {
          return { error: result.error, logs: result.logs }
        }
      },
    }),
  }
}
