import { tool } from "ai"
import { z } from "zod"
import type { MetaToolContext } from "../types"

interface SkillRow {
  _id: string
  agent_id: string
  title: string
  description: string
  content: string
  tags: string
  source: string
  version: number
  enabled: number
  created_on: string
  modified_on: string
}

const NAME_REGEX = /^[a-z][a-z0-9-]*$/

export function createSkillTools(ctx: MetaToolContext) {
  const { agentId, db } = ctx

  return {
    create_skill: tool({
      description: "Create a named knowledge document (skill). Skills hold procedures, standards, and domain knowledge the agent can reference on demand.",
      inputSchema: z.object({
        name: z.string().describe("Unique slug (lowercase, hyphens). e.g. 'quarterly-excel-reports'"),
        title: z.string().describe("Human-readable title"),
        description: z.string().describe("Brief description (shown in the skill list for discovery)"),
        content: z.string().describe("Full markdown content"),
        tags: z.array(z.string()).optional().describe("Tags for categorization"),
      }),
      execute: async ({ name, title, description, content, tags }) => {
        if (!NAME_REGEX.test(name)) {
          return { error: "Skill name must be lowercase with hyphens (e.g. 'my-skill-name')" }
        }

        const existing = db.prepare(
          "SELECT 1 FROM agent_skills WHERE _id = ? AND agent_id = ?"
        ).get(name, agentId)
        if (existing) return { error: `Skill '${name}' already exists. Use update_skill.` }

        const now = new Date().toISOString()
        db.prepare(
          "INSERT INTO agent_skills (_id, agent_id, title, description, content, tags, source, version, enabled, created_on, modified_on) VALUES (?, ?, ?, ?, ?, ?, 'agent', 1, 1, ?, ?)"
        ).run(name, agentId, title, description, content, JSON.stringify(tags ?? []), now, now)

        return { name, version: 1 }
      },
    }),

    update_skill: tool({
      description: "Update an existing skill. Supports surgical content edits (replace, find_replace, append, prepend, delete) and metadata updates.",
      inputSchema: z.object({
        name: z.string().describe("Skill name to update"),
        title: z.string().optional().describe("New title"),
        description: z.string().optional().describe("New description"),
        tags: z.array(z.string()).optional().describe("New tags (replaces existing)"),
        operation: z.enum(["replace", "find_replace", "append", "prepend", "delete"]).optional().describe("Edit operation on the content"),
        content: z.string().optional().describe("For replace: new content. For append/prepend: text to add. For delete: text to remove."),
        find: z.string().optional().describe("For find_replace: substring to find"),
        replace: z.string().optional().describe("For find_replace: replacement text"),
        replace_all: z.boolean().optional().describe("For find_replace: replace all occurrences"),
      }),
      execute: async ({ name, title, description, tags, operation, content, find, replace, replace_all }) => {
        const row = db.prepare(
          "SELECT * FROM agent_skills WHERE _id = ? AND agent_id = ?"
        ).get(name, agentId) as SkillRow | undefined
        if (!row) return { error: `Skill '${name}' not found` }

        let newContent = row.content

        if (operation) {
          switch (operation) {
            case "replace":
              if (!content) return { error: "content is required for replace" }
              newContent = content
              break
            case "find_replace":
              if (!find || replace === undefined) return { error: "find and replace are required" }
              if (!newContent.includes(find)) return { error: `Could not find: "${find}"` }
              newContent = replace_all ? newContent.replaceAll(find, replace) : newContent.replace(find, replace)
              break
            case "append":
              if (!content) return { error: "content is required for append" }
              newContent = newContent + content
              break
            case "prepend":
              if (!content) return { error: "content is required for prepend" }
              newContent = content + newContent
              break
            case "delete":
              if (!content) return { error: "content is required for delete" }
              if (!newContent.includes(content)) return { error: "Text not found in skill content" }
              newContent = newContent.replace(content, "")
              break
          }
        }

        const now = new Date().toISOString()
        const newVersion = row.version + 1
        db.prepare(
          "UPDATE agent_skills SET title = ?, description = ?, content = ?, tags = ?, version = ?, modified_on = ? WHERE _id = ? AND agent_id = ?"
        ).run(
          title ?? row.title,
          description ?? row.description,
          newContent,
          tags ? JSON.stringify(tags) : row.tags,
          newVersion, now, name, agentId,
        )

        return { name, version: newVersion }
      },
    }),

    delete_skill: tool({
      description: "Delete a skill",
      inputSchema: z.object({
        name: z.string().describe("Skill name to delete"),
      }),
      execute: async ({ name }) => {
        const result = db.prepare(
          "DELETE FROM agent_skills WHERE _id = ? AND agent_id = ?"
        ).run(name, agentId)
        return { deleted: result.changes > 0 }
      },
    }),

    list_skills: tool({
      description: "List all skills with name, description, and tags",
      inputSchema: z.object({
        tag: z.string().optional().describe("Optional tag to filter by"),
        include_disabled: z.boolean().optional().describe("Include disabled skills. Default: false."),
      }),
      execute: async ({ tag, include_disabled }) => {
        let rows: SkillRow[]
        if (include_disabled) {
          rows = db.prepare(
            "SELECT * FROM agent_skills WHERE agent_id = ? ORDER BY _id"
          ).all(agentId) as SkillRow[]
        } else {
          rows = db.prepare(
            "SELECT * FROM agent_skills WHERE agent_id = ? AND enabled = 1 ORDER BY _id"
          ).all(agentId) as SkillRow[]
        }

        if (tag) {
          rows = rows.filter(r => {
            const tags: string[] = JSON.parse(r.tags)
            return tags.includes(tag)
          })
        }

        return {
          skills: rows.map(r => ({
            name: r._id,
            title: r.title,
            description: r.description,
            tags: JSON.parse(r.tags),
            source: r.source,
            version: r.version,
          })),
        }
      },
    }),

    read_skill: tool({
      description: "Read a skill's full content and metadata",
      inputSchema: z.object({
        name: z.string().describe("Skill name to read"),
      }),
      execute: async ({ name }) => {
        const row = db.prepare(
          "SELECT * FROM agent_skills WHERE _id = ? AND agent_id = ?"
        ).get(name, agentId) as SkillRow | undefined
        if (!row) return { error: `Skill '${name}' not found` }
        return {
          name: row._id,
          title: row.title,
          description: row.description,
          content: row.content,
          tags: JSON.parse(row.tags),
          source: row.source,
          version: row.version,
        }
      },
    }),

    enable_skill: tool({
      description: "Enable a disabled skill so it appears in the skill list",
      inputSchema: z.object({
        name: z.string().describe("Skill name to enable"),
      }),
      execute: async ({ name }) => {
        const result = db.prepare(
          "UPDATE agent_skills SET enabled = 1, modified_on = ? WHERE _id = ? AND agent_id = ?"
        ).run(new Date().toISOString(), name, agentId)
        if (result.changes === 0) return { error: `Skill '${name}' not found` }
        return { name, enabled: true }
      },
    }),

    disable_skill: tool({
      description: "Disable a skill without deleting it",
      inputSchema: z.object({
        name: z.string().describe("Skill name to disable"),
      }),
      execute: async ({ name }) => {
        const result = db.prepare(
          "UPDATE agent_skills SET enabled = 0, modified_on = ? WHERE _id = ? AND agent_id = ?"
        ).run(new Date().toISOString(), name, agentId)
        if (result.changes === 0) return { error: `Skill '${name}' not found` }
        return { name, enabled: false }
      },
    }),
  }
}
