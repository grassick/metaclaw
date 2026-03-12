import { EventEmitter } from "node:events"
import type { Response } from "express"

interface SSEClient {
  id: string
  res: Response
}

class AppEventBus extends EventEmitter {
  private sseClients = new Set<SSEClient>()

  addSSEClient(client: SSEClient) {
    this.sseClients.add(client)
  }

  removeSSEClient(client: SSEClient) {
    this.sseClients.delete(client)
  }

  broadcast(eventType: string, data: unknown) {
    const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of this.sseClients) {
      client.res.write(payload)
    }
  }
}

export const eventBus = new AppEventBus()
