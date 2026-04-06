import { tool } from "ai"
import { z } from "zod"
import fs from "node:fs"
import path from "node:path"
import type { MetaToolContext } from "../types"
import { eventBus } from "../../events"
import {
  type FileRow, getVisibleFile, getDiskPath, createDerivedFile,
} from "./file-utils"

function assertPdf(row: FileRow) {
  if (row.mime_type !== "application/pdf") {
    throw new Error(`File ${row._id} is not a PDF (mime: ${row.mime_type})`)
  }
}

async function loadPdfLib() {
  const { PDFDocument, StandardFonts, rgb, degrees, PageSizes } = await import("pdf-lib")
  return { PDFDocument, StandardFonts, rgb, degrees, PageSizes }
}

async function loadPdfJs() {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
  return pdfjs
}

export function createPdfTools(ctx: MetaToolContext) {
  const { agentId, sessionId, db } = ctx

  return {

    pdf_info: tool({
      description: "Get PDF metadata: page count, page sizes, title, author, whether it has form fields.",
      inputSchema: z.object({
        id: z.string().describe("File ID of a PDF"),
      }),
      execute: async ({ id }) => {
        const row = getVisibleFile(db, id, agentId, sessionId)
        if (!row) return { error: "File not found or not visible" }
        try { assertPdf(row) } catch (e: any) { return { error: e.message } }

        const { PDFDocument } = await loadPdfLib()
        const bytes = fs.readFileSync(getDiskPath(row))
        const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })

        const pages = doc.getPages().map((p, i) => ({
          page: i + 1,
          width: Math.round(p.getWidth()),
          height: Math.round(p.getHeight()),
        }))

        const form = doc.getForm()
        const fieldCount = form.getFields().length

        return {
          id: row._id,
          path: row.path,
          page_count: doc.getPageCount(),
          pages,
          title: doc.getTitle() ?? null,
          author: doc.getAuthor() ?? null,
          subject: doc.getSubject() ?? null,
          has_forms: fieldCount > 0,
          form_field_count: fieldCount,
        }
      },
    }),

    pdf_extract_text: tool({
      description: "Extract text content from a PDF. Uses pdfjs-dist which handles embedded text. For scanned PDFs with no embedded text, use file_view instead to send pages to the LLM as images.",
      inputSchema: z.object({
        id: z.string().describe("File ID of a PDF"),
        pages: z.array(z.number()).optional().describe("Specific pages to extract (1-based). Omit for all pages."),
      }),
      execute: async ({ id, pages: pageNums }) => {
        const row = getVisibleFile(db, id, agentId, sessionId)
        if (!row) return { error: "File not found or not visible" }
        try { assertPdf(row) } catch (e: any) { return { error: e.message } }

        const pdfjs = await loadPdfJs()
        const data = new Uint8Array(fs.readFileSync(getDiskPath(row)))
        const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise

        const totalPages = doc.numPages
        const targetPages = pageNums ?? Array.from({ length: totalPages }, (_, i) => i + 1)

        const results: { page: number; text: string }[] = []
        for (const num of targetPages) {
          if (num < 1 || num > totalPages) continue
          const page = await doc.getPage(num)
          const content = await page.getTextContent()
          const text = content.items
            .filter((item: any) => "str" in item)
            .map((item: any) => item.str)
            .join("")
          results.push({ page: num, text })
        }

        doc.destroy()
        return { pages: results, total_pages: totalPages }
      },
    }),

    pdf_page_to_image: tool({
      description: "Render a PDF page to a PNG image file. Creates a new derived file. Useful for scanned PDFs or when visual layout matters.",
      inputSchema: z.object({
        id: z.string().describe("File ID of a PDF"),
        page: z.number().describe("Page number (1-based)"),
        dpi: z.number().optional().describe("Rendering resolution. Default: 150."),
      }),
      execute: async ({ id, page: pageNum, dpi }) => {
        const row = getVisibleFile(db, id, agentId, sessionId)
        if (!row) return { error: "File not found or not visible" }
        try { assertPdf(row) } catch (e: any) { return { error: e.message } }

        const pngBuffer = await renderPdfPageToPng(getDiskPath(row), pageNum, dpi ?? 150)

        const baseName = path.basename(row.path, path.extname(row.path))
        const derivedPath = `${path.dirname(row.path) === "." ? "" : path.dirname(row.path) + "/"}${baseName}_page${pageNum}.png`

        const newFile = createDerivedFile(db, agentId, sessionId, derivedPath, "image/png", pngBuffer)

        return {
          id: newFile._id,
          path: newFile.path,
          size: newFile.size,
          width: null as number | null,
          height: null as number | null,
        }
      },
    }),

    pdf_add_page: tool({
      description: "Add a blank page to a PDF",
      inputSchema: z.object({
        id: z.string().describe("File ID of a PDF"),
        width: z.number().optional().describe("Page width in points. Default: 612 (US Letter)."),
        height: z.number().optional().describe("Page height in points. Default: 792 (US Letter)."),
        index: z.number().optional().describe("Insert position (0-based). Default: end."),
      }),
      execute: async ({ id, width, height, index }) => {
        const row = getVisibleFile(db, id, agentId, sessionId)
        if (!row) return { error: "File not found or not visible" }
        try { assertPdf(row) } catch (e: any) { return { error: e.message } }

        const { PDFDocument } = await loadPdfLib()
        const bytes = fs.readFileSync(getDiskPath(row))
        const doc = await PDFDocument.load(bytes)

        const page = doc.insertPage(index ?? doc.getPageCount(), [width ?? 612, height ?? 792])

        const saved = await doc.save()
        fs.writeFileSync(getDiskPath(row), saved)
        updateFileSize(db, row, saved.length)

        return { ok: true, page_count: doc.getPageCount() }
      },
    }),

    pdf_delete_page: tool({
      description: "Remove a page from a PDF",
      inputSchema: z.object({
        id: z.string().describe("File ID of a PDF"),
        page: z.number().describe("Page number to delete (1-based)"),
      }),
      execute: async ({ id, page: pageNum }) => {
        const row = getVisibleFile(db, id, agentId, sessionId)
        if (!row) return { error: "File not found or not visible" }
        try { assertPdf(row) } catch (e: any) { return { error: e.message } }

        const { PDFDocument } = await loadPdfLib()
        const bytes = fs.readFileSync(getDiskPath(row))
        const doc = await PDFDocument.load(bytes)

        if (pageNum < 1 || pageNum > doc.getPageCount()) {
          return { error: `Page ${pageNum} out of range (1-${doc.getPageCount()})` }
        }

        doc.removePage(pageNum - 1)
        const saved = await doc.save()
        fs.writeFileSync(getDiskPath(row), saved)
        updateFileSize(db, row, saved.length)

        return { ok: true, page_count: doc.getPageCount() }
      },
    }),

    pdf_add_text: tool({
      description: "Place text on a PDF page at specific coordinates",
      inputSchema: z.object({
        id: z.string().describe("File ID of a PDF"),
        page: z.number().describe("Page number (1-based)"),
        text: z.string().describe("Text to place"),
        x: z.number().describe("X coordinate from left edge (points)"),
        y: z.number().describe("Y coordinate from bottom edge (points)"),
        size: z.number().optional().describe("Font size in points. Default: 12."),
        font: z.enum(["Helvetica", "TimesRoman", "Courier"]).optional().describe("Font family. Default: Helvetica."),
        color_r: z.number().optional().describe("Red (0-1). Default: 0."),
        color_g: z.number().optional().describe("Green (0-1). Default: 0."),
        color_b: z.number().optional().describe("Blue (0-1). Default: 0."),
      }),
      execute: async ({ id, page: pageNum, text, x, y, size, font, color_r, color_g, color_b }) => {
        const row = getVisibleFile(db, id, agentId, sessionId)
        if (!row) return { error: "File not found or not visible" }
        try { assertPdf(row) } catch (e: any) { return { error: e.message } }

        const { PDFDocument, StandardFonts, rgb } = await loadPdfLib()
        const bytes = fs.readFileSync(getDiskPath(row))
        const doc = await PDFDocument.load(bytes)

        if (pageNum < 1 || pageNum > doc.getPageCount()) {
          return { error: `Page ${pageNum} out of range (1-${doc.getPageCount()})` }
        }

        const fontName = font === "TimesRoman" ? StandardFonts.TimesRoman
          : font === "Courier" ? StandardFonts.Courier
          : StandardFonts.Helvetica
        const pdfFont = await doc.embedFont(fontName)

        const page = doc.getPage(pageNum - 1)
        page.drawText(text, {
          x, y,
          size: size ?? 12,
          font: pdfFont,
          color: rgb(color_r ?? 0, color_g ?? 0, color_b ?? 0),
        })

        const saved = await doc.save()
        fs.writeFileSync(getDiskPath(row), saved)
        updateFileSize(db, row, saved.length)

        return { ok: true }
      },
    }),

    pdf_add_image: tool({
      description: "Place an image (from another file in the workspace) onto a PDF page",
      inputSchema: z.object({
        id: z.string().describe("File ID of the target PDF"),
        page: z.number().describe("Page number (1-based)"),
        image_id: z.string().describe("File ID of the image to embed (PNG or JPEG)"),
        x: z.number().describe("X coordinate from left edge (points)"),
        y: z.number().describe("Y coordinate from bottom edge (points)"),
        width: z.number().optional().describe("Display width in points. Omit for original size."),
        height: z.number().optional().describe("Display height in points. Omit for original size."),
      }),
      execute: async ({ id, page: pageNum, image_id, x, y, width, height }) => {
        const row = getVisibleFile(db, id, agentId, sessionId)
        if (!row) return { error: "PDF not found or not visible" }
        try { assertPdf(row) } catch (e: any) { return { error: e.message } }

        const imgRow = getVisibleFile(db, image_id, agentId, sessionId)
        if (!imgRow) return { error: "Image file not found or not visible" }

        const { PDFDocument } = await loadPdfLib()
        const bytes = fs.readFileSync(getDiskPath(row))
        const doc = await PDFDocument.load(bytes)

        if (pageNum < 1 || pageNum > doc.getPageCount()) {
          return { error: `Page ${pageNum} out of range (1-${doc.getPageCount()})` }
        }

        const imgBytes = fs.readFileSync(getDiskPath(imgRow))
        const isPng = imgRow.mime_type === "image/png"
        const isJpeg = imgRow.mime_type === "image/jpeg" || imgRow.mime_type === "image/jpg"
        if (!isPng && !isJpeg) return { error: "Image must be PNG or JPEG" }

        const image = isPng ? await doc.embedPng(imgBytes) : await doc.embedJpg(imgBytes)
        const dims = image.scale(1)

        const page = doc.getPage(pageNum - 1)
        page.drawImage(image, {
          x, y,
          width: width ?? dims.width,
          height: height ?? dims.height,
        })

        const saved = await doc.save()
        fs.writeFileSync(getDiskPath(row), saved)
        updateFileSize(db, row, saved.length)

        return { ok: true, image_width: dims.width, image_height: dims.height }
      },
    }),

    pdf_get_form_fields: tool({
      description: "List all form fields in a PDF with their types and current values",
      inputSchema: z.object({
        id: z.string().describe("File ID of a PDF"),
      }),
      execute: async ({ id }) => {
        const row = getVisibleFile(db, id, agentId, sessionId)
        if (!row) return { error: "File not found or not visible" }
        try { assertPdf(row) } catch (e: any) { return { error: e.message } }

        const { PDFDocument } = await loadPdfLib()
        const bytes = fs.readFileSync(getDiskPath(row))
        const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })

        const form = doc.getForm()
        const fields = form.getFields().map(field => {
          const type = field.constructor.name.replace("PDF", "").replace("Field", "").toLowerCase()
          let value: any = null
          try {
            if ("getText" in field) value = (field as any).getText()
            else if ("isChecked" in field) value = (field as any).isChecked()
            else if ("getSelected" in field) value = (field as any).getSelected()
          } catch { /* some fields don't support reading */ }

          return {
            name: field.getName(),
            type,
            value,
            read_only: field.isReadOnly(),
          }
        })

        return { fields, count: fields.length }
      },
    }),

    pdf_fill_form: tool({
      description: "Fill form fields in a PDF by field name",
      inputSchema: z.object({
        id: z.string().describe("File ID of a PDF"),
        fields: z.record(z.string(), z.string()).describe("Object mapping field name to value"),
        flatten: z.boolean().optional().describe("If true, flatten form fields after filling (makes them non-editable). Default: false."),
      }),
      execute: async ({ id, fields, flatten }) => {
        const row = getVisibleFile(db, id, agentId, sessionId)
        if (!row) return { error: "File not found or not visible" }
        try { assertPdf(row) } catch (e: any) { return { error: e.message } }

        const { PDFDocument } = await loadPdfLib()
        const bytes = fs.readFileSync(getDiskPath(row))
        const doc = await PDFDocument.load(bytes)
        const form = doc.getForm()

        const filled: string[] = []
        const errors: { field: string; error: string }[] = []

        for (const [name, value] of Object.entries(fields)) {
          try {
            const field = form.getFieldMaybe(name)
            if (!field) {
              errors.push({ field: name, error: "Field not found" })
              continue
            }

            const typeName = field.constructor.name
            if (typeName.includes("Text")) {
              (field as any).setText(value)
            } else if (typeName.includes("CheckBox")) {
              if (value === "true" || value === "1" || value === "yes") (field as any).check()
              else (field as any).uncheck()
            } else if (typeName.includes("Dropdown") || typeName.includes("OptionList")) {
              (field as any).select(value)
            } else if (typeName.includes("RadioGroup")) {
              (field as any).select(value)
            } else {
              errors.push({ field: name, error: `Unsupported field type: ${typeName}` })
              continue
            }
            filled.push(name)
          } catch (e: any) {
            errors.push({ field: name, error: e.message })
          }
        }

        if (flatten) form.flatten()

        const saved = await doc.save()
        fs.writeFileSync(getDiskPath(row), saved)
        updateFileSize(db, row, saved.length)

        return { filled, errors, filled_count: filled.length, error_count: errors.length }
      },
    }),

    pdf_merge: tool({
      description: "Merge multiple PDFs into a new file",
      inputSchema: z.object({
        ids: z.array(z.string()).min(2).describe("File IDs of PDFs to merge (in order)"),
        output_path: z.string().describe("Path for the merged output file"),
      }),
      execute: async ({ ids, output_path }) => {
        const { PDFDocument } = await loadPdfLib()
        const merged = await PDFDocument.create()

        for (const id of ids) {
          const row = getVisibleFile(db, id, agentId, sessionId)
          if (!row) return { error: `File not found: ${id}` }
          try { assertPdf(row) } catch (e: any) { return { error: e.message } }

          const bytes = fs.readFileSync(getDiskPath(row))
          const src = await PDFDocument.load(bytes)
          const pages = await merged.copyPages(src, src.getPageIndices())
          for (const page of pages) merged.addPage(page)
        }

        const saved = await merged.save()
        const newFile = createDerivedFile(db, agentId, sessionId, output_path, "application/pdf", Buffer.from(saved))

        return {
          id: newFile._id,
          path: newFile.path,
          page_count: merged.getPageCount(),
          size: newFile.size,
        }
      },
    }),

    pdf_split_pages: tool({
      description: "Split a PDF into multiple files by page ranges",
      inputSchema: z.object({
        id: z.string().describe("File ID of a PDF"),
        ranges: z.array(z.object({
          start: z.number().describe("Start page (1-based, inclusive)"),
          end: z.number().describe("End page (1-based, inclusive)"),
        })).describe("Page ranges to extract"),
      }),
      execute: async ({ id, ranges }) => {
        const row = getVisibleFile(db, id, agentId, sessionId)
        if (!row) return { error: "File not found or not visible" }
        try { assertPdf(row) } catch (e: any) { return { error: e.message } }

        const { PDFDocument } = await loadPdfLib()
        const bytes = fs.readFileSync(getDiskPath(row))
        const src = await PDFDocument.load(bytes)
        const totalPages = src.getPageCount()

        const results: { id: string; path: string; pages: string; size: number }[] = []

        for (let i = 0; i < ranges.length; i++) {
          const { start, end } = ranges[i]
          if (start < 1 || end > totalPages || start > end) {
            return { error: `Invalid range ${start}-${end} (PDF has ${totalPages} pages)` }
          }

          const newDoc = await PDFDocument.create()
          const indices = Array.from({ length: end - start + 1 }, (_, j) => start - 1 + j)
          const pages = await newDoc.copyPages(src, indices)
          for (const page of pages) newDoc.addPage(page)

          const saved = await newDoc.save()
          const baseName = path.basename(row.path, path.extname(row.path))
          const dir = path.dirname(row.path) === "." ? "" : path.dirname(row.path) + "/"
          const splitPath = `${dir}${baseName}_pages${start}-${end}.pdf`

          const newFile = createDerivedFile(db, agentId, sessionId, splitPath, "application/pdf", Buffer.from(saved))
          results.push({ id: newFile._id, path: newFile.path, pages: `${start}-${end}`, size: newFile.size })
        }

        return { files: results }
      },
    }),
  }
}

function updateFileSize(db: any, row: FileRow, newSize: number) {
  const now = new Date().toISOString()
  db.prepare("UPDATE agent_files SET size = ?, modified_on = ? WHERE _id = ?")
    .run(newSize, now, row._id)
  eventBus.broadcast("file:modified", { id: row._id, path: row.path, size: newSize, modified_on: now })
}

/**
 * Render a single PDF page to PNG using pdfjs-dist + node-canvas.
 */
export async function renderPdfPageToPng(diskPath: string, pageNum: number, dpi: number): Promise<Buffer> {
  const pdfjs = await loadPdfJs()
  const data = new Uint8Array(fs.readFileSync(diskPath))
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise

  if (pageNum < 1 || pageNum > doc.numPages) {
    doc.destroy()
    throw new Error(`Page ${pageNum} out of range (1-${doc.numPages})`)
  }

  const page = await doc.getPage(pageNum)
  const scale = dpi / 72
  const viewport = page.getViewport({ scale })

  const { createCanvas } = await import("canvas")
  const nodeCanvas = createCanvas(viewport.width, viewport.height)
  const context = nodeCanvas.getContext("2d")

  await page.render({
    canvas: nodeCanvas as any,
    canvasContext: context as any,
    viewport,
  }).promise

  const pngBuffer = nodeCanvas.toBuffer("image/png")
  doc.destroy()
  return pngBuffer
}
