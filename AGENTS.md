# AGENTS.md

boxOS is a small Bun/TypeScript prototype for cooperative, content-addressed procedures.

## Commands

- Type-check: `tsc --noEmit`
- Run server: `bun server.ts`

## Conventions

- Keep the proc language deliberately small and auditable.
- Treat submitted proc code as untrusted; validate it before storage or execution.
- Do not add syntax, globals, or capabilities without an explicit security rationale.
- Proc code may use declared locals, supplied arguments, fixed `value.field` access, and guarded numeric indexing only.
- Keep `bun-lite.d.ts` minimal; add only Bun APIs used by this project.
- Prefer straightforward TypeScript and focused changes over abstractions or dependencies.
