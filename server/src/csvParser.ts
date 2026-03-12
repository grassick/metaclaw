/**
 * CSV Parser for the Integrator Sandbox
 * 
 * A robust CSV parser that handles common edge cases:
 * - Quoted fields with embedded delimiters
 * - Escaped quotes (doubled "" within quoted fields)
 * - Configurable delimiter (comma, semicolon, tab)
 * - Header row detection
 * - Empty line skipping
 * - Newlines within quoted fields
 */

/**
 * Options for parsing CSV text.
 */
export interface ParseCSVOptions {
  /** Field delimiter character. Default: "," */
  delimiter?: string
  /** If true, first row is treated as headers and returns array of objects. Default: true */
  header?: boolean
  /** If true, empty lines are skipped. Default: true */
  skipEmptyLines?: boolean
}

/**
 * Parses CSV text into an array of records.
 * 
 * @param text - The CSV text to parse
 * @param options - Parsing options
 * @returns Array of objects (when header: true) or array of string arrays (when header: false)
 * 
 * @example
 * ```typescript
 * // With headers (default)
 * const data = parseCSV("name,age\nAlice,30\nBob,25")
 * // Returns: [{ name: "Alice", age: "30" }, { name: "Bob", age: "25" }]
 * 
 * // Without headers
 * const rows = parseCSV("Alice,30\nBob,25", { header: false })
 * // Returns: [["Alice", "30"], ["Bob", "25"]]
 * 
 * // Custom delimiter
 * const data = parseCSV("name;age\nAlice;30", { delimiter: ";" })
 * // Returns: [{ name: "Alice", age: "30" }]
 * ```
 */
export function parseCSV(text: string, options?: ParseCSVOptions): Record<string, string>[] | string[][] {
  const delimiter = options?.delimiter ?? ","
  const useHeader = options?.header ?? true
  const skipEmptyLines = options?.skipEmptyLines ?? true

  const rows = parseRows(text, delimiter, skipEmptyLines)

  if (rows.length === 0) {
    return []
  }

  if (useHeader) {
    const headers = rows[0]
    const dataRows = rows.slice(1)
    return dataRows.map(row => {
      const obj: Record<string, string> = {}
      for (let i = 0; i < headers.length; i++) {
        obj[headers[i]] = row[i] ?? ""
      }
      return obj
    })
  }

  return rows
}

/**
 * Parses CSV text into rows of fields.
 * Handles quoted fields, escaped quotes, and newlines within quotes.
 */
function parseRows(text: string, delimiter: string, skipEmptyLines: boolean): string[][] {
  const rows: string[][] = []
  let currentRow: string[] = []
  let currentField = ""
  let inQuotes = false
  let i = 0

  while (i < text.length) {
    const char = text[i]
    const nextChar = text[i + 1]

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          // Escaped quote (doubled)
          currentField += '"'
          i += 2
          continue
        } else {
          // End of quoted field
          inQuotes = false
          i++
          continue
        }
      } else {
        // Regular character inside quotes (including newlines)
        currentField += char
        i++
        continue
      }
    }

    // Not in quotes
    if (char === '"') {
      // Start of quoted field
      inQuotes = true
      i++
      continue
    }

    if (char === delimiter) {
      // End of field
      currentRow.push(currentField)
      currentField = ""
      i++
      continue
    }

    if (char === "\r" && nextChar === "\n") {
      // CRLF line ending
      currentRow.push(currentField)
      currentField = ""
      if (!skipEmptyLines || currentRow.some(f => f !== "")) {
        rows.push(currentRow)
      }
      currentRow = []
      i += 2
      continue
    }

    if (char === "\n" || char === "\r") {
      // LF or CR line ending
      currentRow.push(currentField)
      currentField = ""
      if (!skipEmptyLines || currentRow.some(f => f !== "")) {
        rows.push(currentRow)
      }
      currentRow = []
      i++
      continue
    }

    // Regular character
    currentField += char
    i++
  }

  // Handle last field/row (if file doesn't end with newline)
  if (currentField !== "" || currentRow.length > 0) {
    currentRow.push(currentField)
    if (!skipEmptyLines || currentRow.some(f => f !== "")) {
      rows.push(currentRow)
    }
  }

  return rows
}

