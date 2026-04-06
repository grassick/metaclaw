import { useState, useEffect, useRef, useCallback } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { useAppStore } from "../stores/sessionStore"
import { api } from "../services/api"

const TEXT_PREFIXES = [
  "text/",
  "application/json",
  "application/javascript",
  "application/xml",
  "application/csv",
  "application/x-yaml",
]

function isTextType(mime: string | null): boolean {
  if (!mime) return false
  return TEXT_PREFIXES.some((p) => mime.startsWith(p))
}

function isImageType(mime: string | null): boolean {
  return !!mime && mime.startsWith("image/")
}

function isMarkdown(path: string, mime: string | null): boolean {
  if (mime === "text/markdown") return true
  const lower = path.toLowerCase()
  return lower.endsWith(".md") || lower.endsWith(".markdown")
}

function isHtml(path: string, mime: string | null): boolean {
  if (mime === "text/html") return true
  return path.toLowerCase().endsWith(".html") || path.toLowerCase().endsWith(".htm")
}

function languageFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  const map: Record<string, string> = {
    js: "javascript", ts: "typescript", jsx: "javascript", tsx: "typescript",
    py: "python", rb: "ruby", go: "go", rs: "rust",
    json: "json", yaml: "yaml", yml: "yaml", xml: "xml",
    css: "css", html: "html", sql: "sql", sh: "bash",
    csv: "csv", md: "markdown",
  }
  return map[ext] ?? ""
}

export default function FilePreview() {
  const previewFile = useAppStore((s) => s.previewFile)
  const closeFilePreview = useAppStore((s) => s.closeFilePreview)

  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [width, setWidth] = useState(() => Math.round(window.innerWidth * 0.5))
  const dragging = useRef(false)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    const startX = e.clientX
    const startWidth = width

    const onMouseMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX
      const newWidth = Math.max(260, Math.min(window.innerWidth * 0.85, startWidth + delta))
      setWidth(Math.round(newWidth))
    }

    const onMouseUp = () => {
      dragging.current = false
      document.removeEventListener("mousemove", onMouseMove)
      document.removeEventListener("mouseup", onMouseUp)
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
    }

    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
    document.addEventListener("mousemove", onMouseMove)
    document.addEventListener("mouseup", onMouseUp)
  }, [width])

  useEffect(() => {
    if (!previewFile) return

    setContent(null)
    setLoading(true)
    setError(null)

    if (isImageType(previewFile.mime_type)) {
      setLoading(false)
      return
    }

    if (isTextType(previewFile.mime_type) || isMarkdown(previewFile.path, previewFile.mime_type)) {
      api.getFileContent(previewFile.id)
        .then((text) => { setContent(text); setLoading(false) })
        .catch((err) => { setError(err.message); setLoading(false) })
      return
    }

    setLoading(false)
  }, [previewFile])

  if (!previewFile) return null

  const filename = previewFile.path.split("/").pop() ?? previewFile.path

  return (
    <div className="file-preview-panel d-flex flex-column border-start" style={{ width }}>
      <div
        className={`file-preview-drag-handle${dragging.current ? " dragging" : ""}`}
        onMouseDown={onMouseDown}
      />
      {/* Header */}
      <div className="d-flex align-items-center gap-2 border-bottom px-3 py-2 bg-body-tertiary">
        <span className="fw-medium text-truncate flex-grow-1" title={previewFile.path}>
          {filename}
        </span>
        <a
          href={api.getFileDownloadUrl(previewFile.id)}
          download={filename}
          className="btn btn-sm btn-outline-secondary py-0 px-2"
          title="Download"
        >
          ↓
        </a>
        <button
          className="btn btn-sm btn-outline-secondary py-0 px-2"
          onClick={closeFilePreview}
          title="Close"
        >
          ✕
        </button>
      </div>

      {/* Content */}
      <div className="flex-grow-1 overflow-auto p-3">
        {loading && (
          <div className="d-flex align-items-center gap-2 text-muted">
            <span className="spinner-border spinner-border-sm" />
            Loading…
          </div>
        )}

        {error && (
          <div className="text-danger small">Failed to load: {error}</div>
        )}

        {!loading && !error && isImageType(previewFile.mime_type) && (
          <img
            src={api.getFileViewUrl(previewFile.id)}
            alt={filename}
            className="img-fluid rounded"
            style={{ maxHeight: "100%" }}
          />
        )}

        {!loading && !error && content !== null && isMarkdown(previewFile.path, previewFile.mime_type) && (
          <div className="assistant-message">
            <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
          </div>
        )}

        {!loading && !error && content !== null && isHtml(previewFile.path, previewFile.mime_type) && (
          <iframe
            srcDoc={content}
            title={filename}
            className="w-100 border rounded"
            style={{ height: "100%", minHeight: 400 }}
            sandbox="allow-scripts"
          />
        )}

        {!loading && !error && content !== null
          && !isMarkdown(previewFile.path, previewFile.mime_type)
          && !isHtml(previewFile.path, previewFile.mime_type)
          && isTextType(previewFile.mime_type) && (
          <pre className="bg-body-secondary rounded p-3" style={{ fontSize: "0.8125rem", whiteSpace: "pre-wrap" }}>
            <code className={languageFromPath(previewFile.path) ? `language-${languageFromPath(previewFile.path)}` : ""}>
              {content}
            </code>
          </pre>
        )}

        {!loading && !error && content === null && !isImageType(previewFile.mime_type) && (
          <div className="text-muted text-center mt-4">
            <p>Preview not available for this file type.</p>
            <a
              href={api.getFileDownloadUrl(previewFile.id)}
              download={filename}
              className="btn btn-outline-primary btn-sm"
            >
              Download instead
            </a>
          </div>
        )}
      </div>
    </div>
  )
}
