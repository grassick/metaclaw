# Sandbox Runtime

This defines everything available to agent-authored code running in isolated-vm — both agent-created tools and ad-hoc `run_sandbox_code` invocations. There are no Node.js APIs and no file system access. Every external capability is injected by the host as a callback. Code reuse across tools is handled by `require()`, which loads agent-created libraries.

## Quick reference

```typescript
// Tool arguments (only present during tool execution, not run_sandbox_code)
args: Record<string, any>

// Return a result
resolve(value: any): void

// Console (captured and returned in logs)
console.log(...args: any[]): void
console.warn(...args: any[]): void
console.error(...args: any[]): void

// Network
fetch(url: string, options?: FetchOptions): Promise<FetchResponse>

// Key-value state
state.get(key: string): Promise<any | null>
state.set(key: string, value: any): Promise<void>
state.delete(key: string): Promise<boolean>
state.keys(prefix?: string): Promise<string[]>

// Database (agent's own SQLite DB)
db.sql(sql: string, params?: any[]): Promise<QueryResult | WriteResult>
db.schema(): Promise<SchemaResult>

// Libraries (agent-created shared code)
require(name: string): any

// Browser (headless Chromium, server-side)
browser.navigate(url: string, options?: NavigateOptions): Promise<PageInfo>
browser.screenshot(options?: ScreenshotOptions): Promise<Screenshot>
browser.click(selector: string): Promise<void>
browser.type(selector: string, text: string, options?: TypeOptions): Promise<void>
browser.extractText(selector?: string): Promise<string>
browser.extractHtml(selector?: string, options?: HtmlOptions): Promise<string>
browser.evaluate(code: string): Promise<any>
browser.close(): Promise<void>

// Secrets
secrets: Record<string, string>

// Utilities
btoa(data: string): string
atob(data: string): string
parseCSV(text: string, options?: { header?: boolean }): any[]
setTimeout(fn: () => void, ms: number): number
clearTimeout(id: number): void
```

---

## Detailed API

### `args`

The validated arguments passed by the LLM when calling an agent-created tool. Only present during tool execution — not available in `run_sandbox_code`.

### `resolve(value)`

Call to return a result from the script. The value is serialized as JSON and sent back to the LLM as the tool result. If the script returns a value from the top-level expression instead, that works too — `resolve` is for async flows where you need to return from inside a callback.

### `console`

Standard `log`, `warn`, `error`. Output is captured into a `logs` array returned alongside the result. Useful for debugging — the LLM sees these in the tool response.

### `fetch(url, options?)`

SSRF-protected HTTP client. Blocks private IPs, localhost, and cloud metadata endpoints.

```typescript
interface FetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
  headers?: Record<string, string>
  body?: string
  timeout?: number  // ms, default 30000
}

interface FetchResponse {
  ok: boolean
  status: number
  headers: Record<string, string>
  text(): Promise<string>
  json(): Promise<any>
}
```

### `state`

Direct access to the `agent_state` key-value store. Same data the meta-tools `get_state`/`set_state` operate on.

| Method | Description |
|--------|-------------|
| `state.get(key)` | Returns the value or `null` |
| `state.set(key, value)` | Upserts a JSON value |
| `state.delete(key)` | Returns `true` if the key existed |
| `state.keys(prefix?)` | Lists keys, optionally filtered by prefix |

### `db`

Access to the agent's SQLite database (`agent_data.db`). Same database the `db_sql` and `db_schema` meta-tools operate on.

```typescript
// Auto-detects reads vs writes based on the SQL
db.sql(sql: string, params?: any[]): Promise<QueryResult | WriteResult>

interface QueryResult {
  columns: string[]
  rows: any[][]
  row_count: number
  truncated: boolean  // true if capped at 1000 rows
}

interface WriteResult {
  changes: number
  last_insert_rowid: number
}

// Returns structured table/column info
db.schema(): Promise<{
  tables: {
    name: string
    columns: { name: string, type: string, notnull: boolean, pk: boolean }[]
    row_count: number
  }[]
}>
```

### `require(name)`

Load an agent-created library by name. Libraries are stored in the `agent_libraries` table and managed via the `create_library` / `update_library` / etc. meta-tools. This is the mechanism for code reuse across tools and `run_sandbox_code` invocations.

Uses CommonJS conventions — libraries export via `exports.foo = ...` or `module.exports = ...`.

```typescript
// Loading a library
const { formatDate, retry } = require('utils')
const { callAPI } = require('api_client')

// Libraries can require other libraries
// (inside "api_client" library code:)
const { retry } = require('utils')
exports.callAPI = async function(endpoint, params) {
  return retry(() => fetch(endpoint, { method: 'POST', body: JSON.stringify(params) }), 3)
}
```

**Caching:** Each library executes at most once per sandbox invocation. If multiple tools/libraries require the same dependency, the cached exports are returned.

**Circular dependencies:** Detected and thrown as an error.

**Not Node.js require:** This only loads agent-created libraries by name. It cannot load npm packages, file paths, or Node.js built-ins.

### `browser`

Headless Chromium via Playwright running on the server. Shares the same browser context as the `browser_*` meta-tools — if the LLM navigated to a page before calling your tool, that page is still open.

```typescript
browser.navigate(url: string, options?: {
  wait_until?: 'load' | 'domcontentloaded' | 'networkidle'
}): Promise<{ url: string, title: string, status: number }>

browser.screenshot(options?: {
  selector?: string
  full_page?: boolean
}): Promise<{ image: string /* base64 */, width: number, height: number }>

browser.click(selector: string): Promise<void>

browser.type(selector: string, text: string, options?: {
  clear_first?: boolean
}): Promise<void>

browser.extractText(selector?: string): Promise<string>

browser.extractHtml(selector?: string, options?: {
  outer?: boolean
}): Promise<string>

browser.evaluate(code: string): Promise<any>

browser.close(): Promise<void>
```

### `secrets`

Read-only object containing stored secrets (API keys, tokens). Keys are set by the user through the settings UI, never by the agent itself.

```typescript
// Example usage
const apiKey = secrets.OPENWEATHER_API_KEY
const resp = await fetch(`https://api.openweathermap.org/data/2.5/weather?appid=${apiKey}&q=London`)
```

### Utilities

| Function | Description |
|----------|-------------|
| `btoa(data)` | Base64 encode a string |
| `atob(data)` | Base64 decode a string |
| `parseCSV(text, options?)` | Parse CSV text into rows. With `{ header: true }`, returns objects keyed by header names. |
| `setTimeout(fn, ms)` | Schedule a callback. Max delay is capped at 30s. |
| `clearTimeout(id)` | Cancel a scheduled timeout. |

---

## What's NOT available

- `import` — no ES module syntax (use `require()` for agent libraries)
- `process`, `Buffer`, `__dirname`, `__filename` — no Node.js globals
- `fs`, `child_process`, `net`, `os` — no Node.js built-ins
- `XMLHttpRequest`, `WebSocket` — use `fetch` instead
- `eval`, `Function` constructor — blocked in the isolate
- Direct Playwright API — use the `browser` wrapper instead

## Execution limits

| Limit | Default |
|-------|---------|
| Execution timeout | 30 seconds |
| Memory | 128 MB per isolate |
| `require()` max depth | 10 (nested library requires) |
| `db.sql` query timeout | 5 seconds |
| `db.sql` max rows returned | 1000 |
| `fetch` timeout | 30 seconds |
| `setTimeout` max delay | 30 seconds |
