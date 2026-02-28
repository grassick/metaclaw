# Web Search & Page Reading

Two lightweight capabilities that sit between raw `fetch` and full Playwright browser automation. `fetch` gets raw HTML (noisy, full of nav and scripts). The `browser.*` tools spin up a headless Chromium instance (slow, heavy, overkill for reading an article). These fill the gap.

---

## Web Search (`web.search` / `web_search`)

The agent can search the web and get structured results.

### Sandbox API

```typescript
web.search(query: string, options?: {
  count?: number       // max results, default 10
  region?: string      // country code (e.g. 'US', 'GB')
  freshness?: 'day' | 'week' | 'month'  // recency filter
}): Promise<{
  results: {
    title: string
    url: string
    snippet: string
    published_date?: string
  }[]
}>
```

### Meta-tool

```json
{
  "name": "web_search",
  "parameters": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Search query" },
      "count": { "type": "number", "description": "Max results to return. Default: 10." },
      "region": { "type": "string", "description": "Country code for regional results (e.g. 'US', 'GB')" },
      "freshness": { "type": "string", "enum": ["day", "week", "month"], "description": "Only return results from the specified time period" }
    },
    "required": ["query"]
  }
}
```

**Returns:** `{ results: { title, url, snippet, published_date? }[] }`

### Search provider

The user configures which search provider to use in settings. The server abstracts the provider behind a common interface.

| Provider | Free tier | Cost after | Notes |
|---|---|---|---|
| **Brave Search API** | 2,000 queries/month | $3/1k queries | Best free tier. Clean REST API. No Google dependency. |
| **SearXNG** | Unlimited (self-hosted) | Free | Open-source metasearch engine. Fits the self-hosted ethos. Requires running an additional service. |
| **Google Custom Search** | 100 queries/day | $5/1k queries | Official but limited free tier. |
| **Bing Web Search API** | 1,000 queries/month | Pay-per-use | Microsoft Azure service. |
| **Tavily** | 1,000 queries/month | Pay-per-use | Built for AI agents. Returns pre-extracted content alongside results. |

The search provider API key is stored in `agent_secrets` (e.g. `BRAVE_SEARCH_API_KEY`). The active provider is a server setting.

---

## Page Reading (`web.read` / `web_read`)

Turn a URL into clean, readable text. Strips navigation, ads, scripts, headers, footers — like browser Reader Mode but as an API.

### Server-side pipeline

```
fetch HTML → parse DOM with linkedom → extract content with Readability → convert to markdown with turndown
```

1. **Fetch** the URL server-side (using the same SSRF-protected fetch as everything else)
2. **Parse** the HTML into a DOM with **linkedom** (fast, lightweight DOM implementation — much faster than jsdom)
3. **Extract** the main content with **@mozilla/readability** (the exact algorithm behind Firefox Reader View)
4. **Convert** the extracted HTML to markdown with **turndown** (more token-efficient for the LLM than HTML)

For JavaScript-rendered pages (SPAs, pages that require JS to display content), this pipeline won't work. The agent falls back to `browser.navigate()` + `browser.extractText()` for those cases.

### Sandbox API

```typescript
web.read(url: string, options?: {
  format?: 'markdown' | 'text' | 'html'  // output format, default 'markdown'
  maxLength?: number                       // max characters to return
}): Promise<{
  title: string
  byline: string | null
  content: string
  url: string
  word_count: number
  truncated: boolean
}>
```

The `maxLength` option is important — a long Wikipedia article can be 50,000+ words. The agent should be able to request a truncated version and come back for more if needed.

### Meta-tool

```json
{
  "name": "web_read",
  "parameters": {
    "type": "object",
    "properties": {
      "url": { "type": "string", "description": "URL to read" },
      "format": { "type": "string", "enum": ["markdown", "text", "html"], "description": "Output format. Default: markdown." },
      "max_length": { "type": "number", "description": "Max characters to return. Content is truncated at a paragraph boundary if exceeded." }
    },
    "required": ["url"]
  }
}
```

**Returns:** `{ title, byline, content, url, word_count, truncated }`

---

## Integration with Files

These capabilities cross over with the file system:

- **Download a file from the web:** `web_search` finds a CSV dataset → `file_download` saves it to the workspace → agent works on it with `files.readText` or `files.spreadsheet.*`
- **Save a page as a file:** `web_read` extracts content → `file_create` saves it as markdown
- **Download a PDF:** `file_download` grabs the URL directly → `files.pdf.extractText` reads it

`file_download` (defined in [Files](./Files.md)) handles the "fetch a URL and save it as a file" case. `web_read` handles the "fetch a URL and give me the text content" case. They're complementary — one saves the raw file, the other extracts readable content.

---

## When to use what

| Need | Tool | Weight |
|---|---|---|
| Search the web | `web_search` / `web.search()` | Light — one API call to search provider |
| Read an article or documentation page | `web_read` / `web.read()` | Light — fetch + Readability extraction |
| Download a file from a URL | `file_download` / `files.download()` | Light — fetch + save to disk |
| Interact with a web app (login, click, fill forms) | `browser.*` tools | Heavy — full Playwright browser |
| Call a REST API | `fetch_url` / `fetch()` | Light — raw HTTP |

The agent naturally escalates: try `web_read` first, fall back to `browser.*` if the page requires JavaScript or interaction.

---

## Server-Side Dependencies

| Package | Purpose | License |
|---|---|---|
| **@mozilla/readability** | Content extraction (Firefox Reader View algorithm) | Apache 2.0 |
| **linkedom** | Fast DOM parser (needed by Readability) | ISC |
| **turndown** | HTML to Markdown conversion | MIT |

No SDK needed for search providers — they're simple REST APIs called via `fetch` on the server.

---

## Settings

| Setting | Description |
|---|---|
| Search provider | Which search API to use (`brave`, `searxng`, `google`, `bing`, `tavily`) |
| SearXNG URL | Base URL if self-hosting SearXNG |

Search API keys are stored in `agent_secrets` alongside other credentials.
