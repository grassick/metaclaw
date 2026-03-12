import { useRef } from "react"
import { useAppStore } from "../stores/sessionStore"

export default function MessageInput() {
  const sendMessage = useAppStore((s) => s.sendMessage)
  const sessionStatus = useAppStore((s) => s.sessionStatus)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const canSend = activeSessionId && sessionStatus !== "running"

  const handleSend = () => {
    const text = textareaRef.current?.value.trim()
    if (!text || !canSend) return
    sendMessage(text)
    textareaRef.current!.value = ""
    textareaRef.current!.style.height = "auto"
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleInput = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = Math.min(el.scrollHeight, 160) + "px"
  }

  return (
    <div className="border-top p-3">
      <div className="input-group">
        <textarea
          ref={textareaRef}
          className="form-control"
          placeholder={canSend ? "Send a message… (Enter to send, Shift+Enter for newline)" : ""}
          rows={1}
          disabled={!canSend}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          style={{ resize: "none", maxHeight: 160 }}
        />
        <button className="btn btn-primary" onClick={handleSend} disabled={!canSend}>
          Send
        </button>
      </div>
    </div>
  )
}
