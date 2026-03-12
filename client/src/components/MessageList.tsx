import { useEffect, useRef } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { useAppStore, type StreamSegment, type PendingInput } from "../stores/sessionStore"

// ── Message parsing ──────────────────────────────────────────────────

interface DisplayItem {
  key: string
  type: "user" | "assistant-text" | "tool-call"
  content?: string
  toolCallId?: string
  toolName?: string
  args?: unknown
  result?: unknown
}

function parseMessages(messages: unknown[]): DisplayItem[] {
  const items: DisplayItem[] = []
  const toolResults = new Map<string, unknown>()

  // Pre-scan for tool results so we can attach them to their calls
  for (const msg of messages) {
    const m = msg as Record<string, unknown>
    if (m.role === "tool" && Array.isArray(m.content)) {
      for (const part of m.content) {
        const p = part as Record<string, unknown>
        if (p.type === "tool-result") {
          toolResults.set(p.toolCallId as string, p.result ?? p.output)
        }
      }
    }
  }

  let idx = 0
  for (const msg of messages) {
    const m = msg as Record<string, unknown>

    if (m.role === "user") {
      items.push({ key: `msg-${idx}`, type: "user", content: m.content as string })
    } else if (m.role === "assistant") {
      if (typeof m.content === "string") {
        if (m.content) items.push({ key: `msg-${idx}`, type: "assistant-text", content: m.content })
      } else if (Array.isArray(m.content)) {
        let partIdx = 0
        for (const part of m.content) {
          const p = part as Record<string, unknown>
          if (p.type === "text" && (p.text as string)) {
            items.push({ key: `msg-${idx}-${partIdx}`, type: "assistant-text", content: p.text as string })
          } else if (p.type === "tool-call") {
            const tcId = (p.toolCallId ?? p.id) as string
            items.push({
              key: `msg-${idx}-${partIdx}`,
              type: "tool-call",
              toolCallId: tcId,
              toolName: (p.toolName ?? p.name) as string,
              args: p.args ?? p.input,
              result: toolResults.get(tcId),
            })
          }
          partIdx++
        }
      }
    }
    // skip role=tool since we pre-scanned them
    idx++
  }

  return items
}

// ── Sub-components ───────────────────────────────────────────────────

function UserMessage({ content }: { content: string }) {
  return (
    <div className="d-flex justify-content-end mb-3">
      <div className="bg-primary text-white rounded-3 px-3 py-2" style={{ maxWidth: "80%" }}>
        <div style={{ whiteSpace: "pre-wrap" }}>{content}</div>
      </div>
    </div>
  )
}

function AssistantText({ content, streaming }: { content: string; streaming?: boolean }) {
  return (
    <div className="mb-3" style={{ maxWidth: "90%" }}>
      <div className="assistant-message">
        <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
        {streaming && <span className="streaming-cursor">▊</span>}
      </div>
    </div>
  )
}

function ToolCallBlock({ item }: { item: DisplayItem }) {
  const isComplete = item.result !== undefined
  return (
    <div className="mb-2 ms-2">
      <details className="tool-call-block">
        <summary className="d-flex align-items-center gap-2 py-1 px-2 small">
          {isComplete ? (
            <span className="text-success">✓</span>
          ) : (
            <span className="spinner-border spinner-border-sm text-primary" />
          )}
          <code className="text-muted">{item.toolName}</code>
        </summary>
        <div className="px-2 pb-2 small">
          {item.args != null && (
            <div className="mb-1">
              <span className="text-muted">Args: </span>
              <code className="d-block bg-body-secondary rounded p-1 mt-1" style={{ whiteSpace: "pre-wrap", fontSize: "0.75rem" }}>
                {JSON.stringify(item.args, null, 2)}
              </code>
            </div>
          )}
          {isComplete && (
            <div>
              <span className="text-muted">Result: </span>
              <code className="d-block bg-body-secondary rounded p-1 mt-1" style={{ whiteSpace: "pre-wrap", fontSize: "0.75rem" }}>
                {typeof item.result === "string" ? item.result : JSON.stringify(item.result, null, 2)}
              </code>
            </div>
          )}
        </div>
      </details>
    </div>
  )
}

function StreamingSegments({ segments }: { segments: StreamSegment[] }) {
  return (
    <>
      {segments.map((seg, i) =>
        seg.type === "text" ? (
          <AssistantText key={`stream-${i}`} content={seg.content ?? ""} streaming={i === segments.length - 1} />
        ) : (
          <div key={`stream-${i}`} className="mb-2 ms-2">
            <div className="tool-call-block">
              <div className="d-flex align-items-center gap-2 py-1 px-2 small">
                {seg.status === "complete" ? (
                  <span className="text-success">✓</span>
                ) : (
                  <span className="spinner-border spinner-border-sm text-primary" />
                )}
                <code className="text-muted">{seg.name}</code>
              </div>
            </div>
          </div>
        ),
      )}
    </>
  )
}

function AskUserBlock({ pending }: { pending: PendingInput }) {
  const respondToInput = useAppStore((s) => s.respondToInput)

  if (pending.options && pending.options.length > 0) {
    return (
      <div className="ask-user-block mb-3">
        <div className="mb-2">{pending.question}</div>
        <div className="d-flex flex-wrap gap-2">
          {pending.options.map((opt) => (
            <button
              key={opt}
              className="btn btn-outline-primary btn-sm"
              onClick={() => respondToInput(pending.toolCallId, { answer: opt })}
            >
              {opt}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return <AskUserFreeText pending={pending} />
}

function AskUserFreeText({ pending }: { pending: PendingInput }) {
  const respondToInput = useAppStore((s) => s.respondToInput)
  const inputRef = useRef<HTMLInputElement>(null)

  const submit = () => {
    const val = inputRef.current?.value.trim()
    if (!val) return
    respondToInput(pending.toolCallId, { answer: val })
  }

  return (
    <div className="ask-user-block mb-3">
      <div className="mb-2">{pending.question}</div>
      <div className="input-group input-group-sm">
        <input
          ref={inputRef}
          type="text"
          className="form-control"
          placeholder="Type your answer…"
          onKeyDown={(e) => e.key === "Enter" && submit()}
          autoFocus
        />
        <button className="btn btn-primary" onClick={submit}>
          Send
        </button>
      </div>
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────────

export default function MessageList() {
  const messages = useAppStore((s) => s.messages)
  const streamSegments = useAppStore((s) => s.streamSegments)
  const pendingInput = useAppStore((s) => s.pendingInput)
  const sessionStatus = useAppStore((s) => s.sessionStatus)

  const containerRef = useRef<HTMLDivElement>(null)
  const isNearBottom = useRef(true)

  const displayItems = parseMessages(messages)

  // Auto-scroll when near bottom
  useEffect(() => {
    if (isNearBottom.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [displayItems.length, streamSegments, pendingInput])

  const handleScroll = () => {
    const el = containerRef.current
    if (!el) return
    isNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  return (
    <div ref={containerRef} className="flex-grow-1 overflow-auto p-3" onScroll={handleScroll}>
      {displayItems.length === 0 && streamSegments.length === 0 && (
        <div className="text-center text-muted mt-5">
          <p className="fs-5">Start a conversation</p>
          <p className="small">Send a message to begin.</p>
        </div>
      )}

      {displayItems.map((item) => {
        switch (item.type) {
          case "user":
            return <UserMessage key={item.key} content={item.content!} />
          case "assistant-text":
            return <AssistantText key={item.key} content={item.content!} />
          case "tool-call":
            return <ToolCallBlock key={item.key} item={item} />
        }
      })}

      {streamSegments.length > 0 && <StreamingSegments segments={streamSegments} />}

      {pendingInput && <AskUserBlock pending={pendingInput} />}

      {sessionStatus === "running" && streamSegments.length === 0 && (
        <div className="d-flex align-items-center gap-2 text-muted small mb-3">
          <span className="spinner-border spinner-border-sm" />
          Thinking…
        </div>
      )}
    </div>
  )
}
