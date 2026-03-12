import { tool } from "ai"
import { z } from "zod"
import type { MetaToolContext } from "../types"

interface ToolRow {
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

export function createToolManagementTools(ctx: MetaToolContext) {
  const { agentId, db } = ctx

  return {
    create_tool: tool({
      description: "Create a new agent-defined tool that the LLM can call. The tool runs JavaScript in an isolated sandbox with access to state, db, llm, files, functions, require, and more.",
      inputSchema: z.object({
        name: z.string().describe("Unique snake_case tool name"),
        description: z.string().describe("Human-readable description shown in the tool list"),
        parameter_schema: z.record(z.string(), z.any()).describe("JSON Schema defining the tool's parameters"),
        code: z.string().describe("JavaScript code to execute in isolated-vm. Receives `args` (validated params) as a global. Must return a value or call `resolve(value)`."),
      }),
      execute: async ({ name, description, parameter_schema, code }) => {
        if (!NAME_REGEX.test(name)) {
          return { error: "Tool name must be snake_case (lowercase letters, digits, underscores, starting with a letter)" }
        }

        const existing = db.prepare(
          "SELECT 1 FROM agent_tools WHERE _id = ? AND agent_id = ?"
        ).get(name, agentId)
        if (existing) return { error: `Tool '${name}' already exists. Use update_tool to modify it.` }

        const now = new Date().toISOString()
        db.prepare(
          "INSERT INTO agent_tools (_id, agent_id, description, parameter_schema, code, version, enabled, created_on, modified_on) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)"
        ).run(name, agentId, description, JSON.stringify(parameter_schema), code, now, now)

        return { name, version: 1 }
      },
    }),

    update_tool: tool({
      description: "Update an existing agent-defined tool. Only provided fields are changed.",
      inputSchema: z.object({
        name: z.string().describe("Name of the tool to update"),
        description: z.string().optional(),
        parameter_schema: z.record(z.string(), z.any()).optional(),
        code: z.string().optional(),
      }),
      execute: async ({ name, description, parameter_schema, code }) => {
        const row = db.prepare(
          "SELECT * FROM agent_tools WHERE _id = ? AND agent_id = ?"
        ).get(name, agentId) as ToolRow | undefined
        if (!row) return { error: `Tool '${name}' not found` }

        const now = new Date().toISOString()
        const newVersion = row.version + 1
        db.prepare(
          "UPDATE agent_tools SET description = ?, parameter_schema = ?, code = ?, version = ?, modified_on = ? WHERE _id = ? AND agent_id = ?"
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

    delete_tool: tool({
      description: "Delete an agent-defined tool",
      inputSchema: z.object({
        name: z.string().describe("Name of the tool to delete"),
      }),
      execute: async ({ name }) => {
        const result = db.prepare(
          "DELETE FROM agent_tools WHERE _id = ? AND agent_id = ?"
        ).run(name, agentId)
        return { deleted: result.changes > 0 }
      },
    }),

    enable_tool: tool({
      description: "Enable a disabled tool so it appears in the active tool set",
      inputSchema: z.object({
        name: z.string().describe("Name of the tool to enable"),
      }),
      execute: async ({ name }) => {
        const result = db.prepare(
          "UPDATE agent_tools SET enabled = 1, modified_on = ? WHERE _id = ? AND agent_id = ?"
        ).run(new Date().toISOString(), name, agentId)
        if (result.changes === 0) return { error: `Tool '${name}' not found` }
        return { name, enabled: true }
      },
    }),

    disable_tool: tool({
      description: "Disable a tool without deleting it",
      inputSchema: z.object({
        name: z.string().describe("Name of the tool to disable"),
      }),
      execute: async ({ name }) => {
        const result = db.prepare(
          "UPDATE agent_tools SET enabled = 0, modified_on = ? WHERE _id = ? AND agent_id = ?"
        ).run(new Date().toISOString(), name, agentId)
        if (result.changes === 0) return { error: `Tool '${name}' not found` }
        return { name, enabled: false }
      },
    }),

    list_tools: tool({
      description: "List all agent-defined tools",
      inputSchema: z.object({
        include_disabled: z.boolean().optional().describe("Include disabled tools in the list. Default: false."),
      }),
      execute: async ({ include_disabled }) => {
        const query = include_disabled
          ? "SELECT _id, description, enabled, version FROM agent_tools WHERE agent_id = ? ORDER BY _id"
          : "SELECT _id, description, enabled, version FROM agent_tools WHERE agent_id = ? AND enabled = 1 ORDER BY _id"
        const rows = db.prepare(query).all(agentId) as { _id: string; description: string; enabled: number; version: number }[]
        return {
          tools: rows.map(r => ({
            name: r._id,
            description: r.description,
            enabled: r.enabled === 1,
            version: r.version,
          })),
        }
      },
    }),

    read_tool: tool({
      description: "Read a tool's full definition including code and parameter schema",
      inputSchema: z.object({
        name: z.string().describe("Name of the tool to read"),
      }),
      execute: async ({ name }) => {
        const row = db.prepare(
          "SELECT * FROM agent_tools WHERE _id = ? AND agent_id = ?"
        ).get(name, agentId) as ToolRow | undefined
        if (!row) return { error: `Tool '${name}' not found` }
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
