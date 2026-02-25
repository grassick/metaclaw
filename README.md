# Metaclaw

A personal agent that can modify itself. It edits its own system prompt, creates and updates its own tools (run in a V8 sandbox), manages persistent state, builds React UI components on the fly, and browses the web through a headless browser.

Single-user, self-hosted. Not a platform — just a thing that works for you and gets better over time.

## Key docs

- [Rough Plan](./Rough%20Plan.md) — architecture, database schema, build phases
- [Built-in Tools](./Built-in%20Tools.md) — all meta-tools with JSON schemas
- [Technology Choices](./Technology%20Choices.md) — stack decisions (SQLite, Vercel AI SDK, etc.)
- [Sandbox Runtime](./Sandbox%20Runtime.md) — everything agent-authored code can touch
- [Frontend Design](./Frontend%20Design.md) — layout, session management, component rendering

## Structure

```
server/   — Node.js + Express + SQLite backend
client/   — React + Vite frontend
```

## Quick start

```
pnpm install
pnpm dev
```
