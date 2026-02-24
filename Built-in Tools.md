# Built-in Tools (Meta-Tools)

These tools are always available to the LLM. They are hardcoded in `PersonalAgentImplementation` and never appear in the `agent_tools` table. Parameters are defined with Zod in code; the JSON Schemas below represent what the LLM receives.

---

## Self-Modification

The agent's identity is stored as two separate text documents:

- **System prompt** — behavioral instructions ("you are...", "when the user asks X, do Y")
- **Learned notes** — accumulated knowledge ("the user prefers dark mode", "their timezone is EST")

Both are concatenated into the LLM's system message at conversation start and at compaction. Keeping them separate means the agent can rewrite its instructions without accidentally destroying accumulated knowledge, and vice versa.

> **Note:** The system prompt is in the LLM's context, but after mid-conversation edits the context still holds the old version until compaction. Use the read tools to get the current stored version before making surgical edits.

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

| Operation | Required fields | Behavior |
|-----------|----------------|----------|
| `replace` | `content` | Replace the entire prompt |
| `find_replace` | `find`, `replace` | Replace first occurrence of `find` with `replace` (or all occurrences if `replace_all` is true). Fails if `find` is not found. |
| `append` | `content` | Add text to the end of the prompt |
| `prepend` | `content` | Add text to the beginning of the prompt |
| `delete` | `content` | Remove first occurrence of `content`. Fails if not found. |

**Returns:** `{ version: number }`

### `read_learned_notes`

```json
{
  "name": "read_learned_notes",
  "parameters": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

**Returns:** `{ notes: string, version: number }`

### `edit_learned_notes`

Same editing operations as `edit_system_prompt`.

```json
{
  "name": "edit_learned_notes",
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
        "description": "For replace: the new full notes. For append/prepend: the text to add. For delete: the text to remove."
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

## Summary Table

| Tool                  | Category          | Pauses | Description                                      |
| --------------------- | ----------------- | ------ | ------------------------------------------------ |
| `read_system_prompt`  | Self-modification | No     | Read the current stored system prompt             |
| `edit_system_prompt`  | Self-modification | No     | Edit the system prompt (replace, find/replace, append, prepend, delete) |
| `read_learned_notes`  | Self-modification | No     | Read the current learned notes                   |
| `edit_learned_notes`  | Self-modification | No     | Edit learned notes (same operations as prompt)   |
| `get_state`           | State             | No     | Read a state key                                 |
| `set_state`           | State             | No     | Write a state key                                |
| `delete_state`        | State             | No     | Delete a state key                               |
| `list_state_keys`     | State             | No     | List keys with optional prefix filter            |
| `db_sql`              | Database          | No     | Run any SQL on the agent's SQLite DB             |
| `db_schema`           | Database          | No     | List all tables and their columns                |
| `create_tool`         | Tool management   | No     | Create a new agent-defined tool                  |
| `update_tool`         | Tool management   | No     | Update a tool's code, schema, or description     |
| `delete_tool`         | Tool management   | No     | Delete a tool                                    |
| `enable_tool`         | Tool management   | No     | Enable a disabled tool                           |
| `disable_tool`        | Tool management   | No     | Disable a tool without deleting it               |
| `list_tools`          | Tool management   | No     | List all agent-defined tools                     |
| `read_tool`           | Tool management   | No     | Read a tool's full definition including code     |
| `run_sandbox_code`    | Code execution    | No     | Execute ad-hoc JS in sandbox                     |
| `create_ui_component` | UI components     | No     | Create a stored React component                  |
| `update_ui_component` | UI components     | No     | Update a stored component                        |
| `delete_ui_component` | UI components     | No     | Delete a stored component                        |
| `list_ui_components`  | UI components     | No     | List stored components                           |
| `render_and_wait`     | UI rendering      | Yes    | Render a component and wait for interaction      |
| `render_blocks`       | UI rendering      | Yes    | Render structured blocks and wait for interaction|
| `send_message`        | UI rendering      | No     | Send a chat message (no pause)                   |
| `ask_user`            | User interaction  | Yes    | Ask a question and wait for response             |
| `fetch_url`           | Web               | No     | HTTP request with SSRF protection                |
| `browser_navigate`    | Browser           | No     | Navigate to a URL                                |
| `browser_screenshot`  | Browser           | No     | Capture a page/element screenshot                |
| `browser_click`       | Browser           | No     | Click an element                                 |
| `browser_type`        | Browser           | No     | Type into an input                               |
| `browser_extract_text`| Browser           | No     | Extract text from the page                       |
| `browser_extract_html`| Browser           | No     | Extract HTML from an element                     |
| `browser_evaluate`    | Browser           | No     | Run JS in page context                           |
| `browser_close`       | Browser           | No     | Close the browser context                        |
