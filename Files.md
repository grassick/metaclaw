# Files

The agent can read, edit, and create files. Users upload files into conversations; the agent works on them using format-aware APIs and can create new files for the user to download. Files are stored on disk with metadata in SQLite.

---

## Storage

Files live on disk in a `files/` directory. Metadata lives in `metaclaw.db`.

### `agent_files` table

| Column | Type | Description |
|---|---|---|
| `_id` | text | UUID |
| `name` | text | Filename (e.g. `budget.xlsx`) |
| `mime_type` | text | Detected MIME type (via magic bytes, not extension) |
| `size` | integer | Size in bytes |
| `disk_path` | text | Path within `files/` directory |
| `source` | text | `upload` (from user), `created` (by agent), `derived` (generated from another file) |
| `source_session_id` | text | Which session uploaded or created it |
| `created_on` | text | ISO 8601 |
| `modified_on` | text | ISO 8601 |

Files are global — any session can access any file, same as state and the database. The `source_session_id` tracks provenance, not access control.

Disk storage rather than SQLite BLOBs because spreadsheets and PDFs can be 10–50 MB. ExcelJS and pdf-lib work with file paths and Buffers naturally.

### Limits

| Limit | Default |
|---|---|
| Max file size | 50 MB |
| Max total workspace size | 1 GB |

---

## Client-Server Transfer

### Upload (client → server)

`POST /api/files/upload` accepting `multipart/form-data`. Server middleware: **multer** or **busboy**.

The server stores the file, detects the MIME type with the **file-type** package (reads magic bytes — doesn't trust the extension), inserts metadata into `agent_files`, and returns the file ID. The client includes the file ID in the chat message so the agent knows a file was attached.

### Download (server → client)

`GET /api/files/:id/download` streams the file to the browser. The agent creates a file, the client gets notified via SSE, and the UI shows a download link.

### SSE events

| Event | When | Payload |
|---|---|---|
| `file:created` | Agent creates a new file | `{ id, name, size, mime_type, source_session_id }` |
| `file:modified` | Agent modifies an existing file | `{ id, name, size, modified_on }` |
| `file:deleted` | Agent deletes a file | `{ id }` |

### Client UI

The chat input gets an attachment button (plus drag-and-drop on the message area). Attached files upload immediately and show as chips in the message. Agent-created files appear as download cards in the chat stream.

On Chromium browsers, the File System Access API (`showSaveFilePicker`) can be offered as an alternative to download — writing the file directly back to the user's disk. This is a progressive enhancement, not a requirement.

---

## Three Tiers of File Access

### Tier 1: Generic file management

The basics — create, list, delete, move files around. Available in every sandbox invocation as `files.*`.

| Method | Description |
|---|---|
| `files.list(pattern?)` | List files, optionally filtered by glob pattern. Returns `{ id, name, size, mime_type, modified_on }[]` |
| `files.info(id)` | Full metadata for a single file |
| `files.create(name, mime?)` | Create a new empty file, returns `{ id, name }` |
| `files.delete(id)` | Remove a file from the workspace |
| `files.copy(id, newName)` | Duplicate a file. Returns the new file's `{ id, name }` |
| `files.rename(id, newName)` | Rename a file |
| `files.download(url, filename?)` | Download a URL directly into the file workspace (server-side fetch + save). Returns `{ id, name, size, mime_type }` |

### Tier 2: Text file access (line-based)

For text files — CSV, JSON, code, markdown, config files. The agent can read portions without loading the whole file.

| Method | Description |
|---|---|
| `files.readText(id, options?)` | Read full text or a line range (`{ startLine, endLine }`). Returns `{ content, totalLines }` |
| `files.writeText(id, content)` | Overwrite the entire file with text |
| `files.replaceLines(id, startLine, endLine, newContent)` | Replace a range of lines |
| `files.insertLines(id, afterLine, content)` | Insert lines after a position |
| `files.searchText(id, pattern)` | Regex search within a file. Returns `{ matches: { line, content }[] }` |
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
      "pattern": { "type": "string", "description": "Optional glob pattern to filter files" }
    },
    "required": []
  }
}
```

**Returns:** `{ files: { id, name, size, mime_type, modified_on }[] }`

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

**Returns:** Full metadata object.

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
      "name": { "type": "string", "description": "Filename" },
      "content": { "type": "string", "description": "Optional initial text content" },
      "mime_type": { "type": "string", "description": "Optional MIME type. Auto-detected if omitted." }
    },
    "required": ["name"]
  }
}
```

**Returns:** `{ id: string, name: string }`

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
      "filename": { "type": "string", "description": "Optional filename. Inferred from URL if omitted." }
    },
    "required": ["url"]
  }
}
```

**Returns:** `{ id: string, name: string, size: number, mime_type: string }`

### Format-specific meta-tools

Each format-specific API method also has a corresponding meta-tool. The naming convention is `spreadsheet_*`, `pdf_*`, `image_*`:

- `spreadsheet_list_sheets`, `spreadsheet_read_range`, `spreadsheet_write_range`, `spreadsheet_read_cell`, `spreadsheet_write_cell`, `spreadsheet_add_sheet`, `spreadsheet_delete_sheet`, `spreadsheet_insert_rows`, `spreadsheet_delete_rows`, `spreadsheet_set_format`, `spreadsheet_auto_filter`, `spreadsheet_get_sheet_summary`
- `pdf_info`, `pdf_extract_text`, `pdf_add_page`, `pdf_delete_page`, `pdf_add_text`, `pdf_add_image`, `pdf_get_form_fields`, `pdf_fill_form`, `pdf_merge`, `pdf_split_pages`
- `image_info`, `image_resize`, `image_crop`, `image_convert`, `image_composite`, `image_to_base64`

Parameter schemas follow the same structure as the sandbox API arguments. See the sandbox API tables above for parameter details.

---

## Sandbox Implementation Notes

All file APIs run on the server, not inside the isolate. The sandbox gets proxy function stubs injected as callbacks — the same mechanism used for `browser.*`, `db.*`, and `state.*`. ExcelJS, pdf-lib, sharp, and pdfjs-dist run in the Node.js host process. The sandbox never touches them.

The cost of injecting the proxy stubs is negligible — they're function references, not library code. The npm packages only load when actually called.

---

## Server-Side Dependencies

| Package | Purpose | License |
|---|---|---|
| **exceljs** | Spreadsheet read/write with formatting and formulas | MIT |
| **pdfjs-dist** | PDF text extraction (Mozilla's PDF.js for Node) | Apache 2.0 |
| **pdf-lib** | PDF creation and editing (add pages, text, images, fill forms, merge) | MIT |
| **sharp** | Image resize, crop, convert | Apache 2.0 |
| **file-type** | MIME detection via magic bytes | MIT |
| **multer** | Express middleware for multipart/form-data upload parsing | MIT |

---

## Open Questions

- **File versioning?** When the agent modifies a file, should the previous version be kept? A simple copy-on-first-write approach (store the original as a backup, subsequent modifications overwrite in place) gives one-level undo without unbounded growth.

- **Concurrent access from sub-sessions?** Two sub-sessions editing the same file would conflict. Options: file-level locking (simple) or document last-write-wins (consistent with how `state` works).

- **Format promotion?** When the user uploads `data.csv`, should `files.spreadsheet.*` APIs work on it? ExcelJS can read CSV. Or should `files.spreadsheet.*` only handle `.xlsx` and CSV stays in text-tier territory?

- **Streaming for large spreadsheets?** ExcelJS supports streaming reads for very large workbooks (100k+ rows). The `readRange` API naturally handles partial reads, but the server implementation could use the streaming worksheet reader instead of loading the entire workbook into memory.
