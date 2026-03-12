import { tool } from "ai"
import { z } from "zod"
import { executeSandbox } from "../../sandbox/SandboxHost"
import type { MetaToolContext } from "../types"

interface AgentToolRow {
  _id: string
  description: string
  parameter_schema: string
  code: string
}

/**
 * Converts a JSON Schema object to a Zod schema for use with AI SDK tool().
 * Handles common types: string, number, integer, boolean, array, object.
 * Enums and descriptions are preserved so the LLM sees proper parameter info.
 */
function jsonSchemaToZod(schema: any): z.ZodType {
  if (!schema || typeof schema !== "object") return z.any()

  if (schema.enum && schema.type === "string") {
    return z.enum(schema.enum as [string, ...string[]]).describe(schema.description ?? "")
  }

  switch (schema.type) {
    case "string": {
      let s: z.ZodType = z.string()
      if (schema.description) s = s.describe(schema.description)
      return s
    }
    case "number":
    case "integer": {
      let n: z.ZodType = z.number()
      if (schema.description) n = n.describe(schema.description)
      return n
    }
    case "boolean": {
      let b: z.ZodType = z.boolean()
      if (schema.description) b = b.describe(schema.description)
      return b
    }
    case "array":
      return z.array(jsonSchemaToZod(schema.items ?? {}))
    case "object": {
      if (!schema.properties) {
        return z.record(z.string(), z.any())
      }
      const shape: Record<string, z.ZodType> = {}
      const required = new Set<string>(schema.required ?? [])
      for (const [key, prop] of Object.entries(schema.properties)) {
        let zodProp = jsonSchemaToZod(prop as any)
        if (!required.has(key)) {
          zodProp = zodProp.optional()
        }
        shape[key] = zodProp
      }
      return z.object(shape)
    }
    default:
      return z.any()
  }
}

/**
 * Loads agent-created tools from the database and creates Vercel AI SDK tool
 * definitions that execute the tool's code in the sandbox.
 *
 * These appear alongside the built-in meta-tools in the LLM's tool set.
 * Tool creation/update/deletion via meta-tools takes effect on the next LLM call.
 */
export function createDynamicTools(ctx: MetaToolContext) {
  const rows = ctx.db.prepare(
    "SELECT _id, description, parameter_schema, code FROM agent_tools WHERE agent_id = ? AND enabled = 1"
  ).all(ctx.agentId) as AgentToolRow[]

  const tools: Record<string, any> = {}

  for (const row of rows) {
    const schema = JSON.parse(row.parameter_schema)
    const zodSchema = jsonSchemaToZod(schema)
    const toolCode = row.code

    tools[row._id] = tool({
      description: row.description,
      inputSchema: zodSchema as z.ZodObject<any>,
      execute: async (args: any) => {
        const result = await executeSandbox(toolCode, {
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          appDb: ctx.db,
          openRouterApiKey: ctx.openRouterApiKey,
        }, {
          args,
        })

        if (result.success) {
          if (result.logs.length > 0) {
            return { result: result.result, logs: result.logs }
          }
          return result.result
        } else {
          return { error: result.error, logs: result.logs }
        }
      },
    })
  }

  return tools
}
