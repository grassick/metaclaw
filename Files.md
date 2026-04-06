# Files

The agent can read, edit, and create files. Users upload files into conversations; the agent works on them using format-aware APIs and can create new files for the user to download. Files are stored on disk with metadata in SQLite.

---

## Storage

Files live on disk in a `files/` directory. Metadata lives in `metaclaw.db`.

### `agent_files` table

| Column | Type | Description |
|---|---|---|
| `_id` | text | Short ID (`f_` prefix + 8 alphanumeric chars via nanoid, e.g. `f_x7kQ9mBn`) |
| `agent_id` | text | FK to `agents` (always set — identifies which agent owns the file) |
| `path` | text | Logical file path (e.g. `forms/w2-employer1.pdf`). Slash-separated, no leading slash. |
| `mime_type` | text | Detected MIME type (via magic bytes, not extension) |
| `size` | integer | Size in bytes |
| `disk_path` | text | Path within `files/` directory (ID-based on disk, not related to the logical `path`) |
| `session_id` | text | FK to `agent_sessions`. Set for session-scoped files, null otherwise. `ON DELETE CASCADE`. |
| `source` | text | `upload` (from user), `created` (by agent), `derived` (generated from another file) |
| `source_session_id` | text | Which session uploaded or created it (provenance, not access control) |
| `created_on` | text | ISO 8601 |
| `modified_on` | text | ISO 8601 |

Scope is derived from the FK columns: `session_id IS NOT NULL` → session-scoped, null → agent-scoped. No uniqueness constraint on paths — since a session sees files from multiple scopes simultaneously, cross-scope path collisions are unavoidable. The file ID is the real identifier; paths are informational metadata.

Disk storage rather than SQLite BLOBs because spreadsheets and PDFs can be 10–50 MB. ExcelJS and pdf-lib work with file paths and Buffers naturally.

### Limits

| Limit | Default |
|---|---|
| Max file size | 50 MB |
| Max total workspace size | 1 GB |

---

## File Scoping

Files are scoped to a session or the agent globally. This determines which sessions can see them.

### Scoping hierarchy

```
Session files   →  only this conversation sees them (default for uploads)
Agent files     →  all sessions across the agent see them
```

### Default scope on creation

| How the file is created | Default scope |
|---|---|
| User uploads | `session` (that session's ID) |
| Agent creates a file | `session` |
| Agent creates a file via `file_download` | `session` |
| Agent creates a derived file (`source: derived`) | Same scope as the source file |
| Sub-session creates a file | Inherits the parent session's scope rules |

### Visibility

`file_list` (and `files.list()` in sandbox) returns files visible to the current session — the union of:

- `session_id = current_session_id`
- `session_id IS NULL` (agent-scoped files)

A `scope` filter parameter on `file_list` lets the agent narrow this (e.g. only session files, only agent files).

### Promotion

The `promote_file` meta-tool (and `files.promote()` in sandbox) changes a file's scope upward:

- Session → agent

Demotion is not supported — there's no good reason to narrow a file's visibility.

---

## Path-Based File Naming

`agent_files.path` is a logical, slash-separated name within the file's scope:

- `budget.xlsx` (flat — just a filename)
- `forms/w2-employer1.pdf` (one level of nesting)
- `receipts/medical/receipt-001.jpg` (deeper nesting)

No leading slash. No `.` or `..` components (rejected on write). The `files.list()` glob matching operates on paths: `files.list("forms/*.pdf")`, `files.list("**/*.xlsx")`.

When files are uploaded with relative paths preserved (batch/folder upload), the paths are stored as-is. When a single file is uploaded without a path, the path is just the filename.

Paths are logical metadata — the physical storage on disk uses the file's short ID as the filename regardless of the logical path.

---

## Client-Server Transfer

### Upload (client → server)

`POST /api/files/upload` accepting `multipart/form-data`. Server middleware: **multer** or **busboy**.

The server stores each file, detects the MIME type with the **file-type** package (reads magic bytes — doesn't trust the extension), inserts metadata into `agent_files` with the appropriate scope, and returns the file IDs. The client includes the file IDs in the chat message so the agent knows files were attached.

Parameters:

| Parameter | Required | Description |
|---|---|---|
| `session_id` | Yes | Determines default scope (session-scoped). Set to null explicitly if agent-scoped uploading is needed. |
| `files` | Yes | One or more files (multipart fields) |
| `extract` | No | If `true` and the file is a zip, extract contents preserving internal directory structure as paths |

The endpoint accepts multiple files in a single request. Each file gets its own `agent_files` row. The response returns an array of `{ id, path, size, mime_type, scope, session_id? }`.

### Batch upload: folders

The client uses the `webkitdirectory` attribute on the file input (supported in all major browsers) to let the user select a folder. The browser sends all files with `webkitRelativePath` preserved. The server stores each file with its relative path in `agent_files.path`.

### Batch upload: zip extraction

When a file with MIME type `application/zip` is uploaded with `extract=true`, the server extracts the zip and creates individual `agent_files` rows preserving the internal directory structure as paths. Uses the **yauzl** package (MIT). If `extract` is not set, the zip is stored as a regular file.

### Download (server → client)

`GET /api/files/:id/download` streams the file to the browser. The agent creates a file, the client gets notified via SSE, and the UI shows a download link.

### SSE events

| Event | When | Payload |
|---|---|---|
| `file:created` | Agent creates a new file | `{ id, path, size, mime_type, scope, session_id?, source_session_id }` |
| `file:modified` | Agent modifies an existing file | `{ id, path, size, modified_on }` |
| `file:deleted` | Agent deletes a file | `{ id }` |

### Client UI

The chat input gets an attachment button (plus drag-and-drop on the message area). Attached files upload immediately and show as chips in the message. Agent-created files appear as download cards in the chat stream.

The attachment button supports multi-file selection and folder selection (via a dropdown or secondary option). Drag-and-drop accepts multiple files.

On Chromium browsers, the File System Access API (`showSaveFilePicker`) can be offered as an alternative to download — writing the file directly back to the user's disk. This is a progressive enhancement, not a requirement.

---

## Three Tiers of File Access

### Tier 1: Generic file management

The basics — create, list, delete, move files around. Available in every sandbox invocation as `files.*`. All listing and creation operations respect the current session's file scope.

| Method | Description |
|---|---|
| `files.list(pattern?)` | List visible files, optionally filtered by glob pattern on path. Returns `{ id, path, size, mime_type, scope, modified_on }[]` |
| `files.info(id)` | Full metadata for a single file |
| `files.create(path, mime?)` | Create a new empty file at the given path, returns `{ id, path }`. Scoped per default rules. |
| `files.delete(id)` | Remove a file from the workspace |
| `files.copy(id, newPath)` | Duplicate a file. Returns the new file's `{ id, path }` |
| `files.rename(id, newPath)` | Rename/move a file (change its logical path) |
| `files.download(url, filename?)` | Download a URL directly into the file workspace (server-side fetch + save). Returns `{ id, path, size, mime_type }` |
| `files.promote(id, targetScope)` | Promote a file's scope: `'agent'`. See [File Scoping](#file-scoping). |
| `files.search(pattern, options?)` | Search across visible files. See [Cross-File Search](#cross-file-search). |

### Tier 2: Text file access (line-based)

For text files — CSV, JSON, code, markdown, config files. The agent can read portions without loading the whole file.

| Method | Description |
|---|---|
| `files.readText(id, options?)` | Read full text or a line range (`{ startLine, endLine }`). Returns `{ content, totalLines }` |
| `files.writeText(id, content)` | Overwrite the entire file with text |
| `files.replaceLines(id, startLine, endLine, newContent)` | Replace a range of lines |
| `files.insertLines(id, afterLine, content)` | Insert lines after a position |
| `files.searchText(id, pattern)` | Regex search within a single file. Returns `{ matches: { line, content }[] }` |
| `files.lineCount(id)` | Total line count |

### Tier 3: Format-specific APIs

For binary and structured formats. The server loads the appropriate library and exposes high-level operations. The agent never sees raw bytes — it works with cells, pages, fields.

These are available as sub-namespaces on the `files` object: `files.spreadsheet.*`, `files.pdf.*`, `files.image.*`. See sections below.

### Raw binary (escape hatch)

For formats without a dedicated API. The agent (or agent-authored tools) can work with base64 chunks directly.

| Method | Description |
|---|---|
| `files.readBytes(id, offset, length)` | Returns base64 of a byte range |
| `files.writeBytes(id, offset, base64data)` | Write bytes at an offset |
| `files.appendBytes(id, base64data)` | Append bytes to end of file |

---

## Cross-File Search

Search across all files visible to the current session. Runs server-side: regex on text files, text extraction then search for PDFs, cell value search for spreadsheets. Respects file scoping.

### `files.search()` sandbox API

```typescript
files.search(pattern: string, options?: {
  glob?: string    // path glob to filter which files to search (e.g. "forms/*.pdf")
  scope?: 'session' | 'agent' | 'all'  // narrow to a specific scope, default 'all' visible
}): Promise<{
  matches: {
    file_id: string
    path: string
    mime_type: string
    excerpts: { line?: number, text: string }[]
  }[]
  files_searched: number
  truncated: boolean
}>
```

Format-specific behavior:

- **Text files:** Direct regex search. `line` is the 1-based line number, `text` is the matching line.
- **PDFs:** Text extraction (via pdfjs-dist) then regex search. `line` is omitted (PDF text extraction doesn't produce stable line numbers). `text` is a snippet with surrounding context.
- **Spreadsheets:** Cell value search (via ExcelJS). `text` includes the cell reference, e.g. `"Sheet1!C12: Schedule C income"`.
- **Images/binary:** Skipped (not searchable).

### Limits

| Limit | Default |
|---|---|
| Max files searched per call | 50 |
| Max total matches returned | 100 |

When limits are hit, `truncated` is `true`.

---

## Spreadsheet API (`files.spreadsheet.*`)

Server-side library: **ExcelJS** (MIT). Supports .xlsx read/write with formatting, formulas, and streaming for large files.

| Method | Description |
|---|---|
| `files.spreadsheet.listSheets(fileId)` | Sheet names with row/column counts |
| `files.spreadsheet.getSheetSummary(fileId, sheet)` | Row count, column headers, sample rows from top and bottom. The agent calls this first to understand the data without reading everything. |
| `files.spreadsheet.readRange(fileId, sheet, range)` | Read a cell range (e.g. `"A1:D50"`). Returns a 2D array of values. |
| `files.spreadsheet.writeRange(fileId, sheet, startCell, data)` | Write a 2D array starting at a cell |
| `files.spreadsheet.readCell(fileId, sheet, cell)` | Single cell: value, formula, and format |
| `files.spreadsheet.writeCell(fileId, sheet, cell, value, options?)` | Write a single cell. Options: `{ formula?, format? }` |
| `files.spreadsheet.addSheet(fileId, name)` | Create a new worksheet |
| `files.spreadsheet.deleteSheet(fileId, name)` | Remove a worksheet |
| `files.spreadsheet.insertRows(fileId, sheet, afterRow, count)` | Insert empty rows |
| `files.spreadsheet.deleteRows(fileId, sheet, startRow, count)` | Delete rows |
| `files.spreadsheet.setFormat(fileId, sheet, range, format)` | Bold, colors, number format, column width, etc. |
| `files.spreadsheet.autoFilter(fileId, sheet, range)` | Apply autofilter to a range |

### Typical agent workflow

1. `files.spreadsheet.listSheets(id)` — what sheets exist?
2. `files.spreadsheet.getSheetSummary(id, "Sheet1")` — what does this sheet look like?
3. `files.spreadsheet.readRange(id, "Sheet1", "A1:F5")` — read the header area
4. `files.spreadsheet.readRange(id, "Sheet1", "E2:E50")` — read the specific column to modify
5. `files.spreadsheet.writeRange(id, "Sheet1", "E2", [[newVal1], [newVal2], ...])` — write updated values
6. `files.spreadsheet.setFormat(id, "Sheet1", "E2:E50", { numberFormat: "$#,##0" })` — format

---

## PDF API (`files.pdf.*`)

Server-side libraries: **pdf-lib** (MIT) for creation and editing + **pdfjs-dist** (Apache 2.0) for text extraction. Two libraries because PDF creation and extraction are very different problems.

| Method | Description |
|---|---|
| `files.pdf.info(fileId)` | Page count, page sizes, title, author, whether it has forms |
| `files.pdf.extractText(fileId, options?)` | Extract text, optionally from specific pages: `{ pages: [1, 2, 3] }` |
| `files.pdf.pageToImage(fileId, pageNum, options?)` | Render a PDF page as a PNG image file. Options: `{ dpi?: number }` (default 150). Returns `{ id, path, width, height }` of the new image file. Essential for scanned PDFs where `extractText` returns nothing — the image can then be passed to a vision model. |
| `files.pdf.addPage(fileId, options?)` | Add a blank page. Options: `{ size?, orientation? }` |
| `files.pdf.deletePage(fileId, pageNum)` | Remove a page |
| `files.pdf.addText(fileId, page, text, position, style)` | Place text at coordinates with font, size, color |
| `files.pdf.addImage(fileId, page, imageFileId, position, size)` | Place an image (from another file in the workspace) onto a page |
| `files.pdf.getFormFields(fileId)` | List form fields with types and current values |
| `files.pdf.fillForm(fileId, fields)` | Fill form fields by name: `{ fieldName: value }` |
| `files.pdf.merge(fileIds, outputName)` | Merge multiple PDFs into one new file |
| `files.pdf.splitPages(fileId, ranges)` | Split into multiple files by page ranges |

---

## Image API (`files.image.*`)

Server-side library: **sharp** (Apache 2.0). Fast resize/crop/convert via libvips.

| Method | Description |
|---|---|
| `files.image.info(fileId)` | Width, height, format, color depth |
| `files.image.resize(fileId, width, height, options?)` | Resize or scale. Options: `{ fit?: 'cover' \| 'contain' \| 'fill' }` |
| `files.image.crop(fileId, region)` | Crop to `{ left, top, width, height }` |
| `files.image.convert(fileId, format)` | Convert between PNG, JPEG, WebP |
| `files.image.composite(fileId, overlays)` | Layer images on top of each other |
| `files.image.toBase64(fileId, options?)` | Get base64 for embedding in UI or sending to vision models. Options: `{ maxWidth?, maxHeight? }` |

---

## Meta-Tools

Corresponding meta-tools for the LLM to call directly (outside of sandbox code). These mirror the sandbox APIs.

### `file_list`

```json
{
  "name": "file_list",
  "parameters": {
    "type": "object",
    "properties": {
      "pattern": { "type": "string", "description": "Optional glob pattern to filter files by path" },
      "scope": { "type": "string", "enum": ["session", "agent", "all"], "description": "Filter to a specific scope. Default: 'all' (all files visible to the current session)." }
    },
    "required": []
  }
}
```

**Returns:** `{ files: { id, path, size, mime_type, scope, modified_on }[] }`

### `file_info`

```json
{
  "name": "file_info",
  "parameters": {
    "type": "object",
    "properties": {
      "id": { "type": "string", "description": "File ID" }
    },
    "required": ["id"]
  }
}
```

**Returns:** Full metadata object including `scope` (derived: `'session'`, or `'agent'`), and `session_id`.

### `file_read_text`

```json
{
  "name": "file_read_text",
  "parameters": {
    "type": "object",
    "properties": {
      "id": { "type": "string", "description": "File ID" },
      "start_line": { "type": "number", "description": "First line to read (1-based). Omit to start from the beginning." },
      "end_line": { "type": "number", "description": "Last line to read (inclusive). Omit to read to the end." }
    },
    "required": ["id"]
  }
}
```

**Returns:** `{ content: string, total_lines: number }`

### `file_write_text`

```json
{
  "name": "file_write_text",
  "parameters": {
    "type": "object",
    "properties": {
      "id": { "type": "string", "description": "File ID" },
      "content": { "type": "string", "description": "Full text content to write" }
    },
    "required": ["id", "content"]
  }
}
```

**Returns:** `{ ok: true, size: number }`

### `file_replace_lines`

```json
{
  "name": "file_replace_lines",
  "parameters": {
    "type": "object",
    "properties": {
      "id": { "type": "string", "description": "File ID" },
      "start_line": { "type": "number", "description": "First line to replace (1-based)" },
      "end_line": { "type": "number", "description": "Last line to replace (inclusive)" },
      "content": { "type": "string", "description": "Replacement text" }
    },
    "required": ["id", "start_line", "end_line", "content"]
  }
}
```

**Returns:** `{ ok: true, total_lines: number }`

### `file_create`

```json
{
  "name": "file_create",
  "parameters": {
    "type": "object",
    "properties": {
      "path": { "type": "string", "description": "Logical file path (e.g. 'report.xlsx' or 'output/summary.pdf')" },
      "content": { "type": "string", "description": "Optional initial text content" },
      "mime_type": { "type": "string", "description": "Optional MIME type. Auto-detected if omitted." },
      "scope": { "type": "string", "enum": ["session", "agent"], "description": "Override the default scope. Default: session-scoped." }
    },
    "required": ["path"]
  }
}
```

**Returns:** `{ id: string, path: string, scope: string }`

### `file_delete`

```json
{
  "name": "file_delete",
  "parameters": {
    "type": "object",
    "properties": {
      "id": { "type": "string", "description": "File ID" }
    },
    "required": ["id"]
  }
}
```

**Returns:** `{ deleted: boolean }`

### `file_download`

Download a URL into the file workspace.

```json
{
  "name": "file_download",
  "parameters": {
    "type": "object",
    "properties": {
      "url": { "type": "string", "description": "URL to download" },
      "path": { "type": "string", "description": "Optional file path. Inferred from URL if omitted." }
    },
    "required": ["url"]
  }
}
```

**Returns:** `{ id: string, path: string, size: number, mime_type: string, scope: string }`

### `promote_file`

Change a file's scope upward: Session → agent.

```json
{
  "name": "promote_file",
  "parameters": {
    "type": "object",
    "properties": {
      "id": { "type": "string", "description": "File ID" },
      "target_scope": { "type": "string", "enum": ["agent"], "description": "New scope for the file" }
    },
    "required": ["id", "target_scope"]
  }
}
```

Promoting a file that is already at or above the target scope is a no-op.

**Returns:** `{ id: string, scope: string, session_id?: string }`

### `file_search`

Search across all files visible to the current session.

```json
{
  "name": "file_search",
  "parameters": {
    "type": "object",
    "properties": {
      "pattern": { "type": "string", "description": "Regex pattern to search for" },
      "glob": { "type": "string", "description": "Optional path glob to filter which files to search (e.g. 'forms/*.pdf')" },
      "scope": { "type": "string", "enum": ["session", "agent", "all"], "description": "Narrow to a specific scope. Default: 'all' visible files." }
    },
    "required": ["pattern"]
  }
}
```

**Returns:** `{ matches: { file_id: string, path: string, mime_type: string, excerpts: { line?: number, text: string }[] }[], files_searched: number, truncated: boolean }`

### `file_view`

Load an image or PDF page into the main LLM's context as a vision input. This is the visual equivalent of `file_read_text` — the agent calls it when it needs to *see* a file rather than read its text. The tool result contains image content parts that the AI SDK injects into the conversation, so the main LLM sees the actual image on the next turn.

For images, the file is loaded directly. For PDFs, each requested page is rendered to a PNG first (via `pdf.pageToImage` under the hood). For scanned PDFs where `extractText` returns nothing, this is the primary way to get content — the main LLM reads the page visually.

```json
{
  "name": "file_view",
  "parameters": {
    "type": "object",
    "properties": {
      "id": { "type": "string", "description": "File ID (image or PDF)" },
      "pages": {
        "type": "array",
        "items": { "type": "number" },
        "description": "For PDFs: which pages to view (1-based). Omit to view just page 1. Max 5 pages per call."
      },
      "max_width": { "type": "number", "description": "Max pixel width for the image. Large images are downscaled to stay within token budget. Default: 1024." },
      "dpi": { "type": "number", "description": "For PDFs: rendering resolution. Default: 150." }
    },
    "required": ["id"]
  }
}
```

**Returns:** Image content parts (one per page/image) injected into the tool result as vision inputs. The LLM sees them inline in the conversation. Also returns `{ pages_rendered: number }` as text metadata.

### Format-specific meta-tools

Each format-specific API method also has a corresponding meta-tool. The naming convention is `spreadsheet_*`, `pdf_*`, `image_*`:

- `spreadsheet_list_sheets`, `spreadsheet_read_range`, `spreadsheet_write_range`, `spreadsheet_read_cell`, `spreadsheet_write_cell`, `spreadsheet_add_sheet`, `spreadsheet_delete_sheet`, `spreadsheet_insert_rows`, `spreadsheet_delete_rows`, `spreadsheet_set_format`, `spreadsheet_auto_filter`, `spreadsheet_get_sheet_summary`
- `pdf_info`, `pdf_extract_text`, `pdf_page_to_image`, `pdf_add_page`, `pdf_delete_page`, `pdf_add_text`, `pdf_add_image`, `pdf_get_form_fields`, `pdf_fill_form`, `pdf_merge`, `pdf_split_pages`
- `image_info`, `image_resize`, `image_crop`, `image_convert`, `image_composite`, `image_to_base64`

Parameter schemas follow the same structure as the sandbox API arguments. See the sandbox API tables above for parameter details.

---

## Sandbox Implementation Notes

All file APIs run on the server, not inside the isolate. The sandbox gets proxy function stubs injected as callbacks — the same mechanism used for `browser.*`, `db.*`, and `state.*`. ExcelJS, pdf-lib, sharp, and pdfjs-dist run in the Node.js host process. The sandbox never touches them.

The cost of injecting the proxy stubs is negligible — they're function references, not library code. The npm packages only load when actually called.

The file scope context (current session ID) is injected into the sandbox at creation time so that `files.list()`, `files.create()`, and `files.search()` automatically apply the correct scope filters without the sandbox code needing to pass scope parameters explicitly.

---

## Server-Side Dependencies

| Package | Purpose | License |
|---|---|---|
| **exceljs** | Spreadsheet read/write with formatting and formulas | MIT |
| **pdfjs-dist** | PDF text extraction and page rendering (Mozilla's PDF.js for Node) | Apache 2.0 |
| **canvas** | Node canvas for pdfjs-dist page rendering (`pdf.pageToImage`) | MIT |
| **pdf-lib** | PDF creation and editing (add pages, text, images, fill forms, merge) | MIT |
| **sharp** | Image resize, crop, convert | Apache 2.0 |
| **file-type** | MIME detection via magic bytes | MIT |
| **multer** | Express middleware for multipart/form-data upload parsing | MIT |
| **yauzl** | Zip file extraction for batch upload | MIT |
| **nanoid** | Short, URL-safe unique ID generation for file IDs | MIT |

---

## Open Questions

- **File versioning?** When the agent modifies a file, should the previous version be kept? A simple copy-on-first-write approach (store the original as a backup, subsequent modifications overwrite in place) gives one-level undo without unbounded growth.

- **Concurrent access from sub-sessions?** Two sub-sessions editing the same file would conflict. Options: file-level locking (simple) or document last-write-wins (consistent with how `state` works).

- **Format promotion?** When the user uploads `data.csv`, should `files.spreadsheet.*` APIs work on it? ExcelJS can read CSV. Or should `files.spreadsheet.*` only handle `.xlsx` and CSV stays in text-tier territory?

- **Streaming for large spreadsheets?** ExcelJS supports streaming reads for very large workbooks (100k+ rows). The `readRange` API naturally handles partial reads, but the server implementation could use the streaming worksheet reader instead of loading the entire workbook into memory.

- **File cleanup on session archive/delete:** When a session is completed/archived, what happens to its session-scoped files? Options: (a) delete them, (b) keep them orphaned, (c) prompt the user. Leaning toward keeping them but surfacing orphaned files in the settings file browser for manual cleanup.
