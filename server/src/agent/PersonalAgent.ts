import type Database from "better-sqlite3"
import type { AgentRow, SessionRow } from "./types"

/**
 * Builds the dynamic system prompt from the agent's configuration and session state.
 * On each call, assembles all 10 components described in Server Design.md.
 */
export function buildSystemPrompt(db: Database.Database, agent: AgentRow, session: SessionRow): string {
  const parts: string[] = []

  // 1. Agent's core system prompt
  parts.push(agent.system_prompt)

  // 2. Current date/time
  parts.push(`\n\n---\nCurrent date/time: ${new Date().toISOString()}`)

  // 3. Summary of available tools
  const tools = db.prepare(
    "SELECT _id, description FROM agent_tools WHERE agent_id = ? AND enabled = 1"
  ).all(agent._id) as { _id: string; description: string }[]
  if (tools.length > 0) {
    parts.push("\n\n## Your Custom Tools")
    for (const t of tools) {
      parts.push(`- **${t._id}**: ${t.description}`)
    }
  }

  // 4. Summary of available functions
  const functions = db.prepare(
    "SELECT _id, description FROM agent_functions WHERE agent_id = ? AND enabled = 1"
  ).all(agent._id) as { _id: string; description: string }[]
  if (functions.length > 0) {
    parts.push("\n\n## Your Backend Functions")
    for (const f of functions) {
      parts.push(`- **${f._id}**: ${f.description}`)
    }
  }

  // 5. Summary of available libraries
  const libraries = db.prepare(
    "SELECT _id, description FROM agent_libraries WHERE agent_id = ?"
  ).all(agent._id) as { _id: string; description: string }[]
  if (libraries.length > 0) {
    parts.push("\n\n## Your Libraries")
    for (const l of libraries) {
      parts.push(`- **${l._id}**: ${l.description}`)
    }
  }

  // 6. Summary of UI components
  const components = db.prepare(
    "SELECT _id, description FROM agent_ui_components WHERE agent_id = ?"
  ).all(agent._id) as { _id: string; description: string }[]
  if (components.length > 0) {
    parts.push("\n\n## Your UI Components")
    for (const c of components) {
      parts.push(`- **${c._id}**: ${c.description}`)
    }
  }

  // 7. Available secret key names (names only, not values)
  const secrets = db.prepare("SELECT _id FROM agent_secrets").all() as { _id: string }[]
  if (secrets.length > 0) {
    parts.push(`\n\n## Available Secrets\nThe following API key names are available via the secrets object: ${secrets.map(s => s._id).join(", ")}`)
  }

  // 8. Summary of skills
  const skills = db.prepare(
    "SELECT _id, title, description, tags FROM agent_skills WHERE agent_id = ? AND enabled = 1"
  ).all(agent._id) as { _id: string; title: string; description: string; tags: string }[]
  if (skills.length > 0) {
    parts.push("\n\n## Your Skills")
    for (const s of skills) {
      const tags = JSON.parse(s.tags) as string[]
      const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : ""
      parts.push(`- **${s.title}** (${s._id}): ${s.description}${tagStr}`)
    }
  }

  // 9. MCP servers (placeholder for Phase 7)
  const mcpServers = db.prepare(
    "SELECT _id, name FROM agent_mcp_servers WHERE agent_id = ? AND enabled = 1"
  ).all(agent._id) as { _id: string; name: string }[]
  if (mcpServers.length > 0) {
    parts.push("\n\n## Connected MCP Servers")
    for (const m of mcpServers) {
      parts.push(`- **${m.name}** (${m._id})`)
    }
  }

  // 10. Built-in guidelines
  parts.push(`\n\n## Guidelines
### Large outputs and reports
When generating substantial output — reports, tables with many rows, summaries, formatted analyses, full documents — **write to a file rather than dumping everything in chat**:
1. Use \`file_create\` with a descriptive path (e.g. \`medical-receipts-summary.md\`, \`analysis/q4-report.csv\`)
2. Use \`file_write_text\` to write the full content
3. In your chat response, give a **brief summary** — key numbers, conclusions, a few highlights. The file card that appears from the \`file_create\` / \`file_write_text\` tool call is clickable and opens a preview panel, so the user can view the full content right there.

Use markdown (.md) for reports and formatted text — the UI renders it with full formatting. Use .csv for tabular data. Use .json for structured data.

"Substantial output" means roughly: more than ~20 lines of formatted content, any table with more than 10 rows, or any content the user will want to save or reference later.

For short answers, quick lookups, or conversational responses, just reply directly in chat.

### Temporary vs. durable data
- Use \`session.scratch\` for temporary structured data needed only during this session (fetched API payloads, parsed CSVs, intermediate results). It persists across sandbox calls but is automatically deleted when the session ends.
- Use the agent database (\`db.sql()\`) for durable records, reusable datasets, or app-backed tables that should survive across sessions.
- Use the session notepad for human-readable plans and findings, not large structured payloads.

### Loading external data
When asked to pull and analyze external data for the current task:
1. Fetch the data with run_sandbox_code and store it in \`session.scratch\`
2. Use subsequent run_sandbox_code calls to query/transform the scratch data as needed

When the data should be kept permanently (e.g. for a UI component or cross-session reference):
1. First, fetch a small sample (1-2 records) with run_sandbox_code to discover the actual field names and types
2. Design and CREATE TABLE(s) with columns matching the real data structure
3. Fetch the full dataset and INSERT it — do the fetch + insert together in a single run_sandbox_code call (using db.sql()) so you don't re-transmit large payloads between tool calls

### Memory and persistence
Everything in a session — your chat history, notepad, scratch data — disappears when the session ends. If you've learned something worth keeping, persist it before the conversation ends:

- **User preferences and observations** → append to your system prompt via \`edit_system_prompt\` (operation: "append"). Keep entries terse, one line each. Examples: "User prefers ISO date format", "Timezone: EST", "Tax filing: married, 2 dependents".
- **Domain knowledge and procedures** → create a skill via \`create_skill\`. Use skills for anything more than a sentence — how something works, step-by-step procedures, reference material.
- **Structured data that should survive across sessions** → store in the agent database (\`db_sql\`).
- **Files worth keeping beyond this session** → promote from session to agent scope via \`promote_file\`.

Don't persist everything — only things that would be useful in future sessions. When in doubt, ask the user: "Should I remember this for next time?"

When the user says "remember this", "save this", or "keep this" — that's an explicit signal to persist the relevant information using the appropriate mechanism above.

### Sandbox context
Each run_sandbox_code invocation runs in a fresh isolated context. Local variables do not persist between calls. Use \`session.scratch\` to carry structured data across calls within the current session.`)

  // 11. Session notepad
  if (session.notepad) {
    parts.push(`\n\n## Session Notepad\n${session.notepad}`)
  }

  return parts.join("\n")
}
