export type SSEHandler = (eventType: string, data: unknown) => void
export type SSEConnectionHandler = (connected: boolean) => void

const SSE_EVENT_TYPES = [
  "session:status",
  "session:stream",
  "session:message",
  "session:tool_call",
  "session:pending_input",
  "sessions:list",
  "state:change",
  "file:created",
  "file:modified",
  "file:deleted",
  "agents:list",
] as const

export class SSEClient {
  private es: EventSource | null = null
  private handler: SSEHandler
  private connectionHandler?: SSEConnectionHandler

  constructor(handler: SSEHandler, connectionHandler?: SSEConnectionHandler) {
    this.handler = handler
    this.connectionHandler = connectionHandler
  }

  connect() {
    if (this.es) return
    console.info("Connecting SSE client to /api/events")
    this.es = new EventSource("/api/events")

    for (const type of SSE_EVENT_TYPES) {
      this.es.addEventListener(type, (e) => {
        try {
          this.handler(type, JSON.parse(e.data))
        } catch {
          // ignore malformed data
        }
      })
    }

    this.es.onopen = () => {
      console.info("SSE connected")
      this.connectionHandler?.(true)
    }

    this.es.onerror = () => {
      console.warn("SSE connection error — EventSource will auto-reconnect")
      this.connectionHandler?.(false)
    }
  }

  disconnect() {
    this.es?.close()
    this.es = null
    this.connectionHandler?.(false)
  }
}
