import { Router } from "express"
import { eventBus } from "../events"

export function createEventRoutes(): Router {
  const router = Router()

  router.get("/", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    })
    res.write("\n")

    const client = { id: crypto.randomUUID(), res }
    eventBus.addSSEClient(client)

    // Send a heartbeat every 30s to keep the connection alive
    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n")
    }, 30000)

    req.on("close", () => {
      clearInterval(heartbeat)
      eventBus.removeSSEClient(client)
    })
  })

  return router
}
