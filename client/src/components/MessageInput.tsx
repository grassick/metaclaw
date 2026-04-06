import { useRef, useState, useEffect, useCallback } from "react"
import { useAppStore } from "../stores/sessionStore"

export default function MessageInput() {
  const sendMessage = useAppStore((s) => s.sendMessage)
  const cancelSession = useAppStore((s) => s.cancelSession)
  const sessionStatus = useAppStore((s) => s.sessionStatus)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const pendingAttachments = useAppStore((s) => s.pendingAttachments)
  const uploadFiles = useAppStore((s) => s.uploadFiles)
  const removeAttachment = useAppStore((s) => s.removeAttachment)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [showDropdown, setShowDropdown] = useState(false)

  const isRunning = sessionStatus === "running"
  const canSend = activeSessionId && !isRunning

  const closeDropdown = useCallback(() => setShowDropdown(false), [])

  useEffect(() => {
    if (!showDropdown) return
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        closeDropdown()
      }
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [showDropdown, closeDropdown])

  const handleSend = () => {
    const text = textareaRef.current?.value.trim()
    if ((!text && pendingAttachments.length === 0) || !canSend) return
    sendMessage(text || "(files attached)")
    textareaRef.current!.value = ""
    textareaRef.current!.style.height = "auto"
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
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

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    uploadFiles(Array.from(files))
    e.target.value = ""
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0 && canSend) uploadFiles(files)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
  }

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }

  return (
    <div className="border-top p-3" onDrop={handleDrop} onDragOver={handleDragOver}>
      {pendingAttachments.length > 0 && (
        <div className="d-flex flex-wrap gap-1 mb-2">
          {pendingAttachments.map((f) => (
            <span key={f.id} className="badge bg-secondary d-flex align-items-center gap-1">
              {f.path} ({formatSize(f.size)})
              <button
                type="button"
                className="btn-close btn-close-white"
                style={{ fontSize: "0.6em" }}
                onClick={() => removeAttachment(f.id)}
              />
            </span>
          ))}
        </div>
      )}
      <div className="input-group">
        <div className="btn-group" ref={dropdownRef} style={{ position: "relative" }}>
          <button
            className="btn btn-outline-secondary"
            onClick={() => fileInputRef.current?.click()}
            disabled={!canSend}
            title="Attach files"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4.5 3a2.5 2.5 0 0 1 5 0v9a1.5 1.5 0 0 1-3 0V5a.5.5 0 0 1 1 0v7a.5.5 0 0 0 1 0V3a1.5 1.5 0 1 0-3 0v9a2.5 2.5 0 0 0 5 0V5a.5.5 0 0 1 1 0v7a3.5 3.5 0 1 1-7 0V3z"/>
            </svg>
          </button>
          <button
            className="btn btn-outline-secondary dropdown-toggle dropdown-toggle-split"
            disabled={!canSend}
            onClick={() => setShowDropdown(v => !v)}
          >
            <span className="visually-hidden">Toggle Dropdown</span>
          </button>
          {showDropdown && (
            <ul className="dropdown-menu show" style={{ position: "absolute", bottom: "100%", left: 0 }}>
              <li><button className="dropdown-item" onClick={() => { fileInputRef.current?.click(); closeDropdown() }}>Files</button></li>
              <li><button className="dropdown-item" onClick={() => { folderInputRef.current?.click(); closeDropdown() }}>Folder</button></li>
            </ul>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="d-none"
          onChange={handleFileSelect}
        />
        <input
          ref={folderInputRef}
          type="file"
          // @ts-ignore webkitdirectory is not in React's type defs
          webkitdirectory=""
          className="d-none"
          onChange={handleFileSelect}
        />
        <textarea
          ref={textareaRef}
          className="form-control"
          placeholder={canSend ? "Send a message… (Ctrl+Enter to send)" : ""}
          rows={1}
          disabled={!canSend}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          style={{ resize: "none", maxHeight: 160 }}
        />
        {isRunning && activeSessionId ? (
          <button className="btn btn-outline-danger btn-cancel" onClick={cancelSession}>
            Stop
          </button>
        ) : (
          <button className="btn btn-primary" onClick={handleSend} disabled={!canSend}>
            Send
          </button>
        )}
      </div>
    </div>
  )
}
