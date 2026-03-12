import { tool } from "ai"
import { z } from "zod"
import { executeSandbox } from "../../sandbox/SandboxHost"
import type { MetaToolContext } from "../types"

export function createCodeExecutionTools(ctx: MetaToolContext) {
  return {
    run_sandbox_code: tool({
      description: "Execute ad-hoc JavaScript in the isolated sandbox. Has the same runtime context as agent-created tools: fetch, state, db, llm, functions, require, session notepad, secrets, parseCSV, btoa/atob. Use for quick exploration, data transformation, or testing logic before committing it to a tool.",
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
