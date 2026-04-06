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

const INITIAL_RETRY_MS = 1000
const MAX_RETRY_MS = 30000

export class SSEClient {
  private es: EventSource | null = null
  private handler: SSEHandler
  private connectionHandler?: SSEConnectionHandler
  private intentionalClose = false
  private retryMs = INITIAL_RETRY_MS
  private retryTimer: ReturnType<typeof setTimeout> | null = null

  constructor(handler: SSEHandler, connectionHandler?: SSEConnectionHandler) {
    this.handler = handler
    this.connectionHandler = connectionHandler
  }

  connect() {
    this.intentionalClose = false
    this.createEventSource()
  }

  disconnect() {
    this.intentionalClose = true
    if (this.retryTimer != null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.es) {
      this.es.close()
      this.es = null
    }
    this.connectionHandler?.(false)
  }

  private createEventSource() {
    if (this.es) {
      this.es.close()
      this.es = null
    }

    const es = new EventSource("/api/events")
    this.es = es

    for (const type of SSE_EVENT_TYPES) {
      es.addEventListener(type, (e) => {
        try {
          this.handler(type, JSON.parse(e.data))
        } catch {
          // ignore malformed data
        }
      })
    }

    es.onopen = () => {
      this.retryMs = INITIAL_RETRY_MS
      this.connectionHandler?.(true)
    }

    es.onerror = () => {
      this.connectionHandler?.(false)

      if (this.intentionalClose) return

      es.close()
      this.es = null

      this.scheduleReconnect()
    }
  }

  private scheduleReconnect() {
    if (this.retryTimer != null) return
    const delay = this.retryMs + Math.random() * 500
    console.warn(`SSE disconnected — reconnecting in ${Math.round(delay)}ms`)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS)
      this.createEventSource()
    }, delay)
  }
}
