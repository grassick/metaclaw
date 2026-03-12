import { useAppStore } from "../stores/sessionStore"

const STATUS_DOTS: Record<string, string> = {
  idle: "text-secondary",
  running: "text-primary",
  waiting_for_input: "text-warning",
  completed: "text-success",
  error: "text-danger",
  token_limit_reached: "text-info",
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  if (diff < 86400000 && d.getDate() === now.getDate()) {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  }
  if (diff < 86400000 * 7) {
    return d.toLocaleDateString(undefined, { weekday: "short" })
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export default function SessionSidebar() {
  const sessions = useAppStore((s) => s.sessions)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const selectSession = useAppStore((s) => s.selectSession)
  const createSession = useAppStore((s) => s.createSession)
  const deleteSession = useAppStore((s) => s.deleteSession)

  return (
    <div className="d-flex flex-column h-100 bg-body-tertiary sidebar">
      <div className="p-2 border-bottom">
        <button className="btn btn-primary btn-sm w-100" onClick={createSession}>
          + New Session
        </button>
      </div>

      <div className="flex-grow-1 overflow-y-auto overflow-x-hidden">
        {sessions.length === 0 && (
          <p className="text-muted small p-3 mb-0">No sessions yet</p>
        )}
        {sessions.map((s) => (
          <div
            key={s._id}
            className={`sidebar-item border-bottom ${s._id === activeSessionId ? "active" : ""}`}
            onClick={() => selectSession(s._id)}
          >
            <span className={`sidebar-dot ${STATUS_DOTS[s.status] ?? "text-secondary"}`}>●</span>
            <div className="sidebar-item-text">
              <div className="sidebar-title small">
                {s.title || "New session"}
              </div>
              <div className="text-muted sidebar-time">
                {formatTime(s.modified_on)}
              </div>
            </div>
            <button
              className="btn btn-sm p-0 text-muted sidebar-delete"
              title="Delete session"
              onClick={(e) => {
                e.stopPropagation()
                if (confirm("Delete this session?")) deleteSession(s._id)
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
