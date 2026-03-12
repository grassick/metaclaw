import { Router } from "express"
import type Database from "better-sqlite3"
import type { AgentRow } from "../agent/types"

export function createAgentRoutes(db: Database.Database): Router {
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

    const { name, model } = req.body
    const now = new Date().toISOString()

    if (name !== undefined) {
      db.prepare("UPDATE agents SET name = ?, modified_on = ? WHERE _id = ?").run(name, now, req.params.id)
    }
    if (model !== undefined) {
      db.prepare("UPDATE agents SET model = ?, modified_on = ? WHERE _id = ?").run(model, now, req.params.id)
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

  return router
}
