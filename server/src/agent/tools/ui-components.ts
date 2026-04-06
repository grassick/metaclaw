import { tool } from "ai"
import { z } from "zod"
import type { MetaToolContext } from "../types"

interface UIComponentRow {
  _id: string
  agent_id: string
  description: string
  code: string
  props_schema: string | null
  version: number
  created_on: string
  modified_on: string
}

const NAME_REGEX = /^[a-z][a-z0-9_]*$/

export function createUIComponentTools(ctx: MetaToolContext) {
  const { agentId, db } = ctx

  return {
    create_ui_component: tool({
      description: "Create a reusable React component stored in agent_ui_components. The component receives injected deps (React, hooks, UI primitives, useAgentState, callTool, sendMessage, importModule). Must export default the component.",
      inputSchema: z.object({
        name: z.string().describe("Unique component name (snake_case)"),
        description: z.string().describe("What this component does"),
        code: z.string().describe("React/JSX component code"),
        props_schema: z.record(z.string(), z.any()).optional().describe("Optional JSON Schema for expected props"),
      }),
      execute: async ({ name, description, code, props_schema }) => {
        if (!NAME_REGEX.test(name)) {
          return { error: "Component name must be snake_case" }
        }

        const existing = db.prepare(
          "SELECT 1 FROM agent_ui_components WHERE _id = ? AND agent_id = ?"
        ).get(name, agentId)
        if (existing) return { error: `Component '${name}' already exists. Use update_ui_component.` }

        const now = new Date().toISOString()
        db.prepare(
          "INSERT INTO agent_ui_components (_id, agent_id, description, code, props_schema, version, created_on, modified_on) VALUES (?, ?, ?, ?, ?, 1, ?, ?)"
        ).run(name, agentId, description, code, props_schema ? JSON.stringify(props_schema) : null, now, now)

        return { name, version: 1 }
      },
    }),

    update_ui_component: tool({
      description: "Update an existing UI component. Only provided fields are changed.",
      inputSchema: z.object({
        name: z.string().describe("Name of the component to update"),
        description: z.string().optional(),
        code: z.string().optional(),
        props_schema: z.record(z.string(), z.any()).optional(),
      }),
      execute: async ({ name, description, code, props_schema }) => {
        const row = db.prepare(
          "SELECT * FROM agent_ui_components WHERE _id = ? AND agent_id = ?"
        ).get(name, agentId) as UIComponentRow | undefined
        if (!row) return { error: `Component '${name}' not found` }

        const now = new Date().toISOString()
        const newVersion = row.version + 1
        db.prepare(
          "UPDATE agent_ui_components SET description = ?, code = ?, props_schema = ?, version = ?, modified_on = ? WHERE _id = ? AND agent_id = ?"
        ).run(
          description ?? row.description,
          code ?? row.code,
          props_schema ? JSON.stringify(props_schema) : row.props_schema,
          newVersion, now, name, agentId,
        )

        return { name, version: newVersion }
      },
    }),

    delete_ui_component: tool({
      description: "Delete a UI component",
      inputSchema: z.object({
        name: z.string().describe("Name of the component to delete"),
      }),
      execute: async ({ name }) => {
        const result = db.prepare(
          "DELETE FROM agent_ui_components WHERE _id = ? AND agent_id = ?"
        ).run(name, agentId)
        return { deleted: result.changes > 0 }
      },
    }),

    list_ui_components: tool({
      description: "List all stored UI components",
      inputSchema: z.object({}),
      execute: async () => {
        const rows = db.prepare(
          "SELECT _id, description, version FROM agent_ui_components WHERE agent_id = ? ORDER BY _id"
        ).all(agentId) as { _id: string; description: string; version: number }[]
        return {
          components: rows.map(r => ({
            name: r._id, description: r.description, version: r.version,
          })),
        }
      },
    }),

    read_ui_component: tool({
      description: "Read a component's full definition including code and props schema",
      inputSchema: z.object({
        name: z.string().describe("Name of the component to read"),
      }),
      execute: async ({ name }) => {
        const row = db.prepare(
          "SELECT * FROM agent_ui_components WHERE _id = ? AND agent_id = ?"
        ).get(name, agentId) as UIComponentRow | undefined
        if (!row) return { error: `Component '${name}' not found` }
        return {
          name: row._id,
          description: row.description,
          code: row.code,
          props_schema: row.props_schema ? JSON.parse(row.props_schema) : null,
          version: row.version,
        }
      },
    }),
  }
}
