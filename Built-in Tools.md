# Built-in Tools (Meta-Tools)

These tools are always available to the LLM. They are hardcoded in `PersonalAgentImplementation` and never appear in the `agent_tools` table. Parameters are defined with Zod in code; the JSON Schemas below represent what the LLM receives.

---

## Session Lifecycle

A session is a durable conversation. It doesn't require anyone to be watching — the agent can run, produce output, and go idle. The user sees everything when they open the session later.

### Agent loop

Each "step" runs this loop:

1. Something wakes the session: a user message, a scheduled task firing, or a user interacting with a pending UI (tool response).
2. The LLM is called with the conversation history.
3. The LLM responds with either:
  - **Text only** → the text is added to the history, the loop ends, session goes **idle**.
  - **Tool calls** → each tool is executed, results are added to the history, go to step 2.
  - **A tool call with `asPendingToolCall`** (e.g. `render_and_wait`, `ask_user`) → the session goes **waiting_for_input**. The loop pauses until the user responds.

### Session states


| State                 | Meaning                                                             | What wakes it                                               |
| --------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------- |
| `idle`                | Not processing, but can be woken. May have pending reminders.       | User message, reminder firing                               |
| `running`             | The LLM is being called or tools are executing.                     | (internal — loop is active)                                 |
| `waiting_for_input`   | A pending tool call is waiting for the user or for sub-sessions.    | User interacts with the rendered UI, answers a question, or sub-sessions complete (`wait_for_sessions`) |
| `completed`           | Finished. Terminal state — cannot be woken.                         | (nothing — session is done)                                 |
| `error`               | The session crashed or timed out. Terminal state.                   | (nothing — session is done)                                 |
| `token_limit_reached` | The session hit its token cap mid-step.                             | User clicks "Continue" in the UI to extend the limit        |


The agent goes `idle` naturally when the LLM produces a text response without tool calls. `idle` means "not doing anything right now, but could be woken later" — by a user message, a reminder, etc. Scheduled tasks are a separate system-level concept — they create fresh sessions rather than waking existing ones.

`completed` is a terminal state. For sub-sessions, this is set by calling `report_result` — the sub-session explicitly declares "I'm done, here are my results." For top-level sessions, `completed` can be set by the user archiving the conversation from the UI.

### Sub-sessions

Sessions can spawn sub-sessions via `spawn_session`. A sub-session is a full session with its own conversation history, linked to its parent by `parent_session_id`. Sub-sessions appear in the UI nested under their parent. They have full access to all shared resources and can interact with the user (the UI shows them as waiting for input, and the user can click into them). See the **Sub-Sessions** section below for tool details.

### Token limits

Every session has a token cap — the maximum tokens (input + output) it can consume before being stopped. This prevents runaway costs from agent loops that go too deep.

- **System-wide default** applies to all sessions (configurable in server settings).
- **Sub-sessions** can be given a tighter limit by the parent via the `token_limit` parameter on `spawn_session`.
- **User override**: when any session (top-level or sub) hits its limit, the UI shows a "Continue" button that extends the limit and resumes processing.

---

## Self-Modification

The agent's identity is stored as a single **system prompt** document — behavioral instructions, preferences, and accumulated observations all live here. The prompt typically has a core section (written at setup) and an agent-managed section where the agent appends things it learns ("user prefers dark mode", "timezone is EST"). For structured knowledge — procedures, standards, domain knowledge — the agent creates skills instead (see [Skills](./Skills.md)).

> **Note:** The system prompt is in the LLM's context, but after mid-conversation edits the context still holds the old version until compaction. Use `read_system_prompt` to get the current stored version before making surgical edits.

Every edit saves the previous version to `agent_config_history` for rollback.

### `read_system_prompt`

```json
{
  "name": "read_system_prompt",
  "parameters": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

**Returns:** `{ prompt: string, version: number }`

### `edit_system_prompt`

Supports multiple edit operations so the agent doesn't have to replace the entire prompt for small changes.

```json
{
  "name": "edit_system_prompt",
  "parameters": {
    "type": "object",
    "properties": {
      "operation": {
        "type": "string",
        "enum": ["replace", "find_replace", "append", "prepend", "delete"],
        "description": "The type of edit to perform"
      },
      "content": {
        "type": "string",
        "description": "For replace: the new full prompt. For append/prepend: the text to add. For delete: the text to remove."
      },
      "find": {
        "type": "string",
        "description": "For find_replace: the exact substring to find"
      },
      "replace": {
        "type": "string",
        "description": "For find_replace: the replacement text"
      },
      "replace_all": {
        "type": "boolean",
        "description": "For find_replace: replace all occurrences instead of just the first. Default: false."
      }
    },
    "required": ["operation"]
  }
}
```


| Operation      | Required fields   | Behavior                                                                                                                       |
| -------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `replace`      | `content`         | Replace the entire prompt                                                                                                      |
| `find_replace` | `find`, `replace` | Replace first occurrence of `find` with `replace` (or all occurrences if `replace_all` is true). Fails if `find` is not found. |
| `append`       | `content`         | Add text to the end of the prompt                                                                                              |
| `prepend`      | `content`         | Add text to the beginning of the prompt                                                                                        |
| `delete`       | `content`         | Remove first occurrence of `content`. Fails if not found.                                                                      |


**Returns:** `{ version: number }`

---

## State Management

Key-value store backed by the `agent_state` table. Values are arbitrary JSON.

### `get_state`

```json
{
  "name": "get_state",
  "parameters": {
    "type": "object",
    "properties": {
      "key": { "type": "string", "description": "The state key to read" }
    },
    "required": ["key"]
  }
}
```

**Returns:** `{ value: any | null }` — `null` if the key doesn't exist.

### `set_state`

```json
{
  "name": "set_state",
  "parameters": {
    "type": "object",
    "properties": {
      "key": { "type": "string", "description": "The state key to write" },
      "value": { "description": "Any JSON-serializable value" }
    },
    "required": ["key", "value"]
  }
}
```

**Returns:** `{ ok: true }`

### `delete_state`

```json
{
  "name": "delete_state",
  "parameters": {
    "type": "object",
    "properties": {
      "key": { "type": "string", "description": "The state key to delete" }
    },
    "required": ["key"]
  }
}
```

**Returns:** `{ deleted: boolean }` — `false` if the key didn't exist.

### `list_state_keys`

```json
{
  "name": "list_state_keys",
  "parameters": {
    "type": "object",
    "properties": {
      "prefix": { "type": "string", "description": "Optional prefix to filter keys by" }
    },
    "required": []
  }
}
```

**Returns:** `{ keys: string[] }`

---

## Database

The agent has its own SQLite database (`agent_data.db`), separate from the app's internal database. It can create tables, insert data, and run SQL queries. This is for structured data storage and analysis — things the key-value store can't handle well (filtering, joining, aggregating).

**Guardrails:** Query timeout (5s), max 1000 rows returned, max 100MB database size, `ATTACH DATABASE` is blocked.

### `db_sql`

Run any SQL against the agent's database. Auto-detects reads vs writes: SELECT/WITH/EXPLAIN return rows; everything else (CREATE, INSERT, UPDATE, DELETE, etc.) returns a change count.

```json
{
  "name": "db_sql",
  "parameters": {
    "type": "object",
    "properties": {
      "sql": { "type": "string", "description": "SQL to execute" },
      "params": {
        "type": "array",
        "items": {},
        "description": "Positional bind parameters for ? placeholders"
      }
    },
    "required": ["sql"]
  }
}
```

**Returns (for SELECT):** `{ columns: string[], rows: any[][], row_count: number, truncated: boolean }`

**Returns (for writes):** `{ changes: number, last_insert_rowid: number }`

### `db_schema`

List all tables in the agent's database with their column definitions. Essential for the agent to remember what it's already created.

```json
{
  "name": "db_schema",
  "parameters": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

**Returns:** `{ tables: { name: string, columns: { name: string, type: string, notnull: boolean, pk: boolean }[], row_count: number }[] }`

---

## Tool Management

CRUD operations on agent-defined tools stored in `agent_tools`.

### `create_tool`

```json
{
  "name": "create_tool",
  "parameters": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "Unique snake_case tool name" },
      "description": { "type": "string", "description": "Human-readable description shown in the tool list" },
      "parameter_schema": {
        "type": "object",
        "description": "JSON Schema defining the tool's parameters"
      },
      "code": { "type": "string", "description": "JavaScript code to execute in isolated-vm. Receives `args` (validated params) and `state` (get/set helpers) as globals. Must return a value or call `resolve(value)`." }
    },
    "required": ["name", "description", "parameter_schema", "code"]
  }
}
```

**Returns:** `{ name: string, version: 1 }`

### `update_tool`

Partial update — only the provided fields are changed.

```json
{
  "name": "update_tool",
  "parameters": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "Name of the tool to update" },
      "description": { "type": "string" },
      "parameter_schema": { "type": "object" },
      "code": { "type": "string" }
    },
    "required": ["name"]
  }
}
```

**Returns:** `{ name: string, version: number }`

### `delete_tool`

```json
{
  "name": "delete_tool",
  "parameters": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "Name of the tool to delete" }
    },
    "required": ["name"]
  }
}
```

**Returns:** `{ deleted: boolean }`

### `enable_tool` / `disable_tool`

Toggle whether a tool appears in the active tool set.

```json
{
  "name": "enable_tool",
  "parameters": {
    "type": "object",
    "properties": {
      "name": { "type": "string" }
    },
    "required": ["name"]
  }
}
```

```json
{
  "name": "disable_tool",
  "parameters": {
    "type": "object",
    "properties": {
      "name": { "type": "string" }
    },
    "required": ["name"]
  }
}
```

**Returns:** `{ name: string, enabled: boolean }`

### `list_tools`

```json
{
  "name": "list_tools",
  "parameters": {
    "type": "object",
    "properties": {
      "include_disabled": { "type": "boolean", "description": "Include disabled tools in the list. Default: false." }
    },
    "required": []
  }
}
```

**Returns:** `{ tools: { name, description, enabled, version }[] }`

### `read_tool`

Returns the full definition including code and parameter schema.

```json
{
  "name": "read_tool",
  "parameters": {
    "type": "object",
    "properties": {
      "name": { "type": "string" }
    },
    "required": ["name"]
  }
}
```

**Returns:** `{ name, description, parameter_schema, code, enabled, version }`

---

## Libraries

Shared code modules stored in `agent_libraries`. Tools and `run_sandbox_code` load them via `require('name')` in the sandbox. Libraries can require other libraries. This is the mechanism for building up reusable code — utilities, API wrappers, data transformers, etc.

### `create_library`

```json
{
  "name": "create_library",
  "parameters": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "Unique library name (snake_case)" },
      "description": { "type": "string", "description": "What this library provides" },
      "code": { "type": "string", "description": "CommonJS module code. Export via `exports.foo = ...` or `module.exports = ...`. Can `require()` other libraries." }
    },
    "required": ["name", "description", "code"]
  }
}
```

**Returns:** `{ name: string, version: 1 }`

### `update_library`

```json
{
  "name": "update_library",
  "parameters": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "Name of the library to update" },
      "description": { "type": "string" },
      "code": { "type": "string" }
    },
    "required": ["name"]
  }
}
```

**Returns:** `{ name: string, version: number }`

### `delete_library`

```json
{
  "name": "delete_library",
  "parameters": {
    "type": "object",
    "properties": {
      "name": { "type": "string" }
    },
    "required": ["name"]
  }
}
```

**Returns:** `{ deleted: boolean }`

### `list_libraries`

```json
{
  "name": "list_libraries",
  "parameters": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

**Returns:** `{ libraries: { name, description, version }[] }`

### `read_library`

```json
{
  "name": "read_library",
  "parameters": {
    "type": "object",
    "properties": {
      "name": { "type": "string" }
    },
    "required": ["name"]
  }
}
```

**Returns:** `{ name, description, code, version }`

---

## Code Execution

### `run_sandbox_code`

Execute ad-hoc JavaScript in isolated-vm. For quick exploration, data transformation, or testing logic before committing it to a tool. Has the same runtime context as user-created tools (fetch, state helpers, console).

```json
{
  "name": "run_sandbox_code",
  "parameters": {
    "type": "object",
    "properties": {
      "code": { "type": "string", "description": "JavaScript code to execute. Must return a value or call `resolve(value)`." }
    },
    "required": ["code"]
  }
}
```

**Returns:** `{ result: any, logs: string[] }` — `logs` contains anything written to `console.log/warn/error`.

---

## LLM Generation

A lightweight way to make a single LLM call without the overhead of a full sub-session. Useful for classification, extraction, summarization, translation, and batch processing where each item needs a small amount of reasoning.

For full agent loops with tool access and conversation history, use sub-sessions instead (`spawn_session`).

### `llm_generate`

```json
{
  "name": "llm_generate",
  "parameters": {
    "type": "object",
    "properties": {
      "prompt": { "type": "string", "description": "The prompt to send to the LLM" },
      "system": { "type": "string", "description": "Optional system prompt for the call" },
      "intelligence": {
        "type": "string",
        "enum": ["low", "medium", "high"],
        "description": "Model capability level. 'low' is cheap/fast (classification, extraction), 'medium' is the default workhorse, 'high' is the most capable. Default: low."
      },
      "schema": {
        "type": "object",
        "description": "JSON Schema for structured output. When provided, the LLM is constrained to return valid JSON matching this schema."
      },
      "max_tokens": { "type": "number", "description": "Max output tokens. Default: 4096." },
      "temperature": { "type": "number", "description": "Sampling temperature (0-1). Default: 0." },
      "images": {
        "type": "array",
        "items": { "type": "string" },
        "description": "File IDs of images to include as vision inputs (from the file workspace)"
      }
    },
    "required": ["prompt"]
  }
}
```

**Returns:** `{ text: string, parsed?: any, usage: { input_tokens: number, output_tokens: number } }`

`parsed` is present when `schema` was provided — the JSON result already parsed into an object.

The `intelligence` parameter is an abstraction over model selection. The user configures which models map to which levels in settings (e.g. `low` → Claude Haiku, `medium` → Claude Sonnet, `high` → Claude Opus). The agent expresses intent; the user controls the cost/quality tradeoff.

Default intelligence is `low` — the assumption is that if you're using this tool, you want something cheap and fast. The main agent is already the expensive call; its sub-calls should be frugal unless specifically asked for more.

### Settings

| Setting | Description |
|---------|-------------|
| `llm.low` | Model for `intelligence: 'low'` (e.g. Claude Haiku, GPT-4o-mini) |
| `llm.medium` | Model for `intelligence: 'medium'` (e.g. Claude Sonnet) |
| `llm.high` | Model for `intelligence: 'high'` (e.g. Claude Opus) |

### When to use `llm_generate` vs sub-sessions

| Need | Use | Why |
|------|-----|-----|
| Quick classification, extraction, summarization | `llm_generate` | Single LLM call, no tool access, no conversation state |
| Complex multi-step reasoning with tool use | `spawn_session` | Full agent loop, tool access, own conversation history |
| Batch processing inside a tool | `llm.generate()` in sandbox | Each item gets a cheap LLM call inside tool code |

---

## UI Components

CRUD operations on reusable React components stored in `agent_ui_components`.

### `create_ui_component`

```json
{
  "name": "create_ui_component",
  "parameters": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "Unique component name" },
      "description": { "type": "string", "description": "What this component does" },
      "code": { "type": "string", "description": "React/JSX component code. Receives injected deps (React, hooks, UI primitives, useAgentState, callTool, sendMessage, importModule). Must `export default` the component." },
      "props_schema": { "type": "object", "description": "Optional JSON Schema describing expected props" }
    },
    "required": ["name", "description", "code"]
  }
}
```

**Returns:** `{ name: string, version: 1 }`

### `update_ui_component`

```json
{
  "name": "update_ui_component",
  "parameters": {
    "type": "object",
    "properties": {
      "name": { "type": "string" },
      "description": { "type": "string" },
      "code": { "type": "string" },
      "props_schema": { "type": "object" }
    },
    "required": ["name"]
  }
}
```

**Returns:** `{ name: string, version: number }`

### `delete_ui_component`

```json
{
  "name": "delete_ui_component",
  "parameters": {
    "type": "object",
    "properties": {
      "name": { "type": "string" }
    },
    "required": ["name"]
  }
}
```

**Returns:** `{ deleted: boolean }`

### `list_ui_components`

```json
{
  "name": "list_ui_components",
  "parameters": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

**Returns:** `{ components: { name, description, version }[] }`

### `read_ui_component`

Returns the full definition including code and props schema.

```json
{
  "name": "read_ui_component",
  "parameters": {
    "type": "object",
    "properties": {
      "name": { "type": "string" }
    },
    "required": ["name"]
  }
}
```

**Returns:** `{ name, description, code, props_schema, version }`

---

## UI Rendering

These tools display UI to the user. Tools marked **pauses** set `asPendingToolCall: true`, suspending the agent loop until the user interacts.

### `render_and_wait`

Render a React component (by stored name or inline code) in the canvas area. Pauses for user interaction; resumes when the component calls `callTool(action, payload)`.

```json
{
  "name": "render_and_wait",
  "parameters": {
    "type": "object",
    "properties": {
      "component": { "type": "string", "description": "Name of a stored component in agent_ui_components" },
      "code": { "type": "string", "description": "Inline JSX/React code (used when component is not provided)" },
      "props": { "type": "object", "description": "Props to pass to the component" },
      "title": { "type": "string", "description": "Optional title shown above the component" }
    },
    "required": []
  }
}
```

Exactly one of `component` or `code` must be provided.

**Returns (after user interaction):** Whatever the component passes to `callTool(action, payload)` — typically `{ action: string, ...payload }`.

**Pauses:** Yes.

### `render_blocks`

Render structured UI blocks using pre-built components. For quick data display without writing a full component.

```json
{
  "name": "render_blocks",
  "parameters": {
    "type": "object",
    "properties": {
      "blocks": {
        "type": "array",
        "description": "Array of UI blocks to render",
        "items": {
          "type": "object",
          "oneOf": [
            {
              "properties": {
                "type": { "const": "markdown" },
                "content": { "type": "string" }
              },
              "required": ["type", "content"]
            },
            {
              "properties": {
                "type": { "const": "table" },
                "columns": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "key": { "type": "string" },
                      "label": { "type": "string" }
                    },
                    "required": ["key", "label"]
                  }
                },
                "data": { "type": "array", "items": { "type": "object" } }
              },
              "required": ["type", "columns", "data"]
            },
            {
              "properties": {
                "type": { "const": "chart" },
                "chartType": { "type": "string", "enum": ["line", "bar", "pie", "area"] },
                "data": { "type": "object" }
              },
              "required": ["type", "chartType", "data"]
            },
            {
              "properties": {
                "type": { "const": "form" },
                "fields": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "name": { "type": "string" },
                      "label": { "type": "string" },
                      "type": { "type": "string", "enum": ["text", "number", "select", "checkbox", "textarea", "date"] },
                      "options": { "type": "array", "items": { "type": "string" } },
                      "required": { "type": "boolean" },
                      "default": {}
                    },
                    "required": ["name", "label", "type"]
                  }
                },
                "submitLabel": { "type": "string" }
              },
              "required": ["type", "fields", "submitLabel"]
            },
            {
              "properties": {
                "type": { "const": "code" },
                "language": { "type": "string" },
                "content": { "type": "string" }
              },
              "required": ["type", "language", "content"]
            },
            {
              "properties": {
                "type": { "const": "image" },
                "url": { "type": "string" },
                "alt": { "type": "string" }
              },
              "required": ["type", "url"]
            },
            {
              "properties": {
                "type": { "const": "alert" },
                "variant": { "type": "string", "enum": ["info", "warning", "danger", "success"] },
                "content": { "type": "string" }
              },
              "required": ["type", "variant", "content"]
            },
            {
              "properties": {
                "type": { "const": "json" },
                "data": {}
              },
              "required": ["type", "data"]
            }
          ]
        }
      },
      "title": { "type": "string", "description": "Optional title shown above the blocks" }
    },
    "required": ["blocks"]
  }
}
```

**Returns (after user interaction):** Form submissions come back as `{ action: "submit", data: { [fieldName]: value } }`. If no form, returns `{ action: "dismiss" }`.

**Pauses:** Yes.

### `send_message`

Send a text message that appears in the chat panel. Does **not** pause the agent loop — useful for progress updates mid-task.

```json
{
  "name": "send_message",
  "parameters": {
    "type": "object",
    "properties": {
      "text": { "type": "string", "description": "Message text (supports markdown)" }
    },
    "required": ["text"]
  }
}
```

**Returns:** `{ ok: true }`

**Pauses:** No.

---

## User Interaction

### `ask_user`

Ask the user a question in the chat panel. Pauses until the user replies.

```json
{
  "name": "ask_user",
  "parameters": {
    "type": "object",
    "properties": {
      "question": { "type": "string", "description": "The question to ask" },
      "options": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Optional list of choices. If provided, renders as buttons instead of a free-text input."
      }
    },
    "required": ["question"]
  }
}
```

**Returns:** `{ answer: string }`

**Pauses:** Yes.

---

## Web & Network

### `fetch_url`

HTTP request with SSRF protection (blocks private IPs, localhost, metadata endpoints).

```json
{
  "name": "fetch_url",
  "parameters": {
    "type": "object",
    "properties": {
      "url": { "type": "string", "description": "The URL to fetch" },
      "method": { "type": "string", "enum": ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"], "description": "HTTP method. Default: GET." },
      "headers": { "type": "object", "description": "Request headers as key-value pairs" },
      "body": { "type": "string", "description": "Request body (for POST/PUT/PATCH)" }
    },
    "required": ["url"]
  }
}
```

**Returns:** `{ status: number, headers: object, body: string, ok: boolean }`

---

## Browser (Headless Chromium via Playwright)

Server-side headless browser for web interaction. A browser context persists across calls within a conversation and is closed when the session ends or `browser_close` is called.

### `browser_navigate`

```json
{
  "name": "browser_navigate",
  "parameters": {
    "type": "object",
    "properties": {
      "url": { "type": "string", "description": "URL to navigate to" },
      "wait_until": { "type": "string", "enum": ["load", "domcontentloaded", "networkidle"], "description": "When to consider navigation complete. Default: load." }
    },
    "required": ["url"]
  }
}
```

**Returns:** `{ url: string, title: string, status: number }`

### `browser_screenshot`

Capture a screenshot of the current page or a specific element. Returns a base64-encoded PNG.

```json
{
  "name": "browser_screenshot",
  "parameters": {
    "type": "object",
    "properties": {
      "selector": { "type": "string", "description": "CSS selector to screenshot a specific element. If omitted, captures the full viewport." },
      "full_page": { "type": "boolean", "description": "Capture the entire scrollable page. Default: false." }
    },
    "required": []
  }
}
```

**Returns:** `{ image: string (base64), width: number, height: number }`

### `browser_click`

```json
{
  "name": "browser_click",
  "parameters": {
    "type": "object",
    "properties": {
      "selector": { "type": "string", "description": "CSS selector of the element to click" }
    },
    "required": ["selector"]
  }
}
```

**Returns:** `{ ok: true }`

### `browser_type`

Type text into a focused or selected input element.

```json
{
  "name": "browser_type",
  "parameters": {
    "type": "object",
    "properties": {
      "selector": { "type": "string", "description": "CSS selector of the input element" },
      "text": { "type": "string", "description": "Text to type" },
      "clear_first": { "type": "boolean", "description": "Clear existing content before typing. Default: false." }
    },
    "required": ["selector", "text"]
  }
}
```

**Returns:** `{ ok: true }`

### `browser_extract_text`

Extract text content from the page or a specific element.

```json
{
  "name": "browser_extract_text",
  "parameters": {
    "type": "object",
    "properties": {
      "selector": { "type": "string", "description": "CSS selector to extract from. If omitted, extracts from the entire page body." }
    },
    "required": []
  }
}
```

**Returns:** `{ text: string }`

### `browser_extract_html`

Extract the HTML of an element (for structured scraping).

```json
{
  "name": "browser_extract_html",
  "parameters": {
    "type": "object",
    "properties": {
      "selector": { "type": "string", "description": "CSS selector. Defaults to body." },
      "outer": { "type": "boolean", "description": "Include the element's own tag. Default: false (innerHTML only)." }
    },
    "required": []
  }
}
```

**Returns:** `{ html: string }`

### `browser_evaluate`

Execute arbitrary JavaScript in the browser page context.

```json
{
  "name": "browser_evaluate",
  "parameters": {
    "type": "object",
    "properties": {
      "code": { "type": "string", "description": "JavaScript to evaluate in the page context. The return value is serialized as JSON." }
    },
    "required": ["code"]
  }
}
```

**Returns:** `{ result: any }`

### `browser_close`

Close the current browser context and release resources.

```json
{
  "name": "browser_close",
  "parameters": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

**Returns:** `{ ok: true }`

---

## Reminders

Session-level. The agent wants to continue *this* conversation after a delay — "I'll check back on this tomorrow." The reminder fires in the originating session, injecting a message that wakes the agent loop.

### `set_reminder`

```json
{
  "name": "set_reminder",
  "parameters": {
    "type": "object",
    "properties": {
      "at": { "type": "string", "description": "ISO 8601 timestamp of when to fire (e.g. 2026-02-25T09:00:00Z)" },
      "message": { "type": "string", "description": "The message to inject into this session when the reminder fires" }
    },
    "required": ["at", "message"]
  }
}
```

One-shot only. Fires in the current session. For recurring work, use a scheduled task instead.

**Returns:** `{ id: string, at: string }`

### `cancel_reminder`

```json
{
  "name": "cancel_reminder",
  "parameters": {
    "type": "object",
    "properties": {
      "id": { "type": "string", "description": "Reminder ID to cancel" }
    },
    "required": ["id"]
  }
}
```

**Returns:** `{ deleted: boolean }`

---

## Scheduled Tasks

System-level. Independent automated jobs — not tied to any session. Each firing creates a fresh session with the task's prompt. Managed from any session or from the settings UI.

The server polls the `agent_scheduled_tasks` table on an interval (~30s). When a task is due, it creates a new session with the task's `task` field as the initial message, using the specified model and token limit. The agent runs in that fresh session with a clean context. If it needs memory across runs, it uses `agent_state` or the database.

### `create_scheduled_task`

```json
{
  "name": "create_scheduled_task",
  "parameters": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "Human-readable label" },
      "task": { "type": "string", "description": "The task prompt. This becomes the initial user message in the fresh session each time the task fires." },
      "at": { "type": "string", "description": "For one-shot tasks: ISO 8601 timestamp" },
      "cron": { "type": "string", "description": "For recurring tasks: cron expression (e.g. '0 9 * * MON')" },
      "model": { "type": "string", "description": "Model to use for each firing. Defaults to the system default. Use a cheaper model for simple recurring jobs." },
      "token_limit": { "type": "number", "description": "Max tokens per firing. Defaults to the system-wide limit." }
    },
    "required": ["name", "task"]
  }
}
```

Exactly one of `at` or `cron` must be provided.

**Returns:** `{ id: string, name: string, next_run: string }`

### `list_scheduled_tasks`

```json
{
  "name": "list_scheduled_tasks",
  "parameters": {
    "type": "object",
    "properties": {
      "include_disabled": { "type": "boolean", "description": "Include paused tasks. Default: false." }
    },
    "required": []
  }
}
```

**Returns:** `{ tasks: { id, name, task, type, next_run, last_run, enabled, model }[] }`

### `cancel_scheduled_task`

```json
{
  "name": "cancel_scheduled_task",
  "parameters": {
    "type": "object",
    "properties": {
      "id": { "type": "string", "description": "Task ID to cancel" }
    },
    "required": ["id"]
  }
}
```

**Returns:** `{ deleted: boolean }`

### `enable_scheduled_task` / `disable_scheduled_task`

Pause or resume a task without deleting it.

```json
{
  "name": "enable_scheduled_task",
  "parameters": {
    "type": "object",
    "properties": {
      "id": { "type": "string" }
    },
    "required": ["id"]
  }
}
```

```json
{
  "name": "disable_scheduled_task",
  "parameters": {
    "type": "object",
    "properties": {
      "id": { "type": "string" }
    },
    "required": ["id"]
  }
}
```

**Returns:** `{ id: string, enabled: boolean }`

---

## Sub-Sessions

A session can spawn sub-sessions to delegate work — research tasks, data processing, summarization, or anything that benefits from parallelism or a cheaper model. Sub-sessions are real sessions with their own conversation history, visible in the UI nested under their parent.

Sub-sessions have full access to all shared resources (tools, libraries, state, database, secrets, browser). They can interact with the user — if a sub-session calls `ask_user` or `render_and_wait`, it shows up as waiting for input in the UI, and the user can click into it and respond.

Sub-sessions can spawn their own sub-sessions (max depth: 3). They can modify shared state (last-write-wins, same as parallel sessions).

### `spawn_session`

Create and start a sub-session. Returns immediately — the sub-session runs independently.

```json
{
  "name": "spawn_session",
  "parameters": {
    "type": "object",
    "properties": {
      "task": { "type": "string", "description": "The instruction or message for the sub-session. This is what the sub-agent sees as its initial user message." },
      "model": { "type": "string", "description": "Model to use for the sub-session. Defaults to the current session's model. Use a cheaper/faster model for simple tasks." },
      "token_limit": { "type": "number", "description": "Max tokens the sub-session can consume before being stopped. Defaults to the system-wide per-session limit." }
    },
    "required": ["task"]
  }
}
```

The sub-session inherits the current system prompt and learned notes. All tools, libraries, state, and database access are available.

**Returns:** `{ id: string }` — the sub-session ID.

### `wait_for_sessions`

Pause the current session until the specified sub-sessions finish. This is an `asPendingToolCall` — the parent goes idle until results are ready.

A sub-session is "finished" when it reaches `completed` (called `report_result`), `error` (something went wrong), or `token_limit_reached` (hit its token cap). A sub-session that is merely `idle` or `waiting_for_input` is not finished — the parent keeps waiting.

```json
{
  "name": "wait_for_sessions",
  "parameters": {
    "type": "object",
    "properties": {
      "ids": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Sub-session IDs to wait for"
      }
    },
    "required": ["ids"]
  }
}
```

**Returns:**

```json
{
  "results": [
    { "id": "sub_abc", "status": "completed", "result": "Here's what I found about topic A..." },
    { "id": "sub_def", "status": "completed", "result": "Topic B analysis: ..." },
    { "id": "sub_ghi", "status": "token_limit_reached", "result": "Partial findings so far..." },
    { "id": "sub_xyz", "status": "error", "error": "Timed out after 120s" }
  ]
}
```

The `result` field contains whatever the sub-session passed to `report_result`. For `token_limit_reached`, it's the last assistant message (best effort).

**Pauses:** Yes.

### `report_result`

Only available in sub-sessions. Declares "I'm done" and sends a result back to the parent. Transitions the session to `completed` — a terminal state. The session cannot be woken after this (scheduled tasks for this session are cancelled).

```json
{
  "name": "report_result",
  "parameters": {
    "type": "object",
    "properties": {
      "result": { "type": "string", "description": "The result to send back to the parent session" }
    },
    "required": ["result"]
  }
}
```

This tool ends the session immediately — no further tool calls or text output after this. The parent's `wait_for_sessions` receives the result.

**Returns:** (nothing — the session ends)

### Token limits

Every session has a token cap — the maximum tokens it can consume (input + output) before being stopped. This prevents runaway costs.

- **System-wide default:** Configured in server settings (e.g., 100k tokens per session).
- **Per sub-session override:** The parent can set a lower `token_limit` when spawning. Useful for cheap tasks that shouldn't need much.
- **User override:** When a session hits its limit, the UI shows a "Continue" button. The user can extend the limit and let it keep going.

When a session hits its token limit mid-step, the current LLM call is aborted and the session enters `token_limit_reached` state. If it's a sub-session, `wait_for_sessions` returns with whatever partial result exists.

### Limits


| Limit                                  | Default      |
| -------------------------------------- | ------------ |
| Max concurrent sub-sessions per parent | 10           |
| Max nesting depth                      | 3            |
| Sub-session execution timeout          | 120 seconds  |
| Default token limit per session        | configurable |


---

## Summary Table


| Tool                     | Category          | Pauses | Description                                                             |
| ------------------------ | ----------------- | ------ | ----------------------------------------------------------------------- |
| `read_system_prompt`     | Self-modification | No     | Read the current stored system prompt                                   |
| `edit_system_prompt`     | Self-modification | No     | Edit the system prompt (replace, find/replace, append, prepend, delete) |
| `get_state`              | State             | No     | Read a state key                                                        |
| `set_state`              | State             | No     | Write a state key                                                       |
| `delete_state`           | State             | No     | Delete a state key                                                      |
| `list_state_keys`        | State             | No     | List keys with optional prefix filter                                   |
| `db_sql`                 | Database          | No     | Run any SQL on the agent's SQLite DB                                    |
| `db_schema`              | Database          | No     | List all tables and their columns                                       |
| `create_tool`            | Tool management   | No     | Create a new agent-defined tool                                         |
| `update_tool`            | Tool management   | No     | Update a tool's code, schema, or description                            |
| `delete_tool`            | Tool management   | No     | Delete a tool                                                           |
| `enable_tool`            | Tool management   | No     | Enable a disabled tool                                                  |
| `disable_tool`           | Tool management   | No     | Disable a tool without deleting it                                      |
| `list_tools`             | Tool management   | No     | List all agent-defined tools                                            |
| `read_tool`              | Tool management   | No     | Read a tool's full definition including code                            |
| `create_library`         | Libraries         | No     | Create a shared code library                                            |
| `update_library`         | Libraries         | No     | Update a library's code or description                                  |
| `delete_library`         | Libraries         | No     | Delete a library                                                        |
| `list_libraries`         | Libraries         | No     | List all libraries                                                      |
| `read_library`           | Libraries         | No     | Read a library's full code                                              |
| `run_sandbox_code`       | Code execution    | No     | Execute ad-hoc JS in sandbox                                            |
| `llm_generate`           | LLM generation    | No     | Single LLM call with configurable intelligence level                    |
| `create_ui_component`    | UI components     | No     | Create a stored React component                                         |
| `update_ui_component`    | UI components     | No     | Update a stored component                                               |
| `delete_ui_component`    | UI components     | No     | Delete a stored component                                               |
| `list_ui_components`     | UI components     | No     | List stored components                                                  |
| `read_ui_component`      | UI components     | No     | Read a component's full definition including code                       |
| `render_and_wait`        | UI rendering      | Yes    | Render a component and wait for interaction                             |
| `render_blocks`          | UI rendering      | Yes    | Render structured blocks and wait for interaction                       |
| `send_message`           | UI rendering      | No     | Send a chat message (no pause)                                          |
| `ask_user`               | User interaction  | Yes    | Ask a question and wait for response                                    |
| `fetch_url`              | Web               | No     | HTTP request with SSRF protection                                       |
| `browser_navigate`       | Browser           | No     | Navigate to a URL                                                       |
| `browser_screenshot`     | Browser           | No     | Capture a page/element screenshot                                       |
| `browser_click`          | Browser           | No     | Click an element                                                        |
| `browser_type`           | Browser           | No     | Type into an input                                                      |
| `browser_extract_text`   | Browser           | No     | Extract text from the page                                              |
| `browser_extract_html`   | Browser           | No     | Extract HTML from an element                                            |
| `browser_evaluate`       | Browser           | No     | Run JS in page context                                                  |
| `browser_close`          | Browser           | No     | Close the browser context                                               |
| `set_reminder`           | Reminders         | No     | Wake this session later with a message (one-shot, session-scoped)       |
| `cancel_reminder`        | Reminders         | No     | Cancel a pending reminder                                               |
| `create_scheduled_task`  | Scheduled tasks   | No     | Create an automated job (one-shot or cron, creates fresh sessions)      |
| `list_scheduled_tasks`   | Scheduled tasks   | No     | List all scheduled tasks (system-wide)                                  |
| `cancel_scheduled_task`  | Scheduled tasks   | No     | Delete a scheduled task                                                 |
| `enable_scheduled_task`  | Scheduled tasks   | No     | Resume a paused task                                                    |
| `disable_scheduled_task` | Scheduled tasks   | No     | Pause a task without deleting it                                        |
| `spawn_session`          | Sub-sessions      | No     | Spawn a sub-session with a task                                         |
| `wait_for_sessions`      | Sub-sessions      | Yes    | Wait for sub-sessions to complete                                       |
| `report_result`          | Sub-sessions      | No     | Declare results and end the sub-session (sub-sessions only)             |
| `web_search`             | Web               | No     | Search the web (see [Web](./Web.md))                                    |
| `web_read`               | Web               | No     | Extract clean readable content from a URL (see [Web](./Web.md))         |
| `file_list`              | Files             | No     | List files in the workspace (see [Files](./Files.md))                   |
| `file_info`              | Files             | No     | Get file metadata                                                       |
| `file_create`            | Files             | No     | Create a new file                                                       |
| `file_delete`            | Files             | No     | Delete a file                                                           |
| `file_read_text`         | Files             | No     | Read text file content (full or line range)                             |
| `file_write_text`        | Files             | No     | Write text file content                                                 |
| `file_replace_lines`     | Files             | No     | Replace a range of lines in a text file                                 |
| `file_download`          | Files             | No     | Download a URL into the file workspace                                  |
| `spreadsheet_*`          | Files             | No     | Spreadsheet operations (see [Files](./Files.md))                        |
| `pdf_*`                  | Files             | No     | PDF operations (see [Files](./Files.md))                                |
| `image_*`                | Files             | No     | Image operations (see [Files](./Files.md))                              |
| `create_skill`           | Skills            | No     | Create a named knowledge document (see [Skills](./Skills.md))           |
| `update_skill`           | Skills            | No     | Edit a skill's content or metadata                                      |
| `delete_skill`           | Skills            | No     | Delete a skill                                                          |
| `list_skills`            | Skills            | No     | List all skills (name + description + tags)                             |
| `read_skill`             | Skills            | No     | Read a skill's full content                                             |
| `enable_skill`           | Skills            | No     | Enable a disabled skill                                                 |
| `disable_skill`          | Skills            | No     | Disable a skill without deleting it                                     |
| `read_notepad`           | Session notepad   | No     | Read the session notepad (see [Session Notepad](./Session%20Notepad.md))|
| `write_notepad`          | Session notepad   | No     | Replace the entire notepad content                                      |
| `update_notepad`         | Session notepad   | No     | Surgical edit (find_replace, append, prepend, delete)                   |


