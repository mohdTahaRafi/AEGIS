# @aegis/protocol

The contract between the extension and the gateway. **Empty scaffold — built in Phase 1.**

`schema/` will hold JSON Schema (draft 2020-12) as the single source of truth:
`sanitized-context.schema.json`, `action-plan.schema.json`, `session.schema.json`,
`error.schema.json` (design.md §4). `scripts/generate.ts` generates committed TypeScript types
into `src/generated/` and a Pydantic v2 model set for `server/gateway`. Never hand-edit generated
output — regenerate it.

See [docs/TASKS.md](../../docs/TASKS.md) Phase 1, T-1.1…T-1.7.
