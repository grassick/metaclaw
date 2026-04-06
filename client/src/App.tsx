import { useEffect } from "react"
import { useAppStore } from "./stores/sessionStore"
import SessionSidebar from "./components/SessionSidebar"
import ChatPanel from "./components/ChatPanel"
import SettingsPanel from "./components/SettingsPanel"

export default function App() {
  const loadAgents = useAppStore((s) => s.loadAgents)
  const loadSessions = useAppStore((s) => s.loadSessions)
  const initSSE = useAppStore((s) => s.initSSE)
  const showSettings = useAppStore((s) => s.showSettings)
  const toggleSettings = useAppStore((s) => s.toggleSettings)
  const agents = useAppStore((s) => s.agents)
  const activeAgentId = useAppStore((s) => s.activeAgentId)
  const setActiveAgent = useAppStore((s) => s.setActiveAgent)

  useEffect(() => {
    loadAgents()
    loadSessions()
    initSSE()
    return () => {
      useAppStore.getState().sseClient?.disconnect()
    }
  }, [loadAgents, loadSessions, initSSE])

  return (
    <div className="d-flex flex-column vh-100">
      {/* Navbar */}
      <nav className="navbar navbar-expand navbar-dark bg-dark px-3 py-2">
        <span className="navbar-brand fw-bold me-4 mb-0">Metaclaw</span>
        <select
          className="form-select form-select-sm bg-dark text-light border-secondary me-3"
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
      </div>

      {/* Settings drawer */}
      {showSettings && <SettingsPanel onClose={toggleSettings} />}
    </div>
  )
}
