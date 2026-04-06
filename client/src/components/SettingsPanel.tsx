import { useState, useEffect, useCallback } from "react"
import { useAppStore } from "../stores/sessionStore"
import { api, type StateEntry, type FileEntry } from "../services/api"

// ── System Prompt Tab ────────────────────────────────────────────────

function SystemPromptEditor() {
  const activeAgentId = useAppStore((s) => s.activeAgentId)
  const [prompt, setPrompt] = useState("")
  const [version, setVersion] = useState(0)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState("")

  useEffect(() => {
    api.getAgent(activeAgentId).then((agent) => {
      setPrompt(agent.system_prompt)
      setVersion(agent.version)
    })
  }, [activeAgentId])

  const startEdit = () => {
    setDraft(prompt)
    setEditing(true)
  }

  const save = async () => {
    setSaving(true)
    try {
      const updated = await api.updateAgent(activeAgentId, { system_prompt: draft })
      setPrompt(updated.system_prompt)
      setVersion(updated.version)
      setEditing(false)
    } catch (err) {
      alert(`Failed to save: ${err instanceof Error ? err.message : err}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-2">
        <h6 className="mb-0">System Prompt</h6>
        <span className="badge text-bg-secondary">v{version}</span>
      </div>
      {editing ? (
        <>
          <textarea
            className="form-control font-monospace small"
            rows={16}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="mt-2 d-flex gap-2">
            <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button className="btn btn-outline-secondary btn-sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <pre className="bg-body-secondary rounded p-3 small" style={{ whiteSpace: "pre-wrap", maxHeight: 400, overflow: "auto" }}>
            {prompt || <span className="text-muted fst-italic">Empty</span>}
          </pre>
          <button className="btn btn-outline-primary btn-sm" onClick={startEdit}>
            Edit
          </button>
        </>
      )}
    </div>
  )
}

// ── State Viewer Tab ─────────────────────────────────────────────────

function StateViewer() {
  const activeAgentId = useAppStore((s) => s.activeAgentId)
  const [entries, setEntries] = useState<StateEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [newKey, setNewKey] = useState("")
  const [newValue, setNewValue] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.listState(activeAgentId)
      setEntries(data)
    } finally {
      setLoading(false)
    }
  }, [activeAgentId])

  useEffect(() => {
    load()

    // Refresh on state changes from SSE
    const handler = () => load()
    window.addEventListener("metaclaw:state-change", handler)
    return () => window.removeEventListener("metaclaw:state-change", handler)
  }, [load])

  const addEntry = async () => {
    if (!newKey.trim()) return
    let parsed: unknown
    try {
      parsed = JSON.parse(newValue)
    } catch {
      parsed = newValue
    }
    await api.setState(newKey.trim(), parsed, activeAgentId)
    setNewKey("")
    setNewValue("")
    load()
  }

  const deleteEntry = async (key: string) => {
    await api.deleteState(key, activeAgentId)
    load()
  }

  return (
    <div>
      <h6>Agent State</h6>
      {loading ? (
        <div className="text-muted small">Loading…</div>
      ) : entries.length === 0 ? (
        <p className="text-muted small">No state entries.</p>
      ) : (
        <table className="table table-sm small">
          <thead>
            <tr>
              <th>Key</th>
              <th>Value</th>
              <th style={{ width: 40 }}></th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.key}>
                <td className="font-monospace">{e.key}</td>
                <td className="font-monospace text-truncate" style={{ maxWidth: 300 }}>
                  {typeof e.value === "string" ? e.value : JSON.stringify(e.value)}
                </td>
                <td>
                  <button
                    className="btn btn-sm p-0 text-danger"
                    title="Delete"
                    onClick={() => deleteEntry(e.key)}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="mt-3">
        <div className="row g-2">
          <div className="col-4">
            <input
              className="form-control form-control-sm font-monospace"
              placeholder="Key"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
            />
          </div>
          <div className="col">
            <input
              className="form-control form-control-sm font-monospace"
              placeholder='Value (JSON or string)'
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addEntry()}
            />
          </div>
          <div className="col-auto">
            <button className="btn btn-outline-primary btn-sm" onClick={addEntry}>
              Add
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── File Browser Tab ─────────────────────────────────────────────────

function FileBrowser() {
  const activeAgentId = useAppStore((s) => s.activeAgentId)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const openFilePreview = useAppStore((s) => s.openFilePreview)
  const [files, setFiles] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.listFiles(activeAgentId, activeSessionId ?? undefined)
      setFiles(data)
    } finally {
      setLoading(false)
    }
  }, [activeAgentId, activeSessionId])

  useEffect(() => {
    load()
    const handler = () => load()
    window.addEventListener("metaclaw:file-change", handler)
    return () => window.removeEventListener("metaclaw:file-change", handler)
  }, [load])

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }

  const handleDelete = async (id: string) => {
    await api.deleteFile(id)
    load()
  }

  const handlePromote = async (id: string) => {
    await api.promoteFile(id)
    load()
  }

  return (
    <div>
      <h6>Files</h6>
      {loading ? (
        <div className="text-muted small">Loading...</div>
      ) : files.length === 0 ? (
        <p className="text-muted small">No files.</p>
      ) : (
        <table className="table table-sm small">
          <thead>
            <tr>
              <th>Path</th>
              <th>Size</th>
              <th>Scope</th>
              <th>Type</th>
              <th style={{ width: 80 }}></th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.id}>
                <td className="font-monospace">
                  <a
                    href="#"
                    onClick={(e) => { e.preventDefault(); openFilePreview(f.id, f.path, f.mime_type) }}
                    title="Open preview"
                  >
                    {f.path}
                  </a>
                </td>
                <td>{formatSize(f.size)}</td>
                <td>
                  <span className={`badge ${f.scope === "agent" ? "text-bg-primary" : "text-bg-secondary"}`}>
                    {f.scope}
                  </span>
                </td>
                <td className="text-muted">{f.mime_type}</td>
                <td>
                  <div className="d-flex gap-1">
                    {f.scope === "session" && (
                      <button
                        className="btn btn-sm p-0 text-primary"
                        title="Promote to agent scope"
                        onClick={() => handlePromote(f.id)}
                      >
                        ^
                      </button>
                    )}
                    <button
                      className="btn btn-sm p-0 text-danger"
                      title="Delete"
                      onClick={() => handleDelete(f.id)}
                    >
                      x
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ── Main SettingsPanel ───────────────────────────────────────────────

type Tab = "prompt" | "state" | "files"

export default function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("files")

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="d-flex justify-content-between align-items-center border-bottom p-3">
          <h5 className="mb-0">Settings</h5>
          <button className="btn-close" onClick={onClose} />
        </div>

        <ul className="nav nav-tabs px-3 pt-2">
          <li className="nav-item">
            <button
              className={`nav-link ${tab === "files" ? "active" : ""}`}
              onClick={() => setTab("files")}
            >
              Files
            </button>
          </li>
          <li className="nav-item">
            <button
              className={`nav-link ${tab === "prompt" ? "active" : ""}`}
              onClick={() => setTab("prompt")}
            >
              System Prompt
            </button>
          </li>
          <li className="nav-item">
            <button
              className={`nav-link ${tab === "state" ? "active" : ""}`}
              onClick={() => setTab("state")}
            >
              State
            </button>
          </li>
        </ul>

        <div className="p-3 flex-grow-1 overflow-auto">
          {tab === "files" && <FileBrowser />}
          {tab === "prompt" && <SystemPromptEditor />}
          {tab === "state" && <StateViewer />}
        </div>
      </div>
    </div>
  )
}
