import { tool } from "ai"
import { z } from "zod"
import fs from "node:fs"
import type { MetaToolContext } from "../types"
import { getVisibleFile, getDiskPath } from "./file-utils"
import { renderPdfPageToPng } from "./pdf"

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"])
const MAX_PAGES = 5
const DEFAULT_MAX_WIDTH = 1024
const DEFAULT_DPI = 150

/**
 * Downscale a PNG/JPEG/WebP buffer so its width <= maxWidth.
 * Returns base64-encoded result and the output mediaType.
 */
async function prepareImageBase64(buffer: Buffer, mime: string, maxWidth: number): Promise<{ data: string; mediaType: string }> {
  const sharp = (await import("sharp")).default
  let pipeline = sharp(buffer)
  const meta = await pipeline.metadata()

  if (meta.width && meta.width > maxWidth) {
    pipeline = pipeline.resize({ width: maxWidth, withoutEnlargement: true })
  }

  const outputMime = mime === "image/png" ? "image/png" : "image/jpeg"
  const output = outputMime === "image/png"
    ? await pipeline.png().toBuffer()
    : await pipeline.jpeg({ quality: 85 }).toBuffer()

  return { data: output.toString("base64"), mediaType: outputMime }
}

export function createFileViewTools(ctx: MetaToolContext) {
  const { agentId, sessionId, db } = ctx

  return {
    file_view: tool({
      description:
        "Load an image or PDF page(s) into your context as vision input — the visual equivalent of file_read_text. " +
        "For images, the file is loaded directly. For PDFs, each requested page is rendered to PNG first. " +
        "Essential for scanned PDFs where pdf_extract_text returns empty text.",
      inputSchema: z.object({
        id: z.string().describe("File ID (image or PDF)"),
        pages: z.array(z.number()).optional().describe("For PDFs: which pages to view (1-based). Omit for page 1 only. Max 5 pages."),
        max_width: z.number().optional().describe("Max pixel width for images. Large images are downscaled. Default: 1024."),
        dpi: z.number().optional().describe("For PDFs: rendering resolution. Default: 150."),
      }),

      execute: async ({ id, pages, max_width, dpi }) => {
        const row = getVisibleFile(db, id, agentId, sessionId)
        if (!row) return { error: "File not found or not visible" }

        const maxWidth = max_width ?? DEFAULT_MAX_WIDTH
        const mime = row.mime_type ?? ""
        const imageParts: { data: string; mediaType: string }[] = []

        if (IMAGE_MIMES.has(mime)) {
          const buffer = fs.readFileSync(getDiskPath(row))
          const part = await prepareImageBase64(buffer, mime, maxWidth)
          imageParts.push(part)
        } else if (mime === "application/pdf") {
          const targetPages = pages?.slice(0, MAX_PAGES) ?? [1]
          for (const pageNum of targetPages) {
            const pngBuffer = await renderPdfPageToPng(getDiskPath(row), pageNum, dpi ?? DEFAULT_DPI)
            const part = await prepareImageBase64(pngBuffer, "image/png", maxWidth)
            imageParts.push(part)
          }
        } else {
          return { error: `Unsupported file type for visual viewing: ${mime}. Use file_read_text for text files.` }
        }

        return {
          pages_rendered: imageParts.length,
          _image_parts: imageParts,
        }
      },

      toModelOutput({ output }: { toolCallId: string; input: unknown; output: unknown }) {
        const result = output as any
        if (result?.error) {
          return { type: "text" as const, value: JSON.stringify(result) }
        }

        const parts = result._image_parts as { data: string; mediaType: string }[]
        const contentParts: any[] = []

        contentParts.push({
          type: "text" as const,
          text: `Viewing ${parts.length} image(s). Visual content follows:`,
        })

        for (const part of parts) {
          contentParts.push({
            type: "image-data" as const,
            data: part.data,
            mediaType: part.mediaType,
          })
        }

        return { type: "content" as const, value: contentParts }
      },
    }),
  }
}
