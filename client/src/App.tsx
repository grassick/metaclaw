import { useEffect } from "react"
import { useAppStore } from "./stores/sessionStore"
import { api } from "./services/api"
import SessionSidebar from "./components/SessionSidebar"
import ChatPanel from "./components/ChatPanel"
import SettingsPanel from "./components/SettingsPanel"
import FilePreview from "./components/FilePreview"

export default function App() {
  const bootstrapFromStorage = useAppStore((s) => s.bootstrapFromStorage)
  const initSSE = useAppStore((s) => s.initSSE)
  const showSettings = useAppStore((s) => s.showSettings)
  const toggleSettings = useAppStore((s) => s.toggleSettings)
  const previewFile = useAppStore((s) => s.previewFile)
  const agents = useAppStore((s) => s.agents)
  const activeAgentId = useAppStore((s) => s.activeAgentId)
  const setActiveAgent = useAppStore((s) => s.setActiveAgent)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      await bootstrapFromStorage()
      if (cancelled) return
      initSSE()
    })()
    return () => {
      cancelled = true
      useAppStore.getState().sseClient?.disconnect()
    }
  }, [bootstrapFromStorage, initSSE])

  const handleNewAgent = async () => {
    const name = prompt("Agent name:")
    if (!name) return
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
    if (!slug) return
    try {
      await api.createAgent(slug, name)
      await useAppStore.getState().loadAgents()
      setActiveAgent(slug)
    } catch (err) {
      alert(`Failed to create agent: ${err instanceof Error ? err.message : err}`)
    }
  }

  return (
    <div className="d-flex flex-column vh-100">
      {/* Navbar */}
      <nav className="navbar navbar-expand navbar-dark bg-dark px-3 py-2">
        <span className="navbar-brand fw-bold me-4 mb-0">Metaclaw</span>
        <select
          className="form-select form-select-sm bg-dark text-light border-secondary me-2"
          style={{ width: "auto" }}
          value={activeAgentId}
          onChange={(e) => setActiveAgent(e.target.value)}
        >
          {agents.map((a) => (
            <option key={a._id} value={a._id}>
              {a.name}
            </option>
          ))}
        </select>
        <button
          className="btn btn-sm btn-outline-secondary text-light border-secondary me-3"
          onClick={handleNewAgent}
          title="New Agent"
        >
          +
        </button>
        <div className="ms-auto">
          <button
            className="btn btn-sm btn-outline-secondary text-light border-secondary"
            onClick={toggleSettings}
            title="Settings"
          >
            ⚙ Settings
          </button>
        </div>
      </nav>

      {/* Main content */}
      <div className="d-flex flex-grow-1 overflow-hidden">
        <SessionSidebar />
        <main className="flex-grow-1 overflow-hidden">
          <ChatPanel />
        </main>
        {previewFile && <FilePreview />}
      </div>

      {/* Settings drawer */}
      {showSettings && <SettingsPanel onClose={toggleSettings} />}
    </div>
  )
}
