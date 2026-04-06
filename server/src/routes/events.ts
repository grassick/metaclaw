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

    const client = { id: crypto.randomUUID(), res, remoteAddress: req.ip }
    eventBus.addSSEClient(client)

    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n")
    }, 15000)

    req.on("close", () => {
      clearInterval(heartbeat)
      eventBus.removeSSEClient(client)
    })
  })

  return router
}
