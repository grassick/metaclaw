import { tool } from "ai"
import { z } from "zod"
import type { MetaToolContext } from "../types"

interface LibraryRow {
  _id: string
  agent_id: string
  description: string
  code: string
  version: number
  created_on: string
  modified_on: string
}

const NAME_REGEX = /^[a-z][a-z0-9_]*$/

export function createLibraryManagementTools(ctx: MetaToolContext) {
  const { agentId, db } = ctx

  return {
    create_library: tool({
      description: "Create a shared code library. Tools, functions, and run_sandbox_code load libraries via require('name') in the sandbox. Libraries can require other libraries. Use for reusable utilities, API wrappers, data transformers.",
      inputSchema: z.object({
        name: z.string().describe("Unique library name (snake_case)"),
        description: z.string().describe("What this library provides"),
        code: z.string().describe("CommonJS module code. Export via `exports.foo = ...` or `module.exports = ...`. Can `require()` other libraries."),
      }),
      execute: async ({ name, description, code }) => {
        if (!NAME_REGEX.test(name)) {
          return { error: "Library name must be snake_case (lowercase letters, digits, underscores, starting with a letter)" }
        }

        const existing = db.prepare(
          "SELECT 1 FROM agent_libraries WHERE _id = ? AND agent_id = ?"
        ).get(name, agentId)
        if (existing) return { error: `Library '${name}' already exists. Use update_library to modify it.` }

        const now = new Date().toISOString()
        db.prepare(
          "INSERT INTO agent_libraries (_id, agent_id, description, code, version, created_on, modified_on) VALUES (?, ?, ?, ?, 1, ?, ?)"
        ).run(name, agentId, description, code, now, now)

        return { name, version: 1 }
      },
    }),

    update_library: tool({
      description: "Update an existing library. Only provided fields are changed.",
      inputSchema: z.object({
        name: z.string().describe("Name of the library to update"),
        description: z.string().optional(),
        code: z.string().optional(),
      }),
      execute: async ({ name, description, code }) => {
        const row = db.prepare(
          "SELECT * FROM agent_libraries WHERE _id = ? AND agent_id = ?"
        ).get(name, agentId) as LibraryRow | undefined
        if (!row) return { error: `Library '${name}' not found` }

        const now = new Date().toISOString()
        const newVersion = row.version + 1
        db.prepare(
          "UPDATE agent_libraries SET description = ?, code = ?, version = ?, modified_on = ? WHERE _id = ? AND agent_id = ?"
        ).run(
          description ?? row.description,
          code ?? row.code,
          newVersion,
          now,
          name,
          agentId,
        )

        return { name, version: newVersion }
      },
    }),

    delete_library: tool({
      description: "Delete a library",
      inputSchema: z.object({
        name: z.string().describe("Name of the library to delete"),
      }),
      execute: async ({ name }) => {
        const result = db.prepare(
          "DELETE FROM agent_libraries WHERE _id = ? AND agent_id = ?"
        ).run(name, agentId)
        return { deleted: result.changes > 0 }
      },
    }),

    list_libraries: tool({
      description: "List all libraries",
      inputSchema: z.object({}),
      execute: async () => {
        const rows = db.prepare(
          "SELECT _id, description, version FROM agent_libraries WHERE agent_id = ? ORDER BY _id"
        ).all(agentId) as { _id: string; description: string; version: number }[]
        return {
          libraries: rows.map(r => ({
            name: r._id,
            description: r.description,
            version: r.version,
          })),
        }
      },
    }),

    read_library: tool({
      description: "Read a library's full code",
      inputSchema: z.object({
        name: z.string().describe("Name of the library to read"),
      }),
      execute: async ({ name }) => {
        const row = db.prepare(
          "SELECT * FROM agent_libraries WHERE _id = ? AND agent_id = ?"
        ).get(name, agentId) as LibraryRow | undefined
        if (!row) return { error: `Library '${name}' not found` }
        return {
          name: row._id,
          description: row.description,
          code: row.code,
          version: row.version,
        }
      },
    }),
  }
}
