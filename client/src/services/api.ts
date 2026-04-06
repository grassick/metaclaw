const BASE = "/api"

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return res.json()
}

function post<T>(url: string, body: unknown): Promise<T> {
  return request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function patch<T>(url: string, body: unknown): Promise<T> {
  return request(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function del<T>(url: string): Promise<T> {
  return request(url, { method: "DELETE" })
}

// --- Types matching server rows ---

export interface Agent {
  _id: string
  name: string
  system_prompt: string
  model: string | null
  version: number
  created_on: string
  modified_on: string
}

export interface Session {
  _id: string
  agent_id: string
  title: string | null
  status: string
  pending_tool_calls: string | null
  token_usage: number
  notepad: string
  created_on: string
  modified_on: string
}

export interface StateEntry {
  key: string
  value: unknown
  modified_on: string
}

export interface FileEntry {
  id: string
  path: string
  size: number
  mime_type: string | null
  scope: "session" | "agent"
  session_id: string | null
  source: string
  created_on: string
  modified_on: string
}

// --- API ---

export const api = {
  // Agents
  listAgents: () => request<Agent[]>(`${BASE}/agents`),
  getAgent: (id: string) => request<Agent>(`${BASE}/agents/${id}`),
  updateAgent: (id: string, data: Partial<Pick<Agent, "name" | "model" | "system_prompt">>) =>
    patch<Agent>(`${BASE}/agents/${id}`, data),

  // Sessions
  listSessions: (agentId: string) => request<Session[]>(`${BASE}/sessions?agent_id=${agentId}`),
  getSession: (id: string) => request<Session>(`${BASE}/sessions/${id}`),
  createSession: (agentId: string, title?: string) =>
    post<Session>(`${BASE}/sessions`, { agent_id: agentId, title }),
  deleteSession: (id: string) => del<{ deleted: boolean }>(`${BASE}/sessions/${id}`),
  getMessages: (sessionId: string) => request<unknown[]>(`${BASE}/sessions/${sessionId}/messages`),
  sendMessage: (sessionId: string, content: string) =>
    post<{ ok: boolean }>(`${BASE}/sessions/${sessionId}/message`, { content }),
  sendToolResponse: (sessionId: string, toolCallId: string, result: unknown) =>
    post<{ ok: boolean }>(`${BASE}/sessions/${sessionId}/tool-response`, {
      tool_call_id: toolCallId,
      result,
    }),
  cancelSession: (sessionId: string) =>
    post<{ cancelled: boolean }>(`${BASE}/sessions/${sessionId}/cancel`, {}),

  // State
  listState: (agentId = "default") => request<StateEntry[]>(`${BASE}/state?agent_id=${agentId}`),
  getState: (key: string, agentId = "default") =>
    request<{ value: unknown }>(`${BASE}/state/${encodeURIComponent(key)}?agent_id=${agentId}`),
  setState: (key: string, value: unknown, agentId = "default") =>
    post<{ ok: boolean }>(`${BASE}/state/${encodeURIComponent(key)}?agent_id=${agentId}`, { value }),
  deleteState: (key: string, agentId = "default") =>
    del<{ deleted: boolean }>(`${BASE}/state/${encodeURIComponent(key)}?agent_id=${agentId}`),

  // Files
  listFiles: (agentId = "default", sessionId?: string) => {
    const params = new URLSearchParams({ agent_id: agentId })
    if (sessionId) params.set("session_id", sessionId)
    return request<FileEntry[]>(`${BASE}/files?${params}`)
  },
  uploadFiles: async (files: File[], agentId = "default", sessionId?: string): Promise<FileEntry[]> => {
    const form = new FormData()
    form.set("agent_id", agentId)
    if (sessionId) form.set("session_id", sessionId)
    for (const f of files) form.append("files", f)
    const res = await fetch(`${BASE}/files/upload`, { method: "POST", body: form })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(body.error ?? `HTTP ${res.status}`)
    }
    return res.json()
  },
  getFileDownloadUrl: (id: string) => `${BASE}/files/${id}/download`,
  deleteFile: (id: string) => del<{ deleted: boolean }>(`${BASE}/files/${id}`),
  promoteFile: (id: string) => post<FileEntry>(`${BASE}/files/${id}/promote`, {}),

  // Agents (create)
  createAgent: (id: string, name: string, system_prompt?: string) =>
    post<Agent>(`${BASE}/agents`, { id, name, system_prompt }),
  deleteAgent: (id: string) => del<{ deleted: boolean }>(`${BASE}/agents/${id}`),
}
