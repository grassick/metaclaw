# Session Notepad

A per-session freeform text scratchpad the agent uses for working notes, task tracking, and intermediate findings. Survives context compaction — the primary reason it exists.

---

## The problem

When a conversation gets long, the `AgentSessionController` compacts the history — summarizing old messages into a shorter form. This is necessary to stay within token limits, but it destroys detail. If the agent is 40 messages into analyzing a 10-sheet spreadsheet and compaction fires, the detailed findings from the first 5 sheets get compressed into a summary. The agent loses track of specific values, row numbers, anomalies it found.

The notepad solves this. It's stored outside the conversation history and re-injected into every context window in full. Anything the agent writes to the notepad survives compaction.

---

## Design

One text column on `agent_sessions`:

| Column | Type | Description |
|---|---|---|
| `notepad` | text | Freeform markdown, null if unused |

No new table. It's a property of the session.

---

## Meta-Tools

### `read_notepad`

```json
{
  "name": "read_notepad",
  "parameters": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

**Returns:** `{ content: string }` — empty string if nothing written yet.

### `write_notepad`

Full replacement of the notepad content.

```json
{
  "name": "write_notepad",
  "parameters": {
    "type": "object",
    "properties": {
      "content": { "type": "string", "description": "The new notepad content (replaces everything)" }
    },
    "required": ["content"]
  }
}
```

**Returns:** `{ ok: true }`

### `update_notepad`

Surgical edits — same operations as `edit_system_prompt`.

```json
{
  "name": "update_notepad",
  "parameters": {
    "type": "object",
    "properties": {
      "operation": {
        "type": "string",
        "enum": ["find_replace", "append", "prepend", "delete"],
        "description": "The type of edit to perform"
      },
      "content": {
        "type": "string",
        "description": "For append/prepend: text to add. For delete: text to remove."
      },
      "find": { "type": "string", "description": "For find_replace: exact substring to find" },
      "replace": { "type": "string", "description": "For find_replace: replacement text" },
      "replace_all": { "type": "boolean", "description": "For find_replace: replace all occurrences. Default: false." }
    },
    "required": ["operation"]
  }
}
```

**Returns:** `{ ok: true }`

`write_notepad` is for full replacement (rewriting the notepad from scratch or clearing it by writing `""`). `update_notepad` is for targeted edits — appending new findings, marking a todo as done via find_replace, removing obsolete notes. Both are needed: the agent uses `update_notepad` with `append` for incremental additions, `find_replace` for status updates, and `write_notepad` when it wants to reorganize the whole thing.

---

## Sandbox API

```typescript
session.notepad.read(): Promise<string>
session.notepad.write(content: string): Promise<void>
session.notepad.append(text: string): Promise<void>
```

Available in agent-authored tools and `run_sandbox_code`. An agent-authored tool doing a long operation can append progress notes to the notepad as it works.

---

## How it appears in context

The notepad is included in the dynamic system prompt every turn, in a section after skills and tool summaries:

```
## Session Notepad
[notepad content here]
```

If the notepad is empty:

```
## Session Notepad
(empty — use write_notepad or update_notepad to save working notes, findings, and task progress; content here survives context compaction)
```

The empty-state hint tells the agent why the notepad exists and motivates using it. Once the agent has written something, the hint disappears and the content speaks for itself.

---

## Pre-compaction warning

The notepad only helps if the agent writes to it. For complex tasks, the agent should be updating the notepad continuously. But agents, like people, get busy doing the work and forget to take notes.

Safety net: before compacting, the controller gives the agent one more turn.

### Flow

1. Before an LLM call, the controller checks token usage against the compaction threshold.
2. If approaching the threshold, the controller injects a system message instead of proceeding normally:

   ```
   [System] Context is approaching the token limit and will be compacted after your next response.
   Review your session notepad and update it with any working state, findings, or progress you
   need to preserve. Conversation details may be summarized during compaction, but the notepad
   is kept in full.
   ```

3. The agent responds — updates the notepad with anything important it hasn't written down yet. May also send a brief message to the user about progress.
4. The controller compacts the conversation history.
5. The new compacted context includes: summarized messages + full notepad + system prompt.
6. Normal flow resumes.

### Cost

One extra LLM turn before each compaction. But it's a short, focused turn (the agent is just reviewing and writing notes), and it prevents the much more expensive failure mode of the agent losing track and redoing work.

In many cases, the agent will respond with "Notepad is up to date" and the turn costs very little. In cases where the agent has been heads-down in a chain of tool calls and forgot to take notes, the warning turn saves the session.

---

## System prompt instruction

The agent's default system prompt should include guidance:

> For multi-step or complex tasks, use the session notepad to track your plan and record findings as you work. The notepad survives context compaction — conversation details may be summarized, but the notepad is preserved in full. Update it after significant findings or completed steps.

This encourages continuous notepad use, making the pre-compaction warning a safety net rather than the primary mechanism.

---

## Sub-sessions and forks

Each sub-session has its own notepad. How it's initialized depends on how the sub-session was created:

- **`spawn_session`** — notepad starts empty (unless `copy_notepad: true`, in which case the parent's notepad is copied).
- **`fork_session`** — notepad is always copied from the parent (along with the full conversation history).

After creation, parent and child notepads are independent. Changes to one don't affect the other.

When a sub-session calls `report_result`, it sends a clean summary back to the parent. The notepad is internal working state, not part of the result. The parent's notepad might track delegated work:

```markdown
## Delegated
- sub_abc: analyzing revenue sheets → completed, no issues
- sub_def: analyzing expense sheets → completed, found 3 duplicate rows, fixed
```

---

## Typical notepad content

```markdown
## Plan
- [x] Survey all sheets (6 sheets, ~2400 rows total)
- [x] Analyze Sheet 1 (revenue by region)
- [x] Analyze Sheet 2 (expense categories)
- [ ] Fix Q3 total formulas in Summary
- [ ] Add conditional formatting to variance column
- [ ] Create YoY comparison sheet

## Findings
- Sheet 1: 500 rows, cols A-F, dates YYYY-MM-DD, revenue by region by month
- Sheet 2: 180 rows, 12 expense categories × 15 months
- Q3 discrepancy: Summary shows $1.2M, detail rows sum to $1.155M
- Gap traced to EMEA region, rows 234-267 — July data double-counted

## Decisions
- Fixing by removing duplicate rows (rows 251-267) rather than adjusting formulas
- User wants conditional formatting: green >5% YoY growth, red <0%
```

The agent manages the structure. It might use markdown checklists for progress, headers for sections, bullet points for findings. The system doesn't impose any format.

---

## Relationship to task scoping

The notepad and task scoping (`begin_task` / `end_task`) are complementary:

- **Task scoping** cleans up the conversation — collapses intermediate tool calls into a summary, keeping the LLM's context window lean.
- **The notepad** preserves cross-task working memory — the plan, overall findings, and decisions that need to survive across multiple tasks and through compaction.

A typical pattern: the agent updates the notepad with key findings from a task, then calls `end_task` to collapse the detail. The notepad retains what matters; the conversation stays clean.

---

## What the notepad is NOT

- **Not global.** It's session-scoped. Each session has its own. Use `agent_state` or skills for cross-session knowledge.
- **Not a replacement for the system prompt.** The system prompt holds permanent behavioral instructions and observations. The notepad holds working state for the current task.
- **Not a replacement for skills.** After completing a task, the agent might extract reusable knowledge from the notepad into a skill. The notepad is ephemeral working memory; skills are permanent knowledge.
- **Not automatically populated.** The agent decides what to write. The system doesn't extract or summarize on the agent's behalf (except the pre-compaction warning, which prompts the agent to do it).

---

## Knowledge architecture with the notepad

| Layer | Scope | In context | Survives compaction | Survives session end |
|---|---|---|---|---|
| System prompt | Global | Always (full text) | N/A | Yes (permanent) |
| Skills | Global | Summary always; full text on demand | N/A | Yes (permanent) |
| **Session notepad** | Session | Always (full text) | Yes | Archived with session |
| Conversation history | Session | Yes (compacted over time) | Partially (summarized) | Archived with session |
| State / Database | Global | On demand (via tool calls) | N/A | Yes (permanent) |
