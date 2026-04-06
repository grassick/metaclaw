import { tool } from "ai"
import { z } from "zod"
import type { MetaToolContext } from "../types"

const BLOCKED_PATTERNS = [
  /^https?:\/\/localhost/i,
  /^https?:\/\/127\./,
  /^https?:\/\/0\./,
  /^https?:\/\/10\./,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./,
  /^https?:\/\/192\.168\./,
  /^https?:\/\/169\.254\./,
  /^https?:\/\/\[::1\]/,
  /^https?:\/\/metadata\.google/i,
  /^https?:\/\/169\.254\.169\.254/,
]

function isBlockedUrl(url: string): boolean {
  return BLOCKED_PATTERNS.some(p => p.test(url))
}

export function createNetworkTools(_ctx: MetaToolContext) {
  return {
    fetch_url: tool({
      description: "Make an HTTP request with SSRF protection (blocks private IPs, localhost, metadata endpoints)",
      inputSchema: z.object({
        url: z.string().describe("The URL to fetch"),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).optional().describe("HTTP method. Default: GET."),
        headers: z.record(z.string(), z.string()).optional().describe("Request headers"),
        body: z.string().optional().describe("Request body (for POST/PUT/PATCH)"),
      }),
      execute: async ({ url, method, headers, body }) => {
        if (isBlockedUrl(url)) {
          return { error: "URL blocked: private IPs, localhost, and metadata endpoints are not allowed" }
        }

        try {
          const init: RequestInit = {
            method: method ?? "GET",
            headers: headers ?? {},
            signal: AbortSignal.timeout(30000),
          }
          if (body && method && ["POST", "PUT", "PATCH"].includes(method)) {
            init.body = body
          }

          const response = await fetch(url, init)
          const responseHeaders: Record<string, string> = {}
          response.headers.forEach((v, k) => { responseHeaders[k] = v })

          const text = await response.text()
          const MAX_BODY = 100_000
          const truncatedBody = text.length > MAX_BODY ? text.slice(0, MAX_BODY) + "…[truncated]" : text

          return {
            status: response.status,
            ok: response.ok,
            headers: responseHeaders,
            body: truncatedBody,
          }
        } catch (err) {
          return { error: `Fetch failed: ${err instanceof Error ? err.message : String(err)}` }
        }
      },
    }),
  }
}
