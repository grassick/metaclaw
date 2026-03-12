import { tool } from "ai"
import { z } from "zod"
import type { MetaToolContext } from "../types"

const MAX_ROWS = 1000

export function createDatabaseTools(ctx: MetaToolContext) {
  const { agentDb } = ctx

  return {
    db_sql: tool({
      description: "Run any SQL against the agent's database. Auto-detects reads vs writes: SELECT/WITH/EXPLAIN/PRAGMA return rows; everything else returns a change count. The agent database is separate from the app — you can create tables, insert data, and query freely.",
      inputSchema: z.object({
        sql: z.string().describe("SQL to execute"),
        params: z.array(z.any()).optional().describe("Positional bind parameters for ? placeholders"),
      }),
      execute: async ({ sql, params }) => {
        const trimmed = sql.trim().toUpperCase()
        const isRead = trimmed.startsWith("SELECT") || trimmed.startsWith("WITH") || trimmed.startsWith("EXPLAIN") || trimmed.startsWith("PRAGMA")

        if (trimmed.startsWith("ATTACH")) {
          return { error: "ATTACH DATABASE is not allowed" }
        }

        try {
          if (isRead) {
            const stmt = agentDb.prepare(sql)
            let columns: string[]
            try {
              columns = stmt.columns().map(c => c.name)
            } catch {
              columns = []
            }
            const rows = stmt.all(...(params || []))
            if (columns.length === 0 && rows.length > 0) {
              columns = Object.keys(rows[0] as any)
            }
            const truncated = rows.length > MAX_ROWS
            const sliced = rows.slice(0, MAX_ROWS)
            return {
              columns,
              rows: sliced.map(row => columns.map(col => (row as any)[col])),
              row_count: sliced.length,
              truncated,
            }
          } else {
            const result = agentDb.prepare(sql).run(...(params || []))
            return {
              changes: result.changes,
              last_insert_rowid: Number(result.lastInsertRowid),
            }
          }
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) }
        }
      },
    }),

    db_schema: tool({
      description: "List all tables in the agent's database with their column definitions and row counts. Essential for remembering what you've already created.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const tables = agentDb.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
          ).all() as { name: string }[]

          return {
            tables: tables.map(t => {
              const columns = agentDb.prepare(`PRAGMA table_info("${t.name}")`).all() as {
                name: string; type: string; notnull: number; pk: number
              }[]
              const countRow = agentDb.prepare(`SELECT COUNT(*) as cnt FROM "${t.name}"`).get() as { cnt: number }
              return {
                name: t.name,
                columns: columns.map(c => ({
                  name: c.name,
                  type: c.type,
                  notnull: c.notnull === 1,
                  pk: c.pk > 0,
                })),
                row_count: countRow.cnt,
              }
            }),
          }
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) }
        }
      },
    }),
  }
}
