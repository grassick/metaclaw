export type SSEHandler = (eventType: string, data: unknown) => void

const SSE_EVENT_TYPES = [
  "session:status",
  "session:stream",
  "session:message",
  "session:tool_call",
  "session:pending_input",
  "sessions:list",
  "state:change",
] as const

export class SSEClient {
  private es: EventSource | null = null
  private handler: SSEHandler

  constructor(handler: SSEHandler) {
    this.handler = handler
  }

  connect() {
    if (this.es) return
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

    this.es.onerror = () => {
      console.warn("SSE connection error — EventSource will auto-reconnect")
    }
  }

  disconnect() {
    this.es?.close()
    this.es = null
  }
}
