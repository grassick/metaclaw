import ivm from "isolated-vm"
import { safeFetch } from "./safeFetch"
import { parseCSV } from "./csvParser"

// ============================================================================
// Types
// ============================================================================

/**
 * Result of executing an import script.
 * Either succeeds with an ImportResult or fails with an error message.
 * Always includes captured console logs.
 */
export type ExecutionResult = {
  success: true
  result: any
  logs: string[]
} | {
  success: false
  error: string
  logs: string[]
}

/** Internal type for captured log entries */
interface LogEntry {
  level: "log" | "warn" | "error"
  args: any[]
}

// ============================================================================
// Isolated-VM Sandbox Execution
// ============================================================================

/** Default timeout for script execution in milliseconds */
const DEFAULT_TIMEOUT_MS = 60000

/** Default memory limit in MB */
const DEFAULT_MEMORY_LIMIT_MB = 256

/** Default max response size for fetch in bytes (2MB) */
const DEFAULT_MAX_RESPONSE_SIZE = 2 * 1024 * 1024

/**
 * Executes a script in a secure isolated-vm sandbox using V8.
 * 
 * The script has access to:
 * - `fetch(url, options?)` - Standard fetch API with SSRF protection
 *   - Response has: `ok`, `status`, `statusText`, `headers`, `text()`, `json()`
 *   - `headers.get(name)` and `headers.has(name)` are supported
 *   - `text()` and `json()` return Promises (standard behavior)
 * - `parseCSV(text, options?)` - Parse CSV text into array of objects or arrays
 *   - Options: `{ delimiter?: string, header?: boolean, skipEmptyLines?: boolean }`
 *   - Returns array of objects (when header: true) or array of string arrays
 * - `setTimeout(callback, delay, ...args)` - Schedule callback execution after delay
 *   - Works with standard Promise pattern: `await new Promise(resolve => setTimeout(resolve, delay))`
 *   - Returns a timer ID (number)
 *   - Note: callbacks only fire if the script awaits them (directly or via Promise)
 * - `btoa(str)` - Encodes a binary string to Base64
 * - `atob(str)` - Decodes a Base64 string to binary
 * - `console.log/warn/error` - Logging (captured in result)
 * 
 * The script must return a value that can be serialized to JSON.
 * 
 * @param code - JavaScript code to execute (should be an async IIFE or return a Promise)
 * @param options - Execution options
 * @returns ExecutionResult with either the result or error, plus captured logs
 * 
 * @example
 * ```javascript
 * const result = await executeScript(`
 *   const response = await fetch('https://api.example.com/data');
 *   if (!response.ok) {
 *     throw new Error(\`HTTP error! status: \${response.status}\`);
 *   }
 *   const contentType = response.headers.get('content-type');
 *   if (contentType?.includes('application/json')) {
 *     return await response.json();
 *   }
 *   return await response.text();
 * `);
 * ```
 */
export async function executeScript(
  code: string,
  options?: {
    /** Timeout in milliseconds (default: 60000) */
    timeoutMs?: number
    /** Memory limit in bytes (default: 256MB). Note: isolated-vm uses MB, will be converted. */
    memoryLimit?: number
    /** Max stack size in bytes (default: 1MB) - not used by isolated-vm but kept for API compatibility */
    maxStackSize?: number
    /** Max response body size for fetch in bytes (default: 2MB) */
    maxResponseSize?: number
    /** Fetch function to use (default: safeFetch with SSRF protection) */
    fetch?: typeof fetch
    /** Values to inject into the global scope (must be JSON-serializable) */
    globals?: Record<string, unknown>
    /** 
     * Functions to inject into the global scope.
     * Can be synchronous or asynchronous - async detection is automatic.
     * All arguments and return values must be JSON-serializable.
     */
    globalFunctions?: Record<string, (...args: any[]) => any>
  }
): Promise<ExecutionResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const memoryLimitBytes = options?.memoryLimit ?? DEFAULT_MEMORY_LIMIT_MB * 1024 * 1024
  const memoryLimitMB = Math.ceil(memoryLimitBytes / (1024 * 1024))
  const maxResponseSize = options?.maxResponseSize ?? DEFAULT_MAX_RESPONSE_SIZE
  const fetchToUse = options?.fetch ?? safeFetch

  const logs: LogEntry[] = []

  // Create isolated V8 instance with memory limit
  const isolate = new ivm.Isolate({ memoryLimit: memoryLimitMB })

  try {
    const context = await isolate.createContext()
    const jail = context.global

    // Set up global reference for the sandbox
    await jail.set("global", jail.derefInto())

    // ========================================================================
    // Setup console object
    // ========================================================================
    const logCallback = new ivm.Callback((level: string, argsJson: string) => {
      try {
        const args = JSON.parse(argsJson)
        logs.push({ level: level as LogEntry["level"], args })
      } catch {
        logs.push({ level: level as LogEntry["level"], args: [argsJson] })
      }
    })
    await jail.set("__logCallback", logCallback)

    await context.eval(`
      const console = {
        log: (...args) => __logCallback('log', JSON.stringify(args)),
        warn: (...args) => __logCallback('warn', JSON.stringify(args)),
        error: (...args) => __logCallback('error', JSON.stringify(args))
      };
    `)

    // ========================================================================
    // Setup fetch function
    // ========================================================================
    const fetchRef = new ivm.Reference(async (url: string, optionsJson?: string) => {
      let fetchOptions: RequestInit | undefined
      if (optionsJson) {
        const opts = JSON.parse(optionsJson)
        if (opts && typeof opts === "object") {
          fetchOptions = {}
          if (opts.method) fetchOptions.method = String(opts.method)
          if (opts.headers) fetchOptions.headers = opts.headers as Record<string, string>
          if (opts.body) fetchOptions.body = String(opts.body)
        }
      }

      const response = await fetchToUse(url, fetchOptions)
      const bodyText = await response.text()

      // Check response size
      if (bodyText.length > maxResponseSize) {
        throw new Error(`Response body too large: ${bodyText.length} bytes exceeds limit of ${maxResponseSize} bytes`)
      }

      // Convert headers to plain object for serialization
      const headersObj: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        headersObj[key.toLowerCase()] = value
      })

      return JSON.stringify({
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: headersObj,
        _body: bodyText
      })
    })
    await jail.set("__fetchRef", fetchRef)

    await context.eval(`
      async function fetch(url, options) {
        const optionsJson = options ? JSON.stringify(options) : undefined;
        const responseJson = await __fetchRef.applySyncPromise(
          undefined,
          [url, optionsJson],
          { arguments: { copy: true } }
        );
        const res = JSON.parse(responseJson);
        return {
          ok: res.ok,
          status: res.status,
          statusText: res.statusText,
          headers: {
            get: (name) => res.headers[name.toLowerCase()] ?? null,
            has: (name) => name.toLowerCase() in res.headers
          },
          text: async () => res._body,
          json: async () => JSON.parse(res._body)
        };
      }
    `)

    // ========================================================================
    // Setup parseCSV function
    // ========================================================================
    const parseCSVRef = new ivm.Reference((textJson: string, optionsJson?: string) => {
      const text = JSON.parse(textJson) as string
      const csvOptions = optionsJson 
        ? JSON.parse(optionsJson) as { delimiter?: string; header?: boolean; skipEmptyLines?: boolean }
        : undefined
      const result = parseCSV(text, csvOptions)
      return JSON.stringify(result)
    })
    await jail.set("__parseCSVRef", parseCSVRef)

    await context.eval(`
      function parseCSV(text, options) {
        const textJson = JSON.stringify(text);
        const optionsJson = options ? JSON.stringify(options) : undefined;
        const resultJson = __parseCSVRef.applySync(
          undefined,
          [textJson, optionsJson],
          { arguments: { copy: true }, result: { copy: true } }
        );
        return JSON.parse(resultJson);
      }
    `)

    // ========================================================================
    // Setup btoa and atob functions (Base64 encoding/decoding)
    // ========================================================================
    const btoaRef = new ivm.Reference((str: string) => {
      return Buffer.from(str, "binary").toString("base64")
    })
    await jail.set("__btoaRef", btoaRef)

    const atobRef = new ivm.Reference((str: string) => {
      return Buffer.from(str, "base64").toString("binary")
    })
    await jail.set("__atobRef", atobRef)

    await context.eval(`
      /**
       * Encodes a string to Base64.
       * @param {string} str - The binary string to encode
       * @returns {string} The Base64 encoded string
       */
      function btoa(str) {
        return __btoaRef.applySync(undefined, [str], { arguments: { copy: true }, result: { copy: true } });
      }

      /**
       * Decodes a Base64 string.
       * @param {string} str - The Base64 encoded string
       * @returns {string} The decoded binary string
       */
      function atob(str) {
        return __atobRef.applySync(undefined, [str], { arguments: { copy: true }, result: { copy: true } });
      }
    `)

    // ========================================================================
    // Setup setTimeout function
    // ========================================================================
    const delayRef = new ivm.Reference(async (ms: number) => {
      await new Promise(resolve => global.setTimeout(resolve, ms))
    })
    await jail.set("__delayRef", delayRef)

    await context.eval(`
      const __timeoutIdCounter = { value: 1 };
      const __activeTimeouts = new Map();
      
      /**
       * setTimeout - schedules a callback to be executed after a delay.
       * Works with the standard Promise pattern: await new Promise(resolve => setTimeout(resolve, delay))
       * Note: callbacks are executed asynchronously after the delay, but the script's main execution
       * must await the result (directly or via a Promise) for the callback to fire before script completion.
       * @param {Function} callback - Function to call after the delay
       * @param {number} delay - Delay in milliseconds
       * @param {...any} args - Additional arguments to pass to the callback
       * @returns {number} Timer ID
       */
      function setTimeout(callback, delay, ...args) {
        const id = __timeoutIdCounter.value++;
        
        // Fire-and-forget async execution
        const timeoutPromise = (async () => {
          await __delayRef.applySyncPromise(undefined, [delay], { arguments: { copy: true } });
          __activeTimeouts.delete(id);
          if (typeof callback === 'function') {
            callback(...args);
          }
        })();
        
        __activeTimeouts.set(id, timeoutPromise);
        return id;
      }
    `)

    // ========================================================================
    // Inject globals into the sandbox
    // ========================================================================
    if (options?.globals) {
      for (const [key, value] of Object.entries(options.globals)) {
        // Use ExternalCopy to safely transfer data into the isolate
        const copy = new ivm.ExternalCopy(value)
        await jail.set(key, copy.copyInto())
      }
    }

    // ========================================================================
    // Inject global functions into the sandbox
    // ========================================================================
    if (options?.globalFunctions) {
      for (const [name, fn] of Object.entries(options.globalFunctions)) {
        const fnRef = new ivm.Reference((...args: any[]) => {
          // All args come as JSON strings for complex types, or primitives
          const result = fn(...args)
          
          // Check if result is a Promise
          if (result && typeof result === "object" && typeof result.then === "function") {
            // Return a promise that resolves to JSON
            return result.then((resolvedValue: any) => JSON.stringify(resolvedValue))
          }
          
          // Sync result - return as JSON
          return JSON.stringify(result)
        })
        await jail.set(`__fn_${name}`, fnRef)

        // Create wrapper that handles both sync and async
        await context.eval(`
          const ${name} = (...args) => {
            const result = __fn_${name}.applySync(
              undefined,
              args,
              { arguments: { copy: true }, result: { copy: true } }
            );
            // If result is a promise (from applySyncPromise), handle it
            if (result && typeof result === 'object' && typeof result.then === 'function') {
              return result.then(r => JSON.parse(r));
            }
            return JSON.parse(result);
          };
          // Also create async version in case the host function is async
          const ${name}Async = async (...args) => {
            const result = await __fn_${name}.applySyncPromise(
              undefined,
              args,
              { arguments: { copy: true } }
            );
            return JSON.parse(result);
          };
        `)
      }
    }

    // ========================================================================
    // Execute the code with timeout
    // ========================================================================
    const wrappedCode = `
      (async () => {
        ${code}
      })().then(
        result => ({ success: true, result }),
        error => ({ success: false, error: error?.message ?? String(error) })
      )
    `

    const script = await isolate.compileScript(wrappedCode)
    const resultPromise = await script.run(context, { 
      timeout: timeoutMs,
      promise: true,
      copy: true
    })

    const result = resultPromise as { success: boolean; result?: any; error?: string }

    if (result.success) {
      return {
        success: true,
        result: result.result,
        logs: formatLogs(logs)
      }
    } else {
      return {
        success: false,
        error: result.error ?? "Unknown error",
        logs: formatLogs(logs)
      }
    }

  } catch (err) {
    let errorMessage: string
    if (err instanceof Error) {
      // Check for specific isolated-vm errors
      if (err.message.includes("Isolate was disposed")) {
        errorMessage = "Script execution was terminated (memory limit exceeded or isolate disposed)"
      } else if (err.message.includes("Script execution timed out")) {
        errorMessage = "Timeout"
      } else {
        errorMessage = err.message
      }
    } else {
      errorMessage = String(err)
    }

    return {
      success: false,
      error: errorMessage,
      logs: formatLogs(logs)
    }

  } finally {
    // Dispose of the isolate to free memory
    isolate.dispose()
  }
}

/**
 * Formats captured log entries into readable strings.
 */
function formatLogs(logs: LogEntry[]): string[] {
  return logs.map(entry => {
    const prefix = entry.level === "log" ? "" : `[${entry.level.toUpperCase()}] `
    const message = entry.args.map(arg => {
      if (typeof arg === "string") return arg
      try {
        return JSON.stringify(arg)
      } catch {
        return String(arg)
      }
    }).join(" ")
    return prefix + message
  })
}

