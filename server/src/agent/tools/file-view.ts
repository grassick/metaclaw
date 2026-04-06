import { tool } from "ai"
import { z } from "zod"
import fs from "node:fs"
import type { MetaToolContext } from "../types"
import { getVisibleFile, getDiskPath } from "./file-utils"
import { renderPdfPageToJpeg } from "./pdf"

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"])
const MAX_PAGES = 5
const DEFAULT_MAX_WIDTH = 768
const DEFAULT_DPI = 150

/**
 * Downscale any image buffer to JPEG with width <= maxWidth.
 * Always outputs JPEG — vision models don't need lossless PNG,
 * and JPEG is dramatically smaller for scanned/photographic content.
 */
async function prepareImageBase64(buffer: Buffer, maxWidth: number): Promise<{ data: string; mediaType: string }> {
  const sharp = (await import("sharp")).default
  let pipeline = sharp(buffer)
  const meta = await pipeline.metadata()

  if (meta.width && meta.width > maxWidth) {
    pipeline = pipeline.resize({ width: maxWidth, withoutEnlargement: true })
  }

  const output = await pipeline.jpeg({ quality: 82 }).toBuffer()
  return { data: output.toString("base64"), mediaType: "image/jpeg" }
}

export function createFileViewTools(ctx: MetaToolContext) {
  const { agentId, sessionId, db } = ctx

  return {
    file_view: tool({
      description:
        "Load an image or PDF page(s) into your context as vision input — the visual equivalent of file_read_text. " +
        "For images, the file is loaded directly. For PDFs, each requested page is rendered to JPEG first. " +
        "Essential for scanned PDFs where pdf_extract_text returns empty text. " +
        "Note: viewed images are not retained in conversation history — call file_view again if you need to re-examine.",
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
          const part = await prepareImageBase64(buffer, maxWidth)
          imageParts.push(part)
        } else if (mime === "application/pdf") {
          const targetPages = pages?.slice(0, MAX_PAGES) ?? [1]
          for (const pageNum of targetPages) {
            const jpegBuffer = await renderPdfPageToJpeg(getDiskPath(row), pageNum, dpi ?? DEFAULT_DPI)
            const part = await prepareImageBase64(jpegBuffer, maxWidth)
            imageParts.push(part)
          }
        } else {
          return { error: `Unsupported file type for visual viewing: ${mime}. Use file_read_text for text files.` }
        }

        const totalBytes = imageParts.reduce((sum, p) => sum + p.data.length, 0)
        console.log(`[file_view] ${id} → ${imageParts.length} image(s), ~${Math.round(totalBytes / 1024)}KB base64`)

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
