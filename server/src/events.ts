import { EventEmitter } from "node:events"
import type { Response } from "express"

interface SSEClient {
  id: string
  res: Response
  remoteAddress?: string
}

class AppEventBus extends EventEmitter {
  private sseClients = new Set<SSEClient>()

  addSSEClient(client: SSEClient) {
    this.sseClients.add(client)
    console.log(`[sse] client connected id=${client.id} ip=${client.remoteAddress ?? "unknown"} (${this.sseClients.size} total)`)
  }

  removeSSEClient(client: SSEClient) {
    this.sseClients.delete(client)
    console.log(`[sse] client disconnected id=${client.id} ip=${client.remoteAddress ?? "unknown"} (${this.sseClients.size} total)`)
  }

  broadcast(eventType: string, data: unknown) {
    if (eventType !== "session:stream") {
      console.log(`[sse] broadcast ${eventType} to ${this.sseClients.size} clients:`, JSON.stringify(data).slice(0, 200))
    }
    const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of this.sseClients) {
      client.res.write(payload)
    }
  }
}

export const eventBus = new AppEventBus()
