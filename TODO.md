# Metaclaw — Remaining Implementation Phases

Phases A, B, and H have been implemented. Phase C (PDF + file_view) is partially done. The following phases remain.

---

## Phase C (remaining): Spreadsheet, Image, and Zip APIs

PDF tools (11 meta-tools + `file_view` + sandbox `files.pdf.*`) are implemented. What remains:

**Server deps (not yet installed):** `exceljs`, `yauzl`

**Sandbox** — add `files.spreadsheet.*`, `files.image.*` proxy stubs.

**Meta-tools** (new files `server/src/agent/tools/spreadsheet.ts`, `image.ts`):
- 12 spreadsheet tools (`spreadsheet_list_sheets` through `spreadsheet_auto_filter`)
- 6 image tools (`image_info` through `image_to_base64`)

**Zip extraction:** when `extract=true` on upload and MIME is `application/zip`, use `yauzl` to expand into individual `agent_files` rows preserving internal paths.

**Effort:** Medium

---

## Phase D: Rendering and Canvas

The "build apps" feature. Agent creates UI components, renders them to the user.

**Server:**
- `render_and_wait` meta-tool — sets `asPendingToolCall`, pauses session
- `render_blocks` meta-tool — structured block array (markdown, table, chart, form, code, image, alert, json)

**Client deps:** `recharts`, `react-leaflet`, `leaflet`, `lucide-react`, `sucrase`

**Client:**
- Canvas panel (side-by-side with chat, maximize button)
- Sucrase transpiler for inline JSX
- Error boundary wrapper
- Pre-built component library: Card, Table, Button, Alert, Badge, Tabs, Form, TextInput, Select, Toggle, Spinner, CodeBlock, Chart, Map, Markdown, Stack, Grid, Icon, Modal
- Injected hooks: `useAgentState(key)`, `callBackend(fn, args)`, `callTool(action, payload)`, `sendMessage(text)`, `importModule(pkg)`, `loadStylesheet(url)`
- Page navigation tabs (Chat + stored components as pages)
- `render_blocks` block renderers (form submission flow, chart rendering)

**Effort:** XL

---

## Phase E: Web and Browser

**Server deps:** `playwright`, `@mozilla/readability`, `linkedom`, `turndown`

**Web meta-tools + sandbox** (new file `server/src/agent/tools/web.ts`): `web_search`, `web_read`. Sandbox: `web.search()`, `web.read()`.

**Browser meta-tools + sandbox** (new file `server/src/agent/tools/browser.ts`): 8 tools (`browser_navigate` through `browser_close`). Session-scoped Playwright context. Sandbox: `browser.*` namespace.

**Effort:** Large

---

## Phase F: Scheduler and Reminders

**Server** — new file `server/src/scheduler.ts`:
- `setInterval` loop (~30s) polling `agent_reminders` and `agent_scheduled_tasks`
- Reminders: inject message into session, kick off agent step, delete row
- Tasks: create fresh session with task prompt, run step, update `next_run` / `last_run`

**Meta-tools**: `set_reminder`, `cancel_reminder`, `create_scheduled_task`, `list_scheduled_tasks`, `cancel_scheduled_task`, `enable_scheduled_task`, `disable_scheduled_task`

**Frontend:** Scheduled Tasks settings tab (list, create, pause/resume, delete).

**Effort:** Medium

---

## Phase G: Sub-Sessions

**Server** — extend `SessionController.ts`:
- `spawn_session`: create child session with task prompt, link via `parent_session_id` + `parent_tool_call_id`
- `fork_session`: copy parent history + notepad, append task
- `wait_for_sessions`: `asPendingToolCall`, resume when children reach terminal state
- `report_result`: set session to `completed`, notify parent
- Max depth (3), max concurrent (10), execution timeout (120s)

**Meta-tools**: `spawn_session`, `fork_session`, `wait_for_sessions`, `report_result`

**Frontend:** Sub-session indicators in sidebar (nested under parent, status badge). Click-through to sub-session chat.

**Effort:** Large

---

## Phase I: MCP Client

**Server deps:** `@ai-sdk/mcp`

**Server** — new file `server/src/mcp/MCPManager.ts`:
- Manage connections per `agent_mcp_servers` row (stdio/http/sse transports)
- Connect on demand, reconnect on failure, close on disable
- Expose tools to `getTools()` merge in PersonalAgent.ts
- Emit `mcp:status` SSE events

**Meta-tools** (read-only): `list_mcp_servers`, `list_mcp_resources`, `read_mcp_resource`, `list_mcp_prompts`, `get_mcp_prompt`

**Sandbox:** `mcp.callTool()`, `mcp.resources()`, `mcp.readResource()`

**Frontend:** MCP settings tab (server list, status indicators, add/remove/enable/disable, tool list per server).

**Effort:** Large

---

## Phase J: Settings Panel Expansion

Final polish — full settings UI.

- **Tools tab:** list with name/description/enabled toggle, click to view/edit code + schema
- **Functions tab:** same pattern
- **Libraries tab:** same pattern
- **Skills tab:** list with source badge (user/agent), enabled toggle, markdown content editor
- **Secrets tab:** add/edit/delete, masked values
- **DB Stats tab:** table count, size, optional query runner
- **Config History tab:** version list with diff view and rollback button
- **Agent management:** create/delete agents from settings (currently only switcher)

**Effort:** Medium
