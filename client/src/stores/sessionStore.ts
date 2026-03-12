import { create } from "zustand"
import { api, type Agent, type Session } from "../services/api"
import { SSEClient } from "../services/sse"

// ── Display model for streaming ──────────────────────────────────────

export interface StreamSegment {
  type: "text" | "tool-call"
  content?: string
  toolCallId?: string
  name?: string
  args?: unknown
  result?: unknown
  status?: string
}

export interface PendingInput {
  toolCallId: string
  name: string
  question: string
  options?: string[]
}

function getPendingInput(session: Session): PendingInput | null {
  if (session.status !== "waiting_for_input" || !session.pending_tool_calls) return null

  const pending = JSON.parse(session.pending_tool_calls) as Array<{
    toolCallId: string
    toolName: string
    input: { question?: string; options?: string[] }
  }>
  const askCall = pending.find((tc) => tc.toolName === "ask_user")
  if (!askCall) return null

  return {
    toolCallId: askCall.toolCallId,
    name: askCall.toolName,
    question: askCall.input.question ?? "Please respond:",
    options: askCall.input.options,
  }
}

// ── Store shape ──────────────────────────────────────────────────────

interface AppStore {
  // Agents
  agents: Agent[]
  activeAgentId: string
  loadAgents: () => Promise<void>
  setActiveAgent: (id: string) => void

  // Sessions
  sessions: Session[]
  activeSessionId: string | null
  loadSessions: () => Promise<void>
  selectSession: (id: string | null) => Promise<void>
  createSession: () => Promise<void>
  deleteSession: (id: string) => Promise<void>

  // Active session content
  messages: unknown[]
  streamSegments: StreamSegment[]
  pendingInput: PendingInput | null
  sessionStatus: string

  // Actions
  sendMessage: (content: string) => Promise<void>
  respondToInput: (toolCallId: string, result: unknown) => Promise<void>
  cancelSession: () => Promise<void>

  // UI
  showSettings: boolean
  toggleSettings: () => void

  // SSE
  sseClient: SSEClient | null
  sseConnected: boolean
  fallbackPollId: number | null
  initSSE: () => void
  handleSSEEvent: (type: string, data: unknown) => void
  setSSEConnected: (connected: boolean) => void

  // Internal
  _startFallbackPolling: () => void
  _stopFallbackPolling: () => void
  _syncActiveSession: () => Promise<void>
  _refreshMessages: () => Promise<void>
  _refreshSessions: () => Promise<void>
}

// ── Store implementation ─────────────────────────────────────────────

export const useAppStore = create<AppStore>((set, get) => ({
  agents: [],
  activeAgentId: "default",
  sessions: [],
  activeSessionId: null,
  messages: [],
  streamSegments: [],
  pendingInput: null,
  sessionStatus: "idle",
  showSettings: false,
  sseClient: null,
  sseConnected: false,
  fallbackPollId: null,

  // ── Agents ──

  async loadAgents() {
    const agents = await api.listAgents()
    set({ agents })
  },

  setActiveAgent(id: string) {
    set({ activeAgentId: id, activeSessionId: null, messages: [], streamSegments: [], pendingInput: null })
    get().loadSessions()
  },

  // ── Sessions ──

  async loadSessions() {
    const { activeAgentId } = get()
    const sessions = await api.listSessions(activeAgentId)
    set({ sessions })
  },

  async selectSession(id: string | null) {
    if (!id) {
      get()._stopFallbackPolling()
      set({ activeSessionId: null, messages: [], streamSegments: [], pendingInput: null, sessionStatus: "idle" })
      return
    }
    set({ activeSessionId: id, messages: [], streamSegments: [], pendingInput: null })
    try {
      const [messages, session] = await Promise.all([api.getMessages(id), api.getSession(id)])
      const pendingInput = getPendingInput(session)
      set({ messages, sessionStatus: session.status, pendingInput })
      if (session.status === "running") {
        get()._startFallbackPolling()
      } else {
        get()._stopFallbackPolling()
      }
    } catch (err) {
      console.error("Failed to load session:", err)
    }
  },

  async createSession() {
    const { activeAgentId } = get()
    const session = await api.createSession(activeAgentId)
    await get().loadSessions()
    await get().selectSession(session._id)
  },

  async deleteSession(id: string) {
    await api.deleteSession(id)
    if (get().activeSessionId === id) {
      set({ activeSessionId: null, messages: [], streamSegments: [], pendingInput: null, sessionStatus: "idle" })
    }
    await get().loadSessions()
  },

  // ── Messages ──

  async sendMessage(content: string) {
    const { activeSessionId } = get()
    if (!activeSessionId) return

    // Optimistic: add user message locally
    const userMsg = { role: "user", content }
    set((s) => ({
      messages: [...s.messages, userMsg],
      streamSegments: [],
      pendingInput: null,
      sessionStatus: "running",
    }))
    get()._startFallbackPolling()

    await api.sendMessage(activeSessionId, content)
  },

  async respondToInput(toolCallId: string, result: unknown) {
    const { activeSessionId } = get()
    if (!activeSessionId) return

    set({ pendingInput: null, sessionStatus: "running", streamSegments: [] })
    get()._startFallbackPolling()
    await api.sendToolResponse(activeSessionId, toolCallId, result)
  },

  async cancelSession() {
    const { activeSessionId } = get()
    if (!activeSessionId) return
    await api.cancelSession(activeSessionId)
  },

  // ── UI ──

  toggleSettings() {
    set((s) => ({ showSettings: !s.showSettings }))
  },

  // ── SSE ──

  initSSE() {
    // Disconnect existing client to prevent duplicates (React StrictMode double-invokes effects)
    get().sseClient?.disconnect()
    const client = new SSEClient(
      (type, data) => get().handleSSEEvent(type, data),
      (connected) => get().setSSEConnected(connected),
    )
    client.connect()
    set({ sseClient: client })
  },

  setSSEConnected(connected: boolean) {
    const { sseConnected, sessionStatus } = get()
    if (sseConnected === connected) return

    set({ sseConnected: connected })

    if (connected) {
      console.info("SSE connected")
      return
    }

    console.warn("SSE disconnected")
    if (sessionStatus === "running") {
      console.warn("SSE disconnected during active run; polling will keep the session in sync")
      get()._startFallbackPolling()
    }
  },

  handleSSEEvent(type: string, data: unknown) {
    const d = data as Record<string, unknown>
    const { activeSessionId } = get()

    switch (type) {
      case "session:status": {
        if (d.id !== activeSessionId) break
        const status = d.status as string
        set({ sessionStatus: status })
        if (status === "running") {
          get()._startFallbackPolling()
        } else {
          get()._stopFallbackPolling()
        }
        if (status === "idle" || status === "error" || status === "completed" || status === "waiting_for_input") {
          get()._refreshMessages()
        }
        break
      }

      case "session:stream": {
        if (d.id !== activeSessionId) break
        set((s) => {
          const segs = [...s.streamSegments]
          const last = segs[segs.length - 1]
          if (last && last.type === "text") {
            segs[segs.length - 1] = { ...last, content: (last.content ?? "") + (d.delta as string) }
          } else {
            segs.push({ type: "text", content: d.delta as string })
          }
          return { streamSegments: segs }
        })
        break
      }

      case "session:tool_call": {
        if (d.id !== activeSessionId) break
        set((s) => {
          const segs = [...s.streamSegments]
          if (d.status === "running") {
            segs.push({
              type: "tool-call",
              toolCallId: d.tool_call_id as string,
              name: d.name as string,
              args: d.args,
              status: "running",
            })
          } else {
            const idx = segs.findIndex((seg) => seg.toolCallId === d.tool_call_id)
            if (idx >= 0) {
              segs[idx] = { ...segs[idx], result: d.result, status: "complete" }
            }
          }
          return { streamSegments: segs }
        })
        break
      }

      case "session:pending_input": {
        if (d.id !== activeSessionId) break
        const args = d.args as { question?: string; options?: string[] }
        set({
          pendingInput: {
            toolCallId: d.tool_call_id as string,
            name: d.name as string,
            question: args.question ?? "Please respond:",
            options: args.options,
          },
          sessionStatus: "waiting_for_input",
        })
        get()._stopFallbackPolling()
        break
      }

      case "session:message": {
        if (d.id !== activeSessionId) break
        set((s) => ({
          messages: [...s.messages, d.message],
          streamSegments: [],
        }))
        break
      }

      case "sessions:list": {
        get()._refreshSessions()
        break
      }

      case "state:change": {
        // Used by settings panel — it polls or we could dispatch a custom event
        window.dispatchEvent(new CustomEvent("metaclaw:state-change", { detail: d }))
        break
      }
    }
  },

  // ── Internal ──

  _startFallbackPolling() {
    if (get().fallbackPollId != null) return

    const pollId = window.setInterval(() => {
      const { activeSessionId, sessionStatus } = get()
      if (!activeSessionId || sessionStatus !== "running") {
        get()._stopFallbackPolling()
        return
      }

      void get()._syncActiveSession()
    }, 1000)

    set({ fallbackPollId: pollId })
  },

  _stopFallbackPolling() {
    const { fallbackPollId } = get()
    if (fallbackPollId == null) return
    window.clearInterval(fallbackPollId)
    set({ fallbackPollId: null })
  },

  async _syncActiveSession() {
    const { activeSessionId } = get()
    if (!activeSessionId) return

    try {
      const [messages, session] = await Promise.all([
        api.getMessages(activeSessionId),
        api.getSession(activeSessionId),
      ])
      if (get().activeSessionId !== activeSessionId) return

      set({
        messages,
        sessionStatus: session.status,
        pendingInput: getPendingInput(session),
        streamSegments: session.status === "running" ? get().streamSegments : [],
      })

      if (session.status === "running") {
        get()._startFallbackPolling()
      } else {
        get()._stopFallbackPolling()
      }
    } catch {
      // session may have been deleted
    }
  },

  async _refreshMessages() {
    await get()._syncActiveSession()
  },

  async _refreshSessions() {
    try {
      await get().loadSessions()
    } catch {
      // ignore
    }
  },
}))
