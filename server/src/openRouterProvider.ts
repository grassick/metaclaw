import { createOpenRouter } from "@openrouter/ai-sdk-provider"

/**
 * Creates the OpenRouter provider with a custom fetch to fix Anthropic tool call responses missing arguments field
 */
export function createOpenRouterProvider(apiKey: string, extraBody?: Record<string, any>) {
  return createOpenRouter({ 
    apiKey,
    // Use custom fetch to fix Anthropic tool call responses missing arguments field
    fetch: fetchWithToolCallFix,
    extraBody,
  })
}

/**
 * Wraps fetch to fix Anthropic responses that omit the `arguments` field in tool calls.
 * The OpenRouter SDK expects `arguments` to always be a string, but Anthropic omits it
 * when a tool has no parameters.
 */
async function fetchWithToolCallFix(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let requestBody = init?.body ? JSON.parse(init.body as string) : undefined

  function addCacheControl(message: any) {
    // If it has content as string, convert to object
    if (typeof message.content === "string") {
      message.content = [{ type: "text", text: message.content }]
    }
    // Add cache control to last content part
    message.content[message.content.length - 1].cache_control = {
      type: "ephemeral"
    }
  }

  // Add cache points
  if (requestBody) {
    const messages = requestBody.messages
    if (messages) {
      // Add to system message
      addCacheControl(messages[0])
      // Add to last message
      addCacheControl(messages[messages.length - 1])
    }
  }

  const response = await fetch(url, {
    ...init,
    body: requestBody ? JSON.stringify(requestBody) : undefined
  })
  
  // Only process JSON responses
  const contentType = response.headers.get("content-type")
  if (!contentType?.includes("application/json")) {
    return response
  }
  
  // Clone and read the body
  const body = await response.json()
  
  // Fix tool calls that are missing the arguments field
  if (body?.choices) {
    for (const choice of body.choices) {
      if (choice?.message?.tool_calls) {
        for (const toolCall of choice.message.tool_calls) {
          if (toolCall?.function && toolCall.function.arguments === undefined) {
            toolCall.function.arguments = "{}"
          }
        }
      }
    }
  }
  
  // Return a new response with the fixed body
  return new Response(JSON.stringify(body), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
}
