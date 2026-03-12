import { Router } from "express"
import type { SessionController } from "../agent/SessionController"

export function createSessionRoutes(controller: SessionController): Router {
  const router = Router()

  // List sessions for an agent
  router.get("/", (req, res) => {
    const agentId = req.query.agent_id as string
    if (!agentId) return res.status(400).json({ error: "agent_id query parameter is required" })
    const sessions = controller.listSessions(agentId)
    res.json(sessions)
  })

  // Get a single session
  router.get("/:id", (req, res) => {
    const session = controller.getSession(req.params.id)
    if (!session) return res.status(404).json({ error: "Session not found" })
    res.json(session)
  })

  // Create a new session
  router.post("/", (req, res) => {
    const { agent_id, title, model } = req.body
    if (!agent_id) return res.status(400).json({ error: "agent_id is required" })
    const session = controller.createSession(agent_id, { title, model })
    res.status(201).json(session)
  })

  // Send a user message (triggers agent loop)
  router.post("/:id/message", async (req, res) => {
    const { content } = req.body
    if (!content) return res.status(400).json({ error: "content is required" })

    try {
      // Respond immediately — the agent runs async, events go via SSE
      res.json({ ok: true })
      await controller.handleUserMessage(req.params.id, content)
    } catch (err: any) {
      console.error("Error handling user message:", err)
      // If we already sent the response, we can't send another error.
      // The error will be emitted via SSE instead.
    }
  })

  // Respond to a pending tool call (e.g., answer ask_user)
  router.post("/:id/tool-response", async (req, res) => {
    const { tool_call_id, result } = req.body
    if (!tool_call_id) return res.status(400).json({ error: "tool_call_id is required" })

    try {
      res.json({ ok: true })
      await controller.handleToolResponse(req.params.id, tool_call_id, result)
    } catch (err: any) {
      console.error("Error handling tool response:", err)
    }
  })

  // Get message history for a session
  router.get("/:id/messages", (req, res) => {
    const session = controller.getSession(req.params.id)
    if (!session) return res.status(404).json({ error: "Session not found" })
    res.json(JSON.parse(session.messages))
  })

  // Delete a session
  router.delete("/:id", (req, res) => {
    const deleted = controller.deleteSession(req.params.id)
    res.json({ deleted })
  })

  return router
}
