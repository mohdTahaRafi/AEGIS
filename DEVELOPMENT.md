# Development Guide

## Prerequisites

- Node.js ≥ 22
- pnpm 10+
- Python 3.12
- `uv` package manager
- Chrome or Firefox (for testing)

## Quick Start

```bash
# Clone and install
git clone <repo>
cd aegis_main
pnpm install

# Verify everything works
pnpm -r typecheck
pnpm -r test
pnpm lint
```

## Development Workflow

### Extension (Chrome)

```bash
cd apps/extension

# Dev mode with hot reload
pnpm dev

# Load in Chrome: chrome://extensions > Developer mode > Load unpacked > .output/chrome-mv3-dev
```

### Extension (Firefox)

```bash
cd apps/extension

# Dev mode for Firefox
pnpm dev:firefox

# Load in Firefox: about:debugging > This Firefox > Load Temporary Add-on
```

### Gateway Server

```bash
cd server/gateway
uv sync

# Run with auto-reload
uv run uvicorn aegis_gateway.main:app --reload --host 127.0.0.1 --port 8000
```

### Evaluation Harness

```bash
cd eval
uv sync

# Run against dev split
uv run aegis-eval run --split dev
```

## Project Structure Reference

| Path | Purpose |
|---|---|
| `apps/extension/src/content/` | Page context — DOM extraction, no network |
| `apps/extension/src/host/` | Panel context — vault, guard, egress, UI |
| `apps/extension/src/perception/` | Worker context — vision inference, pixel processing |
| `packages/protocol/` | JSON Schema contract (generates TS + Pydantic) |
| `packages/recognizers/` | Entity pattern matchers (Aadhaar, PAN, card, etc.) |
| `packages/policy/` | Sensitivity policy and thresholds |
| `server/gateway/` | FastAPI app — auth, sessions, prompt, model client |
| `eval/` | Evaluation harness — corpus, runner, scorers, auditor |
| `docs/` | Requirements, architecture, design, phase plans |

## Important Rules

**Privacy invariants (enforced, not optional):**
- Sanitization before any network request — always
- Network calls **only** in `apps/extension/src/host/egress/` — checked by ESLint
- Passwords/OTP/CVV never read by content script — presence-only
- Vault is in-memory, minimal surface (no serialize, no iterate)
- Fail closed — crashes/timeouts yield grey/block, never content

**Code organization:**
- Content script cannot import host or perception code (different contexts)
- Host cannot import content or perception code
- Perception worker has no network, no vault access
- All three can import from `packages/*` (pure TS)

**Type safety:**
- Strict TypeScript in extension
- Pydantic v2 in gateway
- JSON Schema as single source of truth for protocol

## Common Tasks

### Add a new entity recognizer
1. Create pattern in `packages/recognizers/src/patterns/`
2. Add tests in `packages/recognizers/src/__tests__/`
3. Register in `packages/recognizers/src/registry.ts`
4. Update `packages/policy/policies/default.policy.json`
5. Run `pnpm -r test` to verify

### Update the protocol
1. Edit JSON Schemas in `packages/protocol/schema/`
2. Run `pnpm gen:protocol` to regenerate TS types + Pydantic models
3. Commit generated files
4. Update consumer code to use new types

### Add a test
- Unit: `test/unit/*.spec.ts` (jsdom, fast)
- Browser: `test/browser/*.spec.ts` (real Chromium, slower)
- E2E: `test/e2e/*.spec.ts` (real flow with side effects)

Run specific suite:
```bash
pnpm test -- test/unit/vault.spec.ts
pnpm test -- --run test/browser/face-pipeline.spec.ts
```

### Build for production
```bash
pnpm build
# → apps/extension/.output/chrome-mv3 (49.90 MB, includes bundled models)
# → apps/extension/.output/firefox-mv3
```

## Debugging

### Extension
- Open panel, press F12
- Check Console for content/host errors
- **Worker logs**: not visible in normal devtools — route through message channel or console.error in host-side handler

### Gateway
```bash
# Tail logs
uv run python -m aegis_gateway.structured_log  # check the format

# Test endpoint
curl -H "Authorization: Bearer test-token" http://127.0.0.1:8000/health
```

### Evaluation harness
```bash
# Run single fixture with verbose output
uv run aegis-eval run --split dev --fixture bank-001 -v

# Regenerate corpus (careful — this is deterministic, not truly random)
uv run python -m aegis_eval.corpus.generate_fixtures
```

## Continuous Integration

The GitHub Actions workflow (`.github/workflows/ci.yml`) runs:
- `pnpm typecheck` (all TS packages)
- `pnpm test` (312 jsdom + 188 real-Chromium + 269 recognizer tests)
- `pnpm lint` (ESLint + custom no-network rule)
- Extension build (both targets)
- Gateway tests (67 pytest)

To run locally:
```bash
pnpm -r typecheck && pnpm -r test && pnpm lint && pnpm build
```

## Performance Profiling

**Extension:**
- Chrome DevTools > Performance tab
- Task peak RSS: 1.1 GB typical
- Task p95 wall-clock: 1658 ms

**Gateway:**
- Add logging with `@timed()` decorator in `structured_log.py`
- Per-stage breakdown: observe/perceive/guard/server/validate/act

## Contact & Questions

See [CLAUDE.md](CLAUDE.md) for how Claude Code works in this repo.
See [docs/DECISIONS.md](docs/DECISIONS.md) for resolved open questions.
See [docs/HISTORY.md](docs/HISTORY.md) for what's been built and why.
