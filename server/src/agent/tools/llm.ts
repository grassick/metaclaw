import { tool, generateText, generateObject, jsonSchema as aiJsonSchema } from "ai"
import { z } from "zod"
import { createOpenRouterProvider } from "../../openRouterProvider"
import type { MetaToolContext } from "../types"

const INTELLIGENCE_MODELS: Record<string, string> = {
  low: "anthropic/claude-3.5-haiku",
  medium: "anthropic/claude-sonnet-4.6",
  high: "anthropic/claude-opus-4",
}

export function createLlmTools(ctx: MetaToolContext) {
  const { openRouterApiKey } = ctx

  return {
    llm_generate: tool({
      description: "Make a single LLM call for classification, extraction, summarization, translation, or batch processing. No tool access or conversation history — just prompt in, text out. For full agent loops, use sub-sessions instead. Default intelligence is 'low' (cheap/fast).",
      inputSchema: z.object({
        prompt: z.string().describe("The prompt to send to the LLM"),
        system: z.string().optional().describe("Optional system prompt for the call"),
        intelligence: z.enum(["low", "medium", "high"]).optional().describe("Model capability level. 'low' is cheap/fast, 'medium' is the default workhorse, 'high' is the most capable. Default: low."),
        schema: z.record(z.string(), z.any()).optional().describe("JSON Schema for structured output. When provided, the LLM is constrained to return valid JSON matching this schema."),
        max_tokens: z.number().optional().describe("Max output tokens. Default: 4096."),
        temperature: z.number().optional().describe("Sampling temperature (0-1). Default: 0."),
      }),
      execute: async ({ prompt, system, intelligence, schema, max_tokens, temperature }) => {
        const modelId = INTELLIGENCE_MODELS[intelligence ?? "low"] ?? INTELLIGENCE_MODELS.low
        const openrouter = createOpenRouterProvider(openRouterApiKey)
        const model = openrouter(modelId)

        try {
          if (schema) {
            const result = await generateObject({
              model,
              prompt,
              system,
              schema: aiJsonSchema(schema),
              maxOutputTokens: max_tokens ?? 4096,
              temperature: temperature ?? 0,
            })
            const raw = result.usage.raw as { cost?: number } | undefined
            const costPart = raw?.cost != null ? ` cost=$${Number(raw.cost).toFixed(6)}` : ""
            console.log(
              `[llm tool] generateObject tokens in=${result.usage.inputTokens ?? "?"} out=${result.usage.outputTokens ?? "?"}${costPart}`,
            )
            return {
              text: JSON.stringify(result.object),
              parsed: result.object,
              usage: {
                input_tokens: result.usage.inputTokens ?? 0,
                output_tokens: result.usage.outputTokens ?? 0,
              },
            }
          } else {
            const result = await generateText({
              model,
              prompt,
              system,
              maxOutputTokens: max_tokens ?? 4096,
              temperature: temperature ?? 0,
            })
            const raw = result.usage.raw as { cost?: number } | undefined
            const costPart = raw?.cost != null ? ` cost=$${Number(raw.cost).toFixed(6)}` : ""
            console.log(
              `[llm tool] generateText tokens in=${result.usage.inputTokens ?? "?"} out=${result.usage.outputTokens ?? "?"}${costPart}`,
            )
            return {
              text: result.text,
              usage: {
                input_tokens: result.usage.inputTokens ?? 0,
                output_tokens: result.usage.outputTokens ?? 0,
              },
            }
          }
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) }
        }
      },
    }),
  }
}
