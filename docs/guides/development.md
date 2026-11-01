# Development guide

How to set up the repo, run each part, and where things live. For what is built and how the parts
fit together today, read [architecture-as-built.md](../architecture-as-built.md) first.

## Prerequisites

- Node.js ≥ 22 and pnpm (the version pinned in the root `package.json` `packageManager` field)
- Python 3.12 and [`uv`](https://docs.astral.sh/uv/)
- Chromium or Chrome; Firefox ≥ 128 for the Firefox build

## Install

```bash
pnpm install          # JS/TS workspace (packages/*, apps/*)
uv sync               # Python workspace (server/gateway, eval)
```

The on-device models are not in git. Fetch and generate them once before a build or the browser
tests (the release gate refuses to build without them):

```bash
cd apps/extension
pnpm exec tsx scripts/fetch-models.ts     # face + OCR: downloaded and sha256-verified
# CLIP ViT + prompt embeddings: tools/models/ (export_vit_vision.py, quantize.py, export_vit_prompts.py)
```

CI does the same and caches the result (`.github/workflows/ci.yml`).

## Run

### Extension

```bash
cd apps/extension
pnpm dev                              # Chrome, hot reload → load .output/chrome-mv3-dev unpacked
pnpm dev:firefox                      # Firefox → about:debugging → Load Temporary Add-on
npx wxt build --mode development      # a dev build without the watcher (what the e2e drivers load)
```

A dev build differs from a release: it also allows `localhost` in its CSP, keeps the ablation switch,
and talks to the legacy gateway when no API key is saved. See
[architecture-as-built.md §2](../architecture-as-built.md).

To watch a real task on a real site (required to show an agent fix, see `CLAUDE.md` rule 8):

```bash
eval/.venv/bin/python tools/e2e/probe_site.py <url> "<task>" --watch
```

### Legacy gateway (dev and evaluation only)

```bash
server/deploy/run-gateway.sh          # live, http://127.0.0.1:8787 (AEGIS_PORT to change)
```

API: [gateway-api.md](gateway-api.md). Its own setup: [server/deploy/README.md](../../server/deploy/README.md).

### Evaluation harness

```bash
cd eval
uv run aegis-eval run --split dev     # drives the real extension against eval/corpus/dev
uv run aegis-eval ablations --split dev
uv run aegis-eval validate-labels
```

Reports are written to `eval/reports/` (gitignored).

## Where code goes

The extension is organised by JavaScript runtime context, because these contexts cannot share memory
(architecture §15.2). The boundaries are enforced by `eslint.config.js`.

| Path | Context | Rules |
|---|---|---|
| `apps/extension/src/content/` | page frames | may touch the DOM; no pixels, no vault, no network |
| `apps/extension/src/host/` | side panel | owns vault, guard, egress, session loop |
| `apps/extension/src/host/egress/` | side panel | the **only** place `fetch` / `XMLHttpRequest` / `WebSocket` may appear |
| `apps/extension/src/perception/` | Web Worker | the only place raw pixels live; no network |
| `apps/extension/src/shared/` | any | message and type definitions shared across contexts |
| `apps/extension/src/ui/` | side panel | Preact components |
| `packages/protocol/` | pure TS | JSON Schemas + generated TS types, Ajv validators, Pydantic models |
| `packages/recognizers/` | pure TS | entity recognizers and checksums |
| `packages/policy/` | pure TS | versioned policy JSON + typed accessors |
| `server/gateway/` | Python | legacy FastAPI gateway (dev/eval only) |
| `eval/` | Python | corpus, Playwright runner, scorers, independent auditor |
| `tools/` | Python | e2e drivers, model export, VLM smoke tests |

## Common tasks

### Change the protocol

1. Edit the schema in `packages/protocol/schema/`.
2. `pnpm gen:protocol` regenerates the TS types, validators and Pydantic models.
3. Commit the schema and the generated files together. CI fails if they drift.

Never hand-edit files under `packages/protocol/src/generated/` or
`server/gateway/src/aegis_gateway/protocol/`.

### Add an entity recognizer

1. Add the pattern under `packages/recognizers/src/patterns/` and register it in
   `packages/recognizers/src/registry.ts`.
2. Add tests under `packages/recognizers/test/`.
3. Give the entity a class in `packages/policy/policies/` (policy is data, not code).

### Add a model provider

Add a preset to `apps/extension/src/host/egress/providers.ts`. The manifest host permissions, CSP,
release gate and settings UI all read that file; nothing else needs a new origin.

## Debugging

- Panel and content-script errors: open the side panel, then DevTools (F12).
- Worker errors: the worker reports failures to the panel over its message channel
  (`src/shared/worker-protocol.ts`); they show in the panel's Setup line and run log.
- Logs use a closed vocabulary (`src/shared/logger.ts`): numbers, enums, versions. Never page text.

## Before you push

```bash
pnpm lint && pnpm -r typecheck && pnpm -r test
uv run pytest -q                       # in server/gateway
```

Commit messages follow [CONTRIBUTING.md](../../CONTRIBUTING.md).
