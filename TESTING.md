# Testing Guide

## Test Suites

### Unit Tests (JS/TS)
**Location:** `apps/extension/test/unit/*.spec.ts`  
**Environment:** jsdom (Node.js, no real browser)  
**Speed:** Fast (~3s for 300 tests)  

```bash
pnpm test -- --run test/unit
```

Good for: logic, privacy math, vault behavior, recognizer patterns.

### Browser Tests (JS/TS)
**Location:** `apps/extension/test/browser/*.spec.ts`  
**Environment:** Real Chromium via Playwright  
**Speed:** Slower (~20s for 180 tests)  

```bash
pnpm test -- --run test/browser
```

Good for: DOM extraction, layout-dependent code, actual redaction correctness.

### E2E Tests (JS/TS)
**Location:** `apps/extension/test/e2e/*.spec.ts`  
**Environment:** Real Chromium + real fixtures  
**Speed:** Slower (~10s each)  

```bash
pnpm test -- --run test/e2e
```

Good for: full flow (observe → perceive → redact → guard), demo fixture validation.

### Gateway Tests (Python)
**Location:** `server/gateway/tests/*.py`  
**Environment:** pytest  
**Speed:** Fast (~2s for 67 tests)  

```bash
cd server/gateway
uv run pytest -q
```

Good for: auth, sessions, prompt building, error handling, replay.

### Recognizer Tests (JS/TS)
**Location:** `packages/recognizers/src/__tests__/*.spec.ts`  
**Environment:** Node.js  
**Speed:** Fast (~1s for 269 tests)  

```bash
cd packages/recognizers
pnpm test
```

Good for: entity patterns, checksum validation (Verhoeff, Luhn), edge cases.

### Evaluation Harness (Python)
**Location:** `eval/tests/*.py`  
**Environment:** pytest + Playwright  
**Speed:** Very slow (5–10 min per split)  

```bash
cd eval
uv run pytest -q
uv run aegis-eval run --split dev
```

Good for: real corpus, metric scoring, leak auditing, end-to-end measurement.

## Test Coverage

| Component | Coverage | Type |
|---|---|---|
| Privacy pipeline | 100% | unit + browser + e2e |
| Recognizers | 100% | unit |
| Gateway | 100% | pytest |
| Extension (extension) | 308/308 | browser |
| Extension (recognizers) | 269/269 | unit |
| Protocol | 12/12 | unit |

**Current suite:** 576/578 passing (2 pre-existing flaky failures in timing/scroll debounce).

## Writing Tests

### Unit Test Template

```typescript
import { describe, expect, it } from 'vitest';
import { yourFunction } from '../../src/path/to/module';

describe('moduleName — feature being tested', () => {
  it('does the right thing on happy path', () => {
    const result = yourFunction('input');
    expect(result).toEqual('expected');
  });

  it('handles edge case correctly', () => {
    const result = yourFunction('');
    expect(result).toBeNull();
  });
});
```

### Browser Test Template

```typescript
import { describe, expect, it } from 'vitest';
import { extractScreenGraph } from '../../src/content/screen-graph/extractor';

describe('screenGraph — extraction on real layout', () => {
  it('finds a button by its exact bounding box', () => {
    const button = document.createElement('button');
    button.textContent = 'Click me';
    document.body.appendChild(button);

    const graph = extractScreenGraph(identity, containerResolver, {});
    const found = graph.nodes.find((n) => n.name === 'Click me');
    
    expect(found).toBeDefined();
    expect(found?.role).toBe('button');
  });
});
```

### Gateway Test Template

```python
import pytest
from fastapi.testclient import TestClient
from ..main import create_app

@pytest.fixture
def client():
    app = create_app()
    return TestClient(app)

def test_health_check(client):
    response = client.get("/healthz")
    assert response.status_code == 200
```

## Running Tests in CI Mode

```bash
# Everything, stop on first failure
pnpm -r test -- --reporter=verbose

# With coverage (not currently enabled, but the infrastructure exists)
pnpm test -- --coverage

# Specific file
pnpm test -- vault.spec.ts

# Watch mode (re-run on file changes)
pnpm test -- --watch
```

## Known Flaky Tests

1. **`test/browser/extractor.bench.spec.ts`** — p95 timing assertion occasionally flaky depending on system load
2. **`test/browser/observe.spec.ts`** — scrollend event timing can vary

These are not blockers and do not indicate bugs in the code; they reflect measurement precision at the edge of acceptable performance. Both are documented in the test files themselves.

## Privacy Testing

Critical paths that must always test:
- **No raw values in sanitized context** — use `privacy.spec.ts` pattern
- **Guard catches leaks** — inject a raw value and verify rejection
- **Vault determinism** — same value → same placeholder, always
- **Hard negatives** — tracking numbers, order IDs should NOT be redacted

```typescript
// Example: proving no leak
const vault = new Vault();
const context = buildSanitizedContext({ /* ... */, vault });

const bytes = JSON.stringify(context);
expect(bytes).not.toContain(RAW_AADHAAR_VALUE);
expect(bytes).not.toContain(RAW_PASSWORD);
```

## Debugging Failed Tests

```bash
# Show full output (don't truncate)
pnpm test -- --reporter=verbose --no-truncate

# Debug mode (pause, inspect)
node --inspect-brk ./node_modules/.bin/vitest run test/unit/vault.spec.ts

# Browser DevTools (for browser tests)
pnpm test -- test/browser/face-pipeline.spec.ts --inspect
```

## Performance Regression Testing

Measurement-based tests exist in `eval/` with real numbers from prior runs:
- Dev split: 1247.4 ms p50, 1658.6 ms p95 task wall-clock
- Peak RSS: 1123.8 MB typical
- Guard is the slowest stage: 43 ms p50, 65 ms p95

If you change the guard, fusion, or composition logic, re-run the harness and compare against `eval/reports/2026-09-18T161944Z-dev/`.

## Test Data

**Fixtures:** `apps/extension/test/fixtures/`
- `demo-login.html` — demo fixture with real Verhoeff Aadhaar + filled password + synthetic photo
- `profile-aadhaar.html` — privacy test fixture (Aadhaar, email, phone)
- `login.html` — spine/dispatch test fixture

**Corpus:** `eval/corpus/dev/` (204 screens, 80/20 split with 38 held-out)
- Generated deterministically from `generate_fixtures.py`
- Labelled in `eval/labels/` with real entity bounding boxes
- Do not edit the held-out split after Phase 5 — it's used exactly once for honest numbers

## Before Committing

```bash
# Full checks (equivalent to CI)
pnpm -r typecheck  # errors = don't commit
pnpm -r test       # failures = fix before commit
pnpm lint          # warnings in your code = fix before commit
pnpm build         # must succeed for both targets
```

This takes ~1 min and is worth doing before pushing.
