# Technology Choices

## Server

| Layer | Choice | Notes |
|-------|--------|-------|
| Runtime | **Node.js + TypeScript** | |
| HTTP | **Express** | Minimal, well-understood |
| Database | **SQLite via better-sqlite3** | Single-file, zero-config, synchronous API. Sufficient for single-user. Use in-process EventEmitter for change notifications instead of Postgres LISTEN/NOTIFY. |
| Sandbox | **isolated-vm** | V8 isolate for running agent-created tool code. Already proven in the monorepo. |
| Browser | **Playwright** (headless Chromium) | Server-side only. Browser context per conversation. |
| File handling | **multer** (uploads), **file-type** (MIME detection) | Express multipart middleware + magic-byte detection |
| Spreadsheets | **ExcelJS** | Read/write .xlsx with formatting, formulas, streaming |
| PDFs | **pdf-lib** (edit) + **pdfjs-dist** (extract) | Creation/modification and text extraction are separate concerns |
| Images | **sharp** | Fast resize/crop/convert via libvips |
| Web reading | **@mozilla/readability** + **linkedom** + **turndown** | Fetch → DOM parse → content extract → markdown conversion |
| Package manager | **pnpm** | Workspaces for server + client |

## LLM Integration

| Layer | Choice | Notes |
|-------|--------|-------|
| SDK | **Vercel AI SDK (`ai`)** | Provider-agnostic. Handles streaming, tool calling, multi-step agent loops. |
| Schemas | **Zod** | Meta-tools defined with Zod; AI SDK converts to JSON Schema for the LLM. Agent-created tools store raw JSON Schema in the DB and are passed via `jsonSchema()` from the AI SDK. |
| Default model | **Claude Sonnet** (via `@ai-sdk/anthropic`) | Can swap providers without code changes thanks to the AI SDK abstraction. |

### How tool schemas work with the AI SDK

Meta-tools (built-in) use Zod directly:

```typescript
import { tool } from 'ai'
import { z } from 'zod'

const editSystemPrompt = tool({
  description: 'Replace the system prompt',
  parameters: z.object({
    prompt: z.string().describe('The new system prompt text'),
  }),
  execute: async ({ prompt }) => { /* ... */ },
})
```

Agent-created tools (from `agent_tools` table) store JSON Schema and use the AI SDK's `jsonSchema()` wrapper:

```typescript
import { tool, jsonSchema } from 'ai'

const dynamicTool = tool({
  description: row.description,
  parameters: jsonSchema(row.parameter_schema),
  execute: async (args) => { /* run in isolated-vm */ },
})
```

Both are merged into a single `tools` object passed to `generateText()` / `streamText()`.

## Client

| Layer | Choice | Notes |
|-------|--------|-------|
| Framework | **React 19 + Vite** | |
| CSS | **Bootstrap 5** | Utility classes + prebuilt component styles. No CSS-in-JS overhead. |
| JSX compilation | **Sucrase** | Compiles agent-authored JSX/TS at runtime in the browser. Fast, no full Babel needed. |
| Pre-bundled UI libs | Recharts, react-leaflet, react-markdown, lucide-react, date-fns | Covers charts, maps, markdown, icons, dates. Available as injected deps. |
| Dynamic imports | **esm.sh** CDN | Escape hatch for libraries not in the pre-bundled set. `importModule('pkg')` wraps `import('https://esm.sh/pkg?external=react,react-dom')` with caching. |
| Real-time | **SSE** (Server-Sent Events) | Single connection per browser tab. Server pushes session updates, streaming tokens, state changes. Client→server uses REST. |

## What's NOT used

| Avoided | Why |
|---------|-----|
| PostgreSQL | Overkill for single-user. SQLite is portable, zero-ops, single-file backup. |
| Docker (for dev) | Unnecessary without Postgres. Just `pnpm install && pnpm dev`. |
| ORM | better-sqlite3's synchronous API is simple enough. Raw SQL with a thin helper layer. |
| iframe sandbox for UI | Personal-use app — agent components run in the React tree directly. Error boundaries are the only safety net. |
| WebSocket | SSE is simpler (auto-reconnect, no ping/pong), and client→server traffic is infrequent enough for REST. |
