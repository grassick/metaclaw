import { useAppStore } from "../stores/sessionStore"
import MessageList from "./MessageList"
import MessageInput from "./MessageInput"

export default function ChatPanel() {
  const activeSessionId = useAppStore((s) => s.activeSessionId)

  if (!activeSessionId) {
    return (
      <div className="d-flex flex-column align-items-center justify-content-center h-100 text-muted">
        <p className="fs-5 mb-1">No session selected</p>
        <p className="small">Create a new session or select one from the sidebar.</p>
      </div>
    )
  }

  return (
    <div className="d-flex flex-column h-100">
      <MessageList />
      <MessageInput />
    </div>
  )
}
