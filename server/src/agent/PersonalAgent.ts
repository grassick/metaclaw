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
### Loading external data into the database
When asked to load data from an API or URL into the database:
1. First, fetch a small sample (1-2 records) with run_sandbox_code to discover the actual field names and types
2. Design and CREATE TABLE(s) with columns matching the real data structure
3. Fetch the full dataset and INSERT it — do the fetch + insert together in a single run_sandbox_code call (using db.sql()) so you don't re-transmit large payloads between tool calls

### Sandbox context
Each run_sandbox_code invocation runs in a fresh isolated context. Variables from one call are not available in the next. Plan accordingly.`)

  // 11. Session notepad
  if (session.notepad) {
    parts.push(`\n\n## Session Notepad\n${session.notepad}`)
  }

  return parts.join("\n")
}
