import type { ToolSet } from "ai"
import type { MetaToolContext } from "../types"
import { createCoreTools } from "./core"
import { createToolManagementTools } from "./tool-management"
import { createFunctionManagementTools } from "./function-management"
import { createLibraryManagementTools } from "./library-management"
import { createDatabaseTools } from "./database"
import { createLlmTools } from "./llm"
import { createCodeExecutionTools } from "./code-execution"
import { createDynamicTools } from "./dynamic"

export type { MetaToolContext }

/**
 * Creates the full tool set for an agent session: built-in meta-tools + agent-created dynamic tools.
 * Called on each LLM step so newly created tools are immediately available.
 */
export function createAllTools(ctx: MetaToolContext): ToolSet {
  return {
    ...createCoreTools(ctx),
    ...createToolManagementTools(ctx),
    ...createFunctionManagementTools(ctx),
    ...createLibraryManagementTools(ctx),
    ...createDatabaseTools(ctx),
    ...createLlmTools(ctx),
    ...createCodeExecutionTools(ctx),
    ...createDynamicTools(ctx),
  } as ToolSet
}
