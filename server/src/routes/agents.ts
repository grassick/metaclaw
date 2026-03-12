import { Router } from "express"
import type Database from "better-sqlite3"
import type { AgentRow } from "../agent/types"
import { executeSandbox } from "../sandbox/SandboxHost"

export function createAgentRoutes(db: Database.Database, openRouterApiKey: string): Router {
  const router = Router()

  router.get("/", (_req, res) => {
    const agents = db.prepare("SELECT * FROM agents ORDER BY created_on ASC").all() as AgentRow[]
    res.json(agents)
  })

  router.get("/:id", (req, res) => {
    const agent = db.prepare("SELECT * FROM agents WHERE _id = ?").get(req.params.id) as AgentRow | undefined
    if (!agent) return res.status(404).json({ error: "Agent not found" })
    res.json(agent)
  })

  router.post("/", (req, res) => {
    const { id, name, system_prompt } = req.body
    if (!id || !name) return res.status(400).json({ error: "id and name are required" })

    const now = new Date().toISOString()
    try {
      db.prepare(
        "INSERT INTO agents (_id, name, system_prompt, version, created_on, modified_on) VALUES (?, ?, ?, 1, ?, ?)"
      ).run(id, name, system_prompt ?? "", now, now)
      const agent = db.prepare("SELECT * FROM agents WHERE _id = ?").get(id) as AgentRow
      res.status(201).json(agent)
    } catch (err: any) {
      if (err.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
        return res.status(409).json({ error: "Agent ID already exists" })
      }
      throw err
    }
  })

  router.patch("/:id", (req, res) => {
    const agent = db.prepare("SELECT * FROM agents WHERE _id = ?").get(req.params.id) as AgentRow | undefined
    if (!agent) return res.status(404).json({ error: "Agent not found" })

    const { name, model, system_prompt } = req.body
    const now = new Date().toISOString()

    if (name !== undefined) {
      db.prepare("UPDATE agents SET name = ?, modified_on = ? WHERE _id = ?").run(name, now, req.params.id)
    }
    if (model !== undefined) {
      db.prepare("UPDATE agents SET model = ?, modified_on = ? WHERE _id = ?").run(model, now, req.params.id)
    }
    if (system_prompt !== undefined) {
      db.prepare(
        "INSERT INTO agent_config_history (agent_id, version, system_prompt, created_on) VALUES (?, ?, ?, ?)"
      ).run(req.params.id, agent.version, agent.system_prompt, now)
      db.prepare(
        "UPDATE agents SET system_prompt = ?, version = version + 1, modified_on = ? WHERE _id = ?"
      ).run(system_prompt, now, req.params.id)
    }

    const updated = db.prepare("SELECT * FROM agents WHERE _id = ?").get(req.params.id)
    res.json(updated)
  })

  router.delete("/:id", (req, res) => {
    if (req.params.id === "default") {
      return res.status(400).json({ error: "Cannot delete the default agent" })
    }
    const result = db.prepare("DELETE FROM agents WHERE _id = ?").run(req.params.id)
    res.json({ deleted: result.changes > 0 })
  })

  // ================================================================
  // Function invocation — POST /agents/:agentId/functions/:name/invoke
  // Called by UI components via callBackend(). Bypasses the LLM entirely.
  // ================================================================
  router.post("/:agentId/functions/:name/invoke", async (req, res) => {
    const { agentId, name } = req.params
    const args = req.body ?? {}

    const agent = db.prepare("SELECT 1 FROM agents WHERE _id = ?").get(agentId)
    if (!agent) return res.status(404).json({ error: "Agent not found" })

    const fnRow = db.prepare(
      "SELECT code, parameter_schema, enabled FROM agent_functions WHERE _id = ? AND agent_id = ?"
    ).get(name, agentId) as { code: string; parameter_schema: string; enabled: number } | undefined

    if (!fnRow) return res.status(404).json({ error: `Function '${name}' not found` })
    if (!fnRow.enabled) return res.status(400).json({ error: `Function '${name}' is disabled` })

    try {
      const result = await executeSandbox(fnRow.code, {
        agentId,
        appDb: db,
        openRouterApiKey,
      }, {
        args,
      })

      if (result.success) {
        res.json({ result: result.result, logs: result.logs })
      } else {
        res.status(500).json({ error: result.error, logs: result.logs })
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  return router
}
