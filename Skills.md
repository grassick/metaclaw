# Skills

Skills are named markdown documents that hold procedures, standards, domain knowledge, and workflows the agent can reference. They're the modular replacement for the monolithic `learned_notes` — discrete pieces of knowledge that can be loaded selectively instead of dumped into every context window.

---

## What a skill is

A skill is a markdown document with a name and description. The description is used for discovery — it appears in the system prompt summary so the agent can decide whether to load the full content.

Example:

```markdown
# Quarterly Excel Reports

Standards and procedures for building quarterly financial reports.

## Structure
- Sheet 1: Summary dashboard with KPIs
- Sheet 2: Revenue breakdown by region
- Sheet 3: Expense details
- Sheet 4: Raw data

## Formatting Rules
- Headers: bold, dark blue background (#1F4E79), white text
- Currency: $#,##0.00 format
- Percentages: 0.0% format, conditional coloring (green >0, red <0)
- All data tables get autofilter

## Formulas
- Summary KPIs use SUMIFS referencing the raw data sheet
- YoY change: =(current-prior)/prior formatted as percentage
```

---

## How skills differ from other concepts

| | Skills | System Prompt | Tools | Libraries | Files |
|---|---|---|---|---|---|
| **Content** | Markdown knowledge and instructions | Behavioral instructions + observations | Executable JavaScript | Executable JavaScript | Any format (binary or text) |
| **Purpose** | Inform how the agent works (procedures, standards) | Core identity + quick facts | Add programmatic capabilities | Share code between tools | Work artifacts |
| **Created by** | User or agent | User (core) + agent (observations) | Agent only | Agent only | User or agent |
| **Loaded into** | LLM context as text (via tool call) | LLM context (always, in full) | Executed in sandbox | Required by tool code | Accessed via file APIs |
| **Retrieval** | Agent reads list, loads by name when relevant | Always present | Called by name | Required by name | Accessed by ID |
| **Lifecycle** | Long-lived, refined over time | Long-lived, core rarely changes, observations appended | Persistent until deleted | Persistent until deleted | Task-scoped or persistent |

The key difference: a skill's content goes **into the LLM's context as text** when loaded. The agent reads it and follows the instructions. A tool **executes code**. A file is **processed by APIs**. The system prompt is always present but should stay concise — skills are for anything too detailed or specialized to justify the per-turn token cost of being always in context.

---

## Storage

### `agent_skills` table

| Column | Type | Description |
|---|---|---|
| `_id` | text | Unique slug (e.g. `quarterly-excel-reports`) |
| `title` | text | Human-readable title |
| `description` | text | Brief description — shown in the system prompt summary for discovery |
| `content` | text | Full markdown content |
| `tags` | text | JSON array of tags for categorization (e.g. `["excel", "reporting", "finance"]`) |
| `source` | text | `user` (given by user) or `agent` (created by agent) |
| `version` | integer | Auto-incremented on update |
| `enabled` | integer | 1/0 — disabled skills don't appear in listings |
| `created_on` | text | ISO 8601 |
| `modified_on` | text | ISO 8601 |

---

## How skills get into context

Same pattern as tools, libraries, and components. The system prompt is dynamically built and includes a summary of available skills:

```
## Available Skills
- quarterly-excel-reports: Standards and procedures for building quarterly financial reports [excel, reporting, finance]
- deployment-checklist: Step-by-step process for deploying to production [devops, deployment]
- data-cleaning-procedures: How to clean and validate imported datasets [data, csv, excel]
- user-preferences: User's formatting preferences and conventions [meta]
```

This costs a few tokens per skill — just name, description, and tags. The agent sees what's available every turn and decides whether to load one. When relevant, it calls `read_skill("quarterly-excel-reports")` and gets the full content back as a tool result.

No automatic injection, no embedding-based retrieval, no guessing. The agent reads the list and makes a judgment call. Simple, transparent, debuggable.

---

## Meta-Tools

### `create_skill`

```json
{
  "name": "create_skill",
  "parameters": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "Unique slug (lowercase, hyphens). e.g. 'quarterly-excel-reports'" },
      "title": { "type": "string", "description": "Human-readable title" },
      "description": { "type": "string", "description": "Brief description (shown in the skill list for discovery)" },
      "content": { "type": "string", "description": "Full markdown content" },
      "tags": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Tags for categorization"
      }
    },
    "required": ["name", "title", "description", "content"]
  }
}
```

**Returns:** `{ name: string, version: 1 }`

### `update_skill`

Supports the same edit operations as `edit_system_prompt` — replace, find_replace, append, prepend, delete — so the agent can make surgical edits without rewriting the whole skill.

```json
{
  "name": "update_skill",
  "parameters": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "Skill name to update" },
      "title": { "type": "string", "description": "New title (optional)" },
      "description": { "type": "string", "description": "New description (optional)" },
      "tags": { "type": "array", "items": { "type": "string" }, "description": "New tags (optional, replaces existing)" },
      "operation": {
        "type": "string",
        "enum": ["replace", "find_replace", "append", "prepend", "delete"],
        "description": "Edit operation on the content"
      },
      "content": {
        "type": "string",
        "description": "For replace: new full content. For append/prepend: text to add. For delete: text to remove."
      },
      "find": { "type": "string", "description": "For find_replace: exact substring to find" },
      "replace": { "type": "string", "description": "For find_replace: replacement text" },
      "replace_all": { "type": "boolean", "description": "For find_replace: replace all occurrences. Default: false." }
    },
    "required": ["name"]
  }
}
```

If only metadata fields (title, description, tags) are provided without an operation, only metadata is updated.

**Returns:** `{ name: string, version: number }`

### `delete_skill`

```json
{
  "name": "delete_skill",
  "parameters": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "Skill name to delete" }
    },
    "required": ["name"]
  }
}
```

**Returns:** `{ deleted: boolean }`

### `list_skills`

```json
{
  "name": "list_skills",
  "parameters": {
    "type": "object",
    "properties": {
      "tag": { "type": "string", "description": "Optional tag to filter by" },
      "include_disabled": { "type": "boolean", "description": "Include disabled skills. Default: false." }
    },
    "required": []
  }
}
```

**Returns:** `{ skills: { name, title, description, tags, source, version }[] }`

### `read_skill`

```json
{
  "name": "read_skill",
  "parameters": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "Skill name to read" }
    },
    "required": ["name"]
  }
}
```

**Returns:** `{ name, title, description, content, tags, source, version }`

### `enable_skill` / `disable_skill`

```json
{
  "name": "enable_skill",
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
  "name": "disable_skill",
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

---

## Sandbox API

Available in agent-authored tools and `run_sandbox_code`:

```typescript
skills.list(tag?: string): Promise<{ name, title, description, tags }[]>
skills.read(name: string): Promise<{ name, title, description, content, tags }>
```

Read-only in the sandbox. Skill creation and editing go through the meta-tools (which are LLM-facing, not tool-code-facing). An agent-authored tool might read a skill to follow its instructions, but it shouldn't be creating skills as a side effect of a tool execution.

---

## How skills get created

### By the user

1. **Settings UI** — a skill editor page where the user writes or pastes markdown, gives it a name, description, and tags. Similar to how secrets are managed.
2. **Chat** — the user says "remember this as a skill" or describes knowledge for the agent to save. The agent calls `create_skill`.
3. **File upload** — the user uploads a `.md` file and asks the agent to save it as a skill. Agent reads the file content and calls `create_skill`.

### By the agent

The agent creates skills to codify what it learns:

- After a complex task, the agent documents the procedure as a skill so it can follow the same steps next time.
- When the user corrects the agent ("we always use ISO dates in reports"), the agent updates the relevant skill via `update_skill`.
- When the agent notices it's done the same kind of task multiple times, it synthesizes a skill from the common pattern.

The system prompt should encourage this: "After completing a complex or multi-step task, consider whether the procedure should be saved as a skill for future reference."

---

## Relationship to the system prompt

The system prompt holds the agent's core identity and small behavioral observations (appended via `edit_system_prompt` with the `append` operation):

- "User's name is Alex"
- "Timezone: US Eastern"
- "Prefers concise responses"
- "Company fiscal year starts in April"

These are always in context — a few tokens each, relevant to nearly every conversation.

Anything that's a **procedure, workflow, standard, or domain knowledge block** becomes a skill instead. Skills are loaded on demand, so they don't consume tokens in conversations where they're irrelevant. The dividing line: if it's a quick fact that shapes general behavior, append it to the system prompt. If it's detailed instructions for a specific kind of task, create a skill.

---

## Settings UI

The settings panel gets a new **Skills** section alongside Tools, Libraries, and Secrets:

- List of all skills with name, title, description, source badge (user/agent), enabled toggle
- Click to view full content with a markdown preview
- Create/edit/delete buttons for user-created skills
- Agent-created skills are editable by the user too (the user might want to refine what the agent learned)
