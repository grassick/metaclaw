# MCP Servers

Connect external [MCP](https://modelcontextprotocol.io/) (Model Context Protocol) servers to extend an agent's capabilities. MCP servers expose tools, resources, and prompts through a standard protocol. Instead of building integrations from scratch in the sandbox, the user connects an MCP server and its tools appear alongside everything else.

---

## How it works

The server maintains a pool of MCP client connections — one per configured server. Each client connects using one of the supported transports (stdio, HTTP, or SSE). On each agent step, the tools from connected MCP servers are merged into the dynamic tool set alongside built-in meta-tools and agent-created tools.

```
Built-in meta-tools           ─┐
Agent-created tools (DB)       ├─ merged into single tool set → LLM
MCP server tools (per server)  ─┘
```

When the LLM calls an MCP tool, the server routes the call to the appropriate MCP client, which forwards it to the external MCP server. The result comes back through the same path.

### Implementation

The Vercel AI SDK provides `createMCPClient` (from `@ai-sdk/mcp`) which handles protocol negotiation, schema conversion, and tool call routing. It outputs tools in the same format `generateText`/`streamText` expect — no manual conversion needed.

```typescript
import { createMCPClient, Experimental_StdioMCPTransport } from '@ai-sdk/mcp';

const client = await createMCPClient({
  transport: new Experimental_StdioMCPTransport({
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', connectionString],
  }),
});

const mcpTools = await client.tools();
```

These tools are spread into the combined tool set in `getTools()`:

```typescript
const tools = {
  ...builtInMetaTools,
  ...agentCreatedTools,
  ...mcpToolsFromAllServers,
};
```

---

## Transports

| Transport | Use case | Configuration |
|-----------|----------|---------------|
| **stdio** | Local servers — spawned as child processes | `command` + `args` + optional `env` |
| **HTTP** | Remote servers over streamable HTTP | `url` + optional `headers` |
| **SSE** | Remote servers over Server-Sent Events (older protocol) | `url` + optional `headers` |

stdio is the most common for self-hosted setups. The server spawns the MCP server process and communicates over stdin/stdout. HTTP and SSE are for remote or shared servers.

---

## Tool namespacing

MCP servers may expose tools with names that conflict with built-in tools, agent-created tools, or tools from other servers. Each server config has an optional `tool_prefix`. When set, all tools from that server are prefixed: a server with prefix `gh` exposing `create_issue` becomes `gh_create_issue`.

Resolution order when names collide:

1. Built-in meta-tools always win
2. Agent-created tools override MCP tools
3. Among MCP servers, the first configured server wins; the duplicate is skipped with a warning

If no prefix is set and a collision occurs, the MCP tool is skipped and a warning is logged. The user can resolve it by adding a prefix in settings.

---

## Server lifecycle

### Startup

1. On server start, load all enabled MCP server configs for each agent from `agent_mcp_servers`
2. For each, create a client connection using the configured transport
3. If a connection fails, log the error and mark the server as `disconnected`. Retry with backoff.

### Reconnection

When a stdio process dies or an HTTP/SSE connection drops:

1. Mark the server as `disconnected`, emit `mcp:status` event
2. Retry with exponential backoff (1s, 2s, 4s, ... capped at 60s)
3. On reconnection, refresh the tool list (servers can change their tool set between connections)

### Hot reload

When a server config is added, modified, or removed via the settings UI:

- **Added:** Connect immediately
- **Modified:** Disconnect old client, connect with updated config
- **Removed:** Disconnect, kill any child process

### Shutdown

On Metaclaw server shutdown, close all MCP client connections and kill stdio child processes.

---

## Resources

MCP servers can expose resources — read-only data identified by URIs (e.g. `postgres://mydb/schema`, `file:///path/to/data`). These are not tools — they're a data access channel.

Resources are exposed to the agent via `list_mcp_resources` and `read_mcp_resource` meta-tools, and to sandbox code via `mcp.resources()` and `mcp.readResource(serverName, uri)`.

---

## Prompts

MCP servers can expose prompt templates — pre-built instructions for common tasks. Available via `list_mcp_prompts` and `get_mcp_prompt` meta-tools.

---

## Concurrency

MCP tool calls are serialized per server (one call at a time per client). Different servers handle calls concurrently. This avoids issues with servers that don't support concurrent requests while still allowing parallelism across servers.

---

## Storage

### `agent_mcp_servers` table

| Column | Type | Description |
|--------|------|-------------|
| `_id` | text | Unique server slug (e.g. `postgres-main`, `github`) |
| `agent_id` | text | FK to `agents` — each agent has its own MCP server configs |
| `name` | text | Human-readable display name |
| `transport` | text | `stdio`, `http`, or `sse` |
| `command` | text | For stdio: command to run (e.g. `npx`, `node`, `python`) |
| `args` | text | For stdio: JSON array of command arguments |
| `url` | text | For http/sse: server URL |
| `headers` | text | For http/sse: JSON object of headers (may reference secrets) |
| `env` | text | For stdio: JSON object of additional environment variables |
| `tool_prefix` | text | Optional prefix for tool names from this server |
| `enabled` | integer | 1/0 |
| `created_on` | text | ISO 8601 |
| `modified_on` | text | ISO 8601 |

---

## Management

MCP servers are **user-managed only**. The agent cannot add, remove, or modify MCP server configurations. stdio servers spawn child processes with full system access — that's a privilege the agent should not have. Even HTTP/SSE servers could be pointed at internal services. The user controls what's connected; the agent uses what's available.

Configuration is done through the settings UI or the REST API (for automation). Not through meta-tools.

## Meta-Tools

The agent has read-only visibility into MCP servers plus access to resources and prompts.

### `list_mcp_servers`

```json
{
  "name": "list_mcp_servers",
  "parameters": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

**Returns:** `{ servers: { server_name, name, transport, status, tools: string[] }[] }`

Only returns enabled servers. `status` is a runtime value: `connected` or `error`.

### `list_mcp_resources`

```json
{
  "name": "list_mcp_resources",
  "parameters": {
    "type": "object",
    "properties": {
      "server_name": { "type": "string", "description": "Optional — list resources from a specific server. If omitted, lists from all connected servers." }
    },
    "required": []
  }
}
```

**Returns:** `{ resources: { server_name, uri, name, description?, mime_type? }[] }`

### `read_mcp_resource`

```json
{
  "name": "read_mcp_resource",
  "parameters": {
    "type": "object",
    "properties": {
      "server_name": { "type": "string", "description": "Server that owns the resource" },
      "uri": { "type": "string", "description": "Resource URI" }
    },
    "required": ["server_name", "uri"]
  }
}
```

**Returns:** `{ uri, content: string, mime_type? }`

### `list_mcp_prompts`

```json
{
  "name": "list_mcp_prompts",
  "parameters": {
    "type": "object",
    "properties": {
      "server_name": { "type": "string", "description": "Optional — filter to a specific server" }
    },
    "required": []
  }
}
```

**Returns:** `{ prompts: { server_name, name, description?, arguments?: { name, description?, required? }[] }[] }`

### `get_mcp_prompt`

```json
{
  "name": "get_mcp_prompt",
  "parameters": {
    "type": "object",
    "properties": {
      "server_name": { "type": "string", "description": "Server that owns the prompt" },
      "name": { "type": "string", "description": "Prompt name" },
      "arguments": { "type": "object", "description": "Arguments to fill the prompt template" }
    },
    "required": ["server_name", "name"]
  }
}
```

**Returns:** `{ messages: { role: string, content: string }[] }`

---

## Sandbox API

Read-only access to MCP resources from agent-authored tools and `run_sandbox_code`:

```typescript
mcp.resources(serverName?: string): Promise<{ server_name, uri, name, description?, mime_type? }[]>
mcp.readResource(serverName: string, uri: string): Promise<{ uri, content: string, mime_type? }>
```

MCP tools are not callable from sandbox code — they're LLM-facing. If an agent-authored tool needs to call an external service, it uses `fetch()` directly. MCP resources are read-only data, so exposing them in the sandbox is safe and useful.

---

## System prompt integration

Connected MCP servers are included in the dynamic system prompt summary:

```
## MCP Servers
- github (connected): create_issue, list_repos, search_code, create_pr [4 tools]
- postgres-main (connected): query, list_tables, describe_table [3 tools]
- slack (disconnected): reconnecting...
```

This tells the agent what external capabilities are available without loading details into context. The agent calls MCP tools the same way it calls any other tool.

---

## Settings UI

The settings panel includes an **MCP Servers** section:

- List of configured servers with name, transport type, status indicator (green/red/yellow dot), enabled toggle
- **Add server** form: name, transport picker (stdio/http/sse), and the relevant fields for that transport (command+args+env for stdio, url+headers for http/sse), optional tool prefix
- Click a server to see: connection status, tool list, resource list, recent errors
- Remove button with confirmation

---

## Security

stdio MCP servers run as child processes with full system access — they are **not sandboxed**. An MCP server has the same privileges as the Metaclaw server process itself. This is consistent with the personal/single-user nature of Metaclaw, but the user should only configure servers they trust.

HTTP/SSE servers are external — they run wherever they run. The same SSRF protections that apply to `fetch_url` do **not** apply to MCP connections, since the user explicitly configures the server URL. The user is responsible for trusting the endpoint.

---

## Limits

| Limit | Default |
|-------|---------|
| Max MCP servers per agent | 20 |
| MCP tool call timeout | 30 seconds |
| Max concurrent MCP connections per agent | 20 |
| Reconnection backoff cap | 60 seconds |
