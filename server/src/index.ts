import express from "express"
import { getAppDb } from "./db/init"
import { SessionController } from "./agent/SessionController"
import { createAgentRoutes } from "./routes/agents"
import { createSessionRoutes } from "./routes/sessions"
import { createEventRoutes } from "./routes/events"

const PORT = process.env.PORT ?? 3001
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY

if (!OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY environment variable is required")
  process.exit(1)
}

const app = express()
app.use(express.json({ limit: "10mb" }))

// Initialize database
const db = getAppDb()
console.log("Database initialized")

// Initialize session controller
const sessionController = new SessionController(db, OPENROUTER_API_KEY)

// Routes
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() })
})

app.use("/api/agents", createAgentRoutes(db, OPENROUTER_API_KEY))
app.use("/api/sessions", createSessionRoutes(sessionController))
app.use("/api/events", createEventRoutes())

// State endpoints for frontend useAgentState hook
app.get("/api/state", (req, res) => {
  const agentId = (req.query.agent_id as string) ?? "default"
  const rows = db.prepare("SELECT key, value, modified_on FROM agent_state WHERE agent_id = ? ORDER BY key").all(agentId) as { key: string; value: string; modified_on: string }[]
  res.json(rows.map(r => ({ key: r.key, value: JSON.parse(r.value), modified_on: r.modified_on })))
})

app.get("/api/state/:key", (req, res) => {
  const agentId = (req.query.agent_id as string) ?? "default"
  const row = db.prepare("SELECT value FROM agent_state WHERE agent_id = ? AND key = ?").get(agentId, req.params.key) as { value: string } | undefined
  res.json({ value: row ? JSON.parse(row.value) : null })
})

app.post("/api/state/:key", (req, res) => {
  const agentId = (req.query.agent_id as string) ?? "default"
  const { value } = req.body
  const now = new Date().toISOString()
  db.prepare(
    "INSERT INTO agent_state (agent_id, key, value, modified_on) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id, key) DO UPDATE SET value = ?, modified_on = ?"
  ).run(agentId, req.params.key, JSON.stringify(value), now, JSON.stringify(value), now)
  res.json({ ok: true })
})

app.delete("/api/state/:key", (req, res) => {
  const agentId = (req.query.agent_id as string) ?? "default"
  const result = db.prepare("DELETE FROM agent_state WHERE agent_id = ? AND key = ?").run(agentId, req.params.key)
  res.json({ deleted: result.changes > 0 })
})

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})
