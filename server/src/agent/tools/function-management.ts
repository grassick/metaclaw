import { tool } from "ai"
import { z } from "zod"
import type { MetaToolContext } from "../types"

interface FunctionRow {
  _id: string
  agent_id: string
  description: string
  parameter_schema: string
  code: string
  version: number
  enabled: number
  created_on: string
  modified_on: string
}

const NAME_REGEX = /^[a-z][a-z0-9_]*$/

export function createFunctionManagementTools(ctx: MetaToolContext) {
  const { agentId, db } = ctx

  return {
    create_function: tool({
      description: "Create a backend function callable from UI components via callBackend(). Functions run in the sandbox with access to state, db, llm, files, libraries, and secrets — but outside any session context.",
      inputSchema: z.object({
        name: z.string().describe("Unique snake_case function name"),
        description: z.string().describe("What this function does"),
        parameter_schema: z.record(z.string(), z.any()).describe("JSON Schema defining the function's input parameters"),
        code: z.string().describe("JavaScript code to execute in isolated-vm. Receives `args` (validated params) as a global. Must return a value or call `resolve(value)`."),
      }),
      execute: async ({ name, description, parameter_schema, code }) => {
        if (!NAME_REGEX.test(name)) {
          return { error: "Function name must be snake_case (lowercase letters, digits, underscores, starting with a letter)" }
        }

        const existing = db.prepare(
          "SELECT 1 FROM agent_functions WHERE _id = ? AND agent_id = ?"
        ).get(name, agentId)
        if (existing) return { error: `Function '${name}' already exists. Use update_function to modify it.` }

        const now = new Date().toISOString()
        db.prepare(
          "INSERT INTO agent_functions (_id, agent_id, description, parameter_schema, code, version, enabled, created_on, modified_on) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)"
        ).run(name, agentId, description, JSON.stringify(parameter_schema), code, now, now)

        return { name, version: 1 }
      },
    }),

    update_function: tool({
      description: "Update an existing backend function. Only provided fields are changed.",
      inputSchema: z.object({
        name: z.string().describe("Name of the function to update"),
        description: z.string().optional(),
        parameter_schema: z.record(z.string(), z.any()).optional(),
        code: z.string().optional(),
      }),
      execute: async ({ name, description, parameter_schema, code }) => {
        const row = db.prepare(
          "SELECT * FROM agent_functions WHERE _id = ? AND agent_id = ?"
        ).get(name, agentId) as FunctionRow | undefined
        if (!row) return { error: `Function '${name}' not found` }

        const now = new Date().toISOString()
        const newVersion = row.version + 1
        db.prepare(
          "UPDATE agent_functions SET description = ?, parameter_schema = ?, code = ?, version = ?, modified_on = ? WHERE _id = ? AND agent_id = ?"
        ).run(
          description ?? row.description,
          parameter_schema ? JSON.stringify(parameter_schema) : row.parameter_schema,
          code ?? row.code,
          newVersion,
          now,
          name,
          agentId,
        )

        return { name, version: newVersion }
      },
    }),

    delete_function: tool({
      description: "Delete a backend function",
      inputSchema: z.object({
        name: z.string().describe("Name of the function to delete"),
      }),
      execute: async ({ name }) => {
        const result = db.prepare(
          "DELETE FROM agent_functions WHERE _id = ? AND agent_id = ?"
        ).run(name, agentId)
        return { deleted: result.changes > 0 }
      },
    }),

    enable_function: tool({
      description: "Enable a disabled function so it can be called from the frontend",
      inputSchema: z.object({
        name: z.string().describe("Name of the function to enable"),
      }),
      execute: async ({ name }) => {
        const result = db.prepare(
          "UPDATE agent_functions SET enabled = 1, modified_on = ? WHERE _id = ? AND agent_id = ?"
        ).run(new Date().toISOString(), name, agentId)
        if (result.changes === 0) return { error: `Function '${name}' not found` }
        return { name, enabled: true }
      },
    }),

    disable_function: tool({
      description: "Disable a function without deleting it",
      inputSchema: z.object({
        name: z.string().describe("Name of the function to disable"),
      }),
      execute: async ({ name }) => {
        const result = db.prepare(
          "UPDATE agent_functions SET enabled = 0, modified_on = ? WHERE _id = ? AND agent_id = ?"
        ).run(new Date().toISOString(), name, agentId)
        if (result.changes === 0) return { error: `Function '${name}' not found` }
        return { name, enabled: false }
      },
    }),

    list_functions: tool({
      description: "List all backend functions",
      inputSchema: z.object({
        include_disabled: z.boolean().optional().describe("Include disabled functions in the list. Default: false."),
      }),
      execute: async ({ include_disabled }) => {
        const query = include_disabled
          ? "SELECT _id, description, enabled, version FROM agent_functions WHERE agent_id = ? ORDER BY _id"
          : "SELECT _id, description, enabled, version FROM agent_functions WHERE agent_id = ? AND enabled = 1 ORDER BY _id"
        const rows = db.prepare(query).all(agentId) as { _id: string; description: string; enabled: number; version: number }[]
        return {
          functions: rows.map(r => ({
            name: r._id,
            description: r.description,
            enabled: r.enabled === 1,
            version: r.version,
          })),
        }
      },
    }),

    read_function: tool({
      description: "Read a function's full definition including code and parameter schema",
      inputSchema: z.object({
        name: z.string().describe("Name of the function to read"),
      }),
      execute: async ({ name }) => {
        const row = db.prepare(
          "SELECT * FROM agent_functions WHERE _id = ? AND agent_id = ?"
        ).get(name, agentId) as FunctionRow | undefined
        if (!row) return { error: `Function '${name}' not found` }
        return {
          name: row._id,
          description: row.description,
          parameter_schema: JSON.parse(row.parameter_schema),
          code: row.code,
          enabled: row.enabled === 1,
          version: row.version,
        }
      },
    }),
  }
}
