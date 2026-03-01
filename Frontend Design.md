# Frontend Design

React + Vite + Bootstrap 5. No CSS-in-JS. The UI has two levels: a **session list** and the **session view** (chat + canvas).

---

## Top-Level Layout

```
+-----------------------------------------------------+
|  Metaclaw                    [+ New Session]  [gear] |
+------------+----------------------------------------+
|            |                                        |
|  Sessions  |   Session View                         |
|            |                                        |
|  > Today   |   (chat, canvas, or both — see below)  |
|    Sess 1  |                                        |
|    Sess 2  |                                        |
|            |                                        |
|  > Earlier |                                        |
|    Sess 3  |                                        |
|    Sess 4  |                                        |
|            |                                        |
+------------+----------------------------------------+
```

The session sidebar is collapsible on narrow screens. Each session shows a title (auto-generated from first message or agent-assigned) and a short timestamp. Active sessions could show a subtle indicator.

---

## Session View

This is where it gets interesting. A session needs to show **chat** and sometimes also show **rendered components** (from `render_and_wait`, `render_blocks`, or navigating to an agent-created page). The question is how these coexist.

### Option A: Side-by-side split

```
+----------------------------+---------------------------+
|  Chat                      |  Canvas                   |
|                            |                           |
|  User: Show me a map of    |  +---------------------+  |
|  my bookmarked places      |  |                     |  |
|                            |  |   [Map component]   |  |
|  Agent: Here's a map with  |  |                     |  |
|  your 12 bookmarks.        |  +---------------------+  |
|                            |                           |
|  [input box]               |                           |
+----------------------------+---------------------------+
```

Canvas panel is hidden when empty, expands when the agent renders something. Chat stays visible so you can keep talking while looking at the component. This is the Claude Artifacts / ChatGPT Canvas pattern.

**Pro:** Chat context is always visible. Natural for "show me X" workflows.
**Con:** Horizontal space pressure. Components that want full width (dashboards, tables) feel cramped.

### Option B: Chat with canvas overlay/takeover

Chat is the default view. When the agent renders a component, it takes over the main area with a floating "back to chat" button or a minimized chat drawer at the bottom.

```
+------------------------------------------------+
|  [< Chat]                           Session 1  |
|                                                 |
|  +-------------------------------------------+  |
|  |                                           |  |
|  |        [Full-width component]             |  |
|  |                                           |  |
|  +-------------------------------------------+  |
|                                                 |
|  [Minimized chat: "Type a message..."]          |
+------------------------------------------------+
```

**Pro:** Components get full width. Better for dashboards, forms, data-heavy UIs.
**Con:** Lose chat context when viewing a component. Switching back and forth is friction.

### Option C: Hybrid — collapsible chat sidebar

Chat is a right-side panel that can be collapsed. The main area is the canvas. When there's nothing rendered, chat expands to fill the space.

```
Nothing rendered:               Component rendered:
+----------------------------+  +-----------------------+-------+
|                            |  |                       | Chat  |
|  Chat (full width)         |  |  [Component]          | ...   |
|                            |  |                       | ...   |
|  User: Hello               |  |                       | ...   |
|  Agent: Hi! How can I      |  |                       |       |
|  help?                     |  |                       | [__]  |
|                            |  |                       |       |
|  [input box]               |  +-----------------------+-------+
+----------------------------+
```

**Pro:** Best of both — full-width chat when it's just conversation, full-width canvas with chat accessible when needed.
**Con:** The layout shift when a component appears could be jarring.

### Current leaning: Option A with a maximise button

Start with side-by-side. Add a maximise button on the canvas panel that expands it to full width (with a small floating chat toggle to get back). This covers the common case (chat + component visible) and the escape hatch (full-width dashboard).

---

## Chat Panel

Standard message list:

- **User messages** — right-aligned bubbles or left-aligned with distinct styling
- **Assistant messages** — rendered as markdown
- **Tool calls** — shown as collapsible "steps" between messages (tool name + short result preview)
- **Collapsed tasks** — when the agent calls `end_task`, the intermediate messages are replaced with a summary block. See below.
- **Pending interactions** — when the agent calls `ask_user`, the chat shows the question with buttons or a text input inline

### `ask_user` rendering

```
+----------------------------------------------+
|  Agent: What format would you like?          |
|                                              |
|  [CSV]  [JSON]  [Excel]                      |
|                                              |
|  — or —                                      |
|                                              |
|  Agent: What's the project name?             |
|  [________________________] [Send]           |
+----------------------------------------------+
```

If `options` are provided, render as buttons. Otherwise render as a text input.

### Collapsed task rendering

When the agent calls `end_task`, the intermediate messages (tool calls, results, assistant reasoning) are collapsed in the chat. They're replaced with a summary block that can be expanded to review the detail:

```
+----------------------------------------------+
|  ┌─ Task: Analyze Sheet1                     |
|  │  Found $45K discrepancy — duplicate EMEA  |
|  │  rows 251-267. Removed 17 rows. Totals    |
|  │  now match.                               |
|  │  [▶ Show 9 steps]                         |
|  └─                                          |
+----------------------------------------------+
```

Clicking "Show N steps" expands the block to show the original messages as they appeared during execution. The collapsed messages are archived in the session data, not deleted — the UI controls visibility, and the LLM sees only the summary.

Nested tasks show nested collapsible blocks when expanded.

### File attachments

The chat input area supports file attachments:

- **Attachment button** next to the text input — opens a native file picker
- **Drag-and-drop** on the message input area — visual drop zone with highlight
- Attached files upload immediately to `POST /api/files/upload` and appear as chips below the input
- When the message is sent, file IDs are included alongside the text so the agent knows files were attached

Agent-created files appear in the chat stream as download cards (filename, size, type icon, download button). These are triggered by `file:created` SSE events. Modified files show an "updated" indicator via `file:modified` events.

On Chromium browsers, a "Save to disk" option using the File System Access API can be offered as a progressive enhancement alongside the standard download.

### `send_message` rendering

Messages from `send_message` (the non-pausing tool) appear as regular assistant messages in the chat stream. They should be visually indistinguishable from normal responses — the user doesn't need to know the difference.

---

## Canvas Panel

Renders whatever the agent has put up:

1. **`render_and_wait` output** — a React component (by name or inline code), compiled with Sucrase, wrapped in an error boundary
2. **`render_blocks` output** — structured blocks (markdown, table, chart, form, etc.) rendered with pre-built components
3. **Agent-created pages** — stored components from `agent_ui_components` that persist as "pages" accessible from nav

### Error handling

Every rendered component is wrapped in a React error boundary that shows:
- The error message
- A "Show source" toggle that reveals the component code
- A "Dismiss" button that closes the canvas and returns the error to the agent

### Canvas toolbar

Small toolbar above the rendered component:

```
[Component Name / "Inline Component"]  [Maximise] [Dismiss]
```

---

## Page Navigation

The agent can create persistent UI components (via `create_ui_component`) that act as "pages." These appear as tabs or nav items.

```
+-----------------------------------------------------+
|  [Chat]  [Dashboard]  [Bookmarks]  [+]       [gear] |
+-----------------------------------------------------+
```

- **Chat** is always the first tab
- Agent-created pages appear as additional tabs
- Clicking a tab renders that stored component in the main area
- Pages can use `useAgentState` for live data and `sendMessage` to talk to the agent

> **Open question:** Should pages be top-level (visible across sessions) or per-session? They're stored globally in `agent_ui_components`, so they're inherently cross-session. But if a page uses `callTool`, which session does that go to?

---

## Settings Panel

Accessed via the gear icon. Could be a slide-over drawer or a separate page.

Sections:
- **System prompt** — read-only view with an edit button. Shows the full prompt including agent-appended observations. (Or let the agent handle edits?)
- **Tools** — list of agent-created tools with name, description, enabled/disabled toggle. Click to view code.
- **Libraries** — list of agent-created libraries with name, description. Click to view code.
- **Scheduled tasks** — list of all system-level scheduled tasks. Each shows name, task prompt, schedule (cron expression or one-shot time), next run, last run, model, enabled/disabled toggle. User can create, edit, pause, resume, and delete tasks directly from here.
- **Skills** — list of agent and user-created skills with name, title, description, source badge (user/agent), enabled/disabled toggle. Click to view full markdown content. Create/edit/delete buttons. See [Skills](./Skills.md).
- **Secrets** — manage API keys (add/edit/delete). Values are masked.
- **Files** — file workspace browser. Lists all files with name, size, type, source, date. Download, delete, upload buttons. Shows total workspace usage vs limit.
- **Database** — basic stats (table count, total size). Maybe a simple query runner for debugging.
- **History** — version history of system prompt changes with diff view and rollback

> **Open question:** Should the user be able to edit the system prompt directly from settings, or should that be agent-only? There's an argument for giving the user a "hard override" that the agent can't undo, but that complicates the versioning model.

---

## Shared State and Multi-Session Weirdness

Sessions are independent conversations, but they share:
- `agent_config` (system prompt, learned notes)
- `agent_tools`
- `agent_ui_components`
- `agent_skills`
- `agent_files` (file workspace)
- `agent_state`
- `agent_data.db`

This means:
1. Session A creates a tool. Session B can immediately use it.
2. Session A modifies the system prompt. Session B won't see the change until its next compaction.
3. Session A writes to `state.set('counter', 5)`. Session B reads `state.get('counter')` and gets 5.
4. Both sessions write to the same state key — last write wins, no conflict resolution.

### How bad is this?

For a single-user personal agent, probably fine in practice. You're unlikely to be running two sessions simultaneously *and* have them stomp on each other's state. The main risk is confusion, not data corruption.

### Mitigations to consider

- **Visual indicator:** Show a badge on the session if shared resources were modified by another session since the conversation started. Something like "Tools changed since this session started" as a dismissable banner.
- **System prompt staleness:** When shared config changes, the active session's system prompt is stale until compaction. We could force a mid-conversation system prompt refresh when config changes are detected, but that adds complexity.
- **Optimistic locking on tools:** `update_tool` could check the version number and fail if someone else modified it. Probably overkill for single-user.

> **Open question:** Is it worth adding any multi-session protection, or just accept last-write-wins and move on? The single-user nature of this makes the risk low.

---

## `render_blocks` in Chat vs Canvas

When the agent calls `render_blocks`, where do the blocks appear?

**Option 1: Always in the canvas.** Consistent with `render_and_wait`. The chat shows "Agent rendered a table" or similar placeholder.

**Option 2: Inline in chat for simple blocks, canvas for complex ones.** A single markdown block or alert could render inline. A table + chart + form combo goes to the canvas.

**Option 3: Always inline in the chat stream.** Blocks are just rich chat messages. No canvas involvement.

> **Open question:** The distinction between "this is a chat message with a table in it" and "this is a full canvas render" is fuzzy. Need to pick a rule. Current leaning: `render_blocks` goes to canvas (since it pauses for interaction, and forms need a clear submit target). Simple data display that doesn't need interaction should just go in a normal assistant message as markdown.

---

## Real-Time Sync (SSE + REST)

The frontend needs live updates from multiple concurrent sessions, sub-sessions, state changes, and component changes. The approach: **SSE for server→client push, REST for client→server actions.**

### Why SSE over WebSocket

- `EventSource` handles reconnection automatically — no heartbeat/ping-pong logic
- Client→server traffic is infrequent (send message, answer question, submit form) — a regular POST is fine
- Single SSE connection per browser tab, not per session. Events are tagged with `session_id`.
- Simpler server implementation — just write to a response stream

### SSE connection

The client opens one connection to `GET /events`. The server pushes events as they happen across all sessions:

```
event: session:status
data: {"id":"sess_123","status":"running"}

event: session:stream
data: {"id":"sess_123","delta":"Here's what I"}

event: session:message
data: {"id":"sess_123","message":{"role":"assistant","content":"Here's what I found."}}

event: session:tool_call
data: {"id":"sess_123","tool_call_id":"tc_456","name":"fetch_url","status":"running"}

event: session:tool_call
data: {"id":"sess_123","tool_call_id":"tc_456","name":"fetch_url","status":"complete"}

event: session:pending_input
data: {"id":"sess_123","tool_call_id":"tc_789","name":"ask_user","args":{"question":"Which format?","options":["CSV","JSON"]}}

event: session:spawned
data: {"id":"sub_abc","parent_id":"sess_123","task":"Research topic A","status":"running"}

event: session:completed
data: {"id":"sub_abc","parent_id":"sess_123"}

event: state:change
data: {"key":"counter","value":42}

event: component:change
data: {"name":"Dashboard","action":"updated"}

event: sessions:list
data: {"action":"created","id":"sess_new"}

event: file:created
data: {"id":"f_abc123","name":"report.xlsx","size":45200,"mime_type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","source_session_id":"sess_123"}

event: file:modified
data: {"id":"f_abc123","name":"report.xlsx","size":46100,"modified_on":"2026-02-25T14:30:00Z"}

event: file:deleted
data: {"id":"f_abc123"}

event: skill:change
data: {"name":"quarterly-reports","action":"created"}
```

### REST endpoints (client→server)

User actions go through normal REST calls. These don't need a persistent connection.

| Action | Method | Endpoint |
|--------|--------|----------|
| Send a message | POST | `/sessions/:id/message` |
| Respond to ask_user / render_and_wait | POST | `/sessions/:id/tool-response` |
| Create a new session | POST | `/sessions` |
| Continue after token limit | POST | `/sessions/:id/continue` |
| Read a state value | GET | `/state/:key` |
| Write a state value | POST | `/state/:key` |
| Upload a file | POST | `/files/upload` (multipart/form-data) |
| Download a file | GET | `/files/:id/download` |
| List files | GET | `/files` |
| Delete a file | DELETE | `/files/:id` |

### Client-side architecture

One SSE connection feeds multiple stores. Each store subscribes to the event types it cares about.

```
SSE Connection (GET /events)
  │
  ├─ SessionListStore
  │    ← session:status, sessions:list, session:spawned, session:completed
  │    Updates sidebar: status badges, sub-session nesting, new sessions
  │
  ├─ ActiveSessionStore
  │    ← session:stream, session:message, session:tool_call, session:pending_input
  │    Updates the chat panel and canvas for the currently viewed session
  │    Filters by the active session ID
  │
  ├─ FileStore
  │    ← file:created, file:modified, file:deleted
  │    Updates file download cards in chat, file browser in settings
  │
  ├─ StateStore
  │    ← state:change
  │    Feeds useAgentState hooks in rendered components
  │
  └─ ComponentStore
       ← component:change, skill:change
       Updates page tabs when components are created/updated/deleted
```

### How `useAgentState` stays live

1. On mount, the hook fetches the current value via `GET /state/:key`
2. It subscribes to `state:change` events for its key via the StateStore
3. When a change arrives (from any session, sub-session, or sandbox code), the hook updates automatically
4. Writes go through `POST /state/:key` — the server emits a `state:change` event, which updates all other subscribers

No polling.

### How streaming works

When the LLM is producing tokens for a session:

1. Server emits `session:stream` events with token deltas
2. The ActiveSessionStore appends deltas to a buffer, re-rendering the chat in real time
3. When the LLM finishes, server emits `session:message` with the complete message — the client replaces the streaming buffer with the final version

If the user switches to a different session mid-stream, the stream events still flow (they're session-tagged), but the ActiveSessionStore ignores events for non-active sessions. Switching back shows the accumulated messages.

### How sub-sessions appear

When a session spawns a sub-session:

1. Server emits `session:spawned` — the sidebar shows the sub-session nested under its parent
2. Sub-session status updates flow via `session:status` — the sidebar shows running/waiting/completed
3. If a sub-session is `waiting_for_input`, the sidebar shows an indicator. The user clicks into it, sees the question, and responds.
4. When the sub-session calls `report_result`, server emits `session:completed` — the parent session resumes (its `wait_for_sessions` resolves), and the sidebar updates.

### Server-side implementation

The server maintains a set of active SSE connections (one per browser tab). Internal components emit events via an in-process `EventEmitter`:

```
Agent Loop    → "session:message", "session:status", "session:stream"
Meta-tools    → "session:tool_call", "session:pending_input"
State Store   → "state:change"
Component DB  → "component:change"
Scheduler     → "session:status" (when a task fires and a session starts running)
Sub-sessions  → "session:spawned", "session:completed"
        ↓
   EventEmitter
        ↓
   SSE Handler → writes to all connected response streams
```

No external message broker needed. It's all in-process because it's a single Node.js server for a single user.

---

## Responsive / Mobile

Not a priority for v1, but some ground rules:
- Session sidebar collapses to a hamburger menu on narrow screens
- Side-by-side chat+canvas stacks vertically on mobile (chat on top, canvas below, or tabs)
- Touch targets need to be big enough for component interactions

---

## Component Library (injected into agent-authored components)

These are the pre-built UI primitives available via dependency injection. They should be thin wrappers around Bootstrap 5 + a couple of heavier libraries.

| Component | Wraps | Notes |
|-----------|-------|-------|
| `Card` | Bootstrap card | title, body, footer slots |
| `Table` | Bootstrap table | columns + data props, optional sorting |
| `Button` | Bootstrap button | variant, size, onClick |
| `Alert` | Bootstrap alert | variant, dismissible |
| `Badge` | Bootstrap badge | variant, pill |
| `Tabs` | Bootstrap nav-tabs | controlled, tab panes as children |
| `Form` | HTML form | onSubmit handler |
| `TextInput` | Bootstrap form-control | label, value, onChange, validation |
| `Select` | Bootstrap form-select | options, value, onChange |
| `DatePicker` | Native `<input type="date">` | Upgrade to a library later if needed |
| `Toggle` | Bootstrap form-check switch | label, checked, onChange |
| `Spinner` | Bootstrap spinner | size variant |
| `CodeBlock` | `<pre>` with syntax highlighting | language prop |
| `Chart` | Recharts | type (line/bar/pie/area), data, config |
| `Map` | react-leaflet | center, zoom, markers, layers |
| `Markdown` | react-markdown | content prop |
| `Stack` | Flex column | gap, align |
| `Grid` | Bootstrap row/col | responsive column layout |
| `Icon` | lucide-react | name prop maps to icon |
| `Modal` | Bootstrap modal | title, body, footer, open/onClose |

Plus the communication hooks:

| Hook/Function | Description |
|---------------|-------------|
| `useAgentState(key)` | `[value, setValue]` — reads `agent_state` via REST on mount, stays live via SSE `state:change` events. Writes via REST. No LLM. |
| `callTool(action, payload)` | Sends a `toolResponse` to the pending `render_and_wait` call. Resumes the LLM. |
| `sendMessage(text)` | Sends a `userMessage`. Equivalent to typing in the chat box. |
| `importModule(pkg)` | Dynamic CDN import via esm.sh. Returns the module. Cached. |
| `loadStylesheet(url)` | Injects a `<link>` tag. Deduplicates by URL. |
