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
- **System prompt** — read-only view with an edit button (or let the agent handle edits?)
- **Learned notes** — read-only view
- **Tools** — list of agent-created tools with name, description, enabled/disabled toggle. Click to view code.
- **Secrets** — manage API keys (add/edit/delete). Values are masked.
- **Database** — basic stats (table count, total size). Maybe a simple query runner for debugging.
- **History** — version history of system prompt changes with diff view and rollback

> **Open question:** Should the user be able to edit the system prompt directly from settings, or should that be agent-only? There's an argument for giving the user a "hard override" that the agent can't undo, but that complicates the versioning model.

---

## Shared State and Multi-Session Weirdness

Sessions are independent conversations, but they share:
- `agent_config` (system prompt, learned notes)
- `agent_tools`
- `agent_ui_components`
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
| `useAgentState(key)` | `[value, setValue]` — reads/writes `agent_state` directly via REST. No LLM. |
| `callTool(action, payload)` | Sends a `toolResponse` to the pending `render_and_wait` call. Resumes the LLM. |
| `sendMessage(text)` | Sends a `userMessage`. Equivalent to typing in the chat box. |
| `importModule(pkg)` | Dynamic CDN import via esm.sh. Returns the module. Cached. |
| `loadStylesheet(url)` | Injects a `<link>` tag. Deduplicates by URL. |
