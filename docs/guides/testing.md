# Testing guide

## Suites

| Suite | Location | Runs in | Command |
|---|---|---|---|
| Extension unit | `apps/extension/test/unit/` | Node + jsdom, with WXT's in-memory `fakeBrowser` | `pnpm --filter @aegis/extension test` (project `node`) |
| Extension browser | `apps/extension/test/browser/` | real Chromium via Playwright (Vitest browser mode) | same command (project `browser`) |
| Extension e2e | `apps/extension/test/e2e/` | real Chromium, real fixtures | same command (project `browser`) |
| Recognizers | `packages/recognizers/test/` | Node | `pnpm --filter @aegis/recognizers test` |
| Policy | `packages/policy/test/` | Node | `pnpm --filter @aegis/policy test` |
| Protocol contract | `packages/protocol/test/contract/` | Node | `pnpm --filter @aegis/protocol test` |
| Gateway | `server/gateway/tests/` | pytest | `uv run pytest -q` (in `server/gateway`) |
| Evaluation harness | `eval/tests/` | pytest + Playwright | `uv run pytest -q` (in `eval`) |

`pnpm -r test` runs every JS/TS suite. Run one file with
`pnpm --filter @aegis/extension exec vitest run test/unit/vault.spec.ts`.

The extension's Vitest projects are defined in `apps/extension/vitest.config.ts`. Two details from
it matter when a test misbehaves:

- the `node` project runs its files serially: `manifest.spec.ts` and `ablation-build.spec.ts` both
  run real `wxt build`s into the same `.output/` directory;
- the `browser` project launches full Chromium with `--headless=new`, not Playwright's headless
  shell, because the headless shell never exposes `navigator.gpu`.

Browser tests that load models need the models in `apps/extension/public/models/` (see
[development.md](development.md#install)).

## What unit tests cannot show

Unit tests drive `Session` with synchronous fakes, and the harnesses run the dev build. A change to
how the agent or the extension behaves is shown working in a **visible** run on a real site
(`tools/e2e/probe_site.py --watch`, `CLAUDE.md` rule 8). `--close-panel-at-step N` closes the panel
once step N has started, reopens it in the same window and presses Resume on its Interrupted card
(the saved-task path, `src/host/saved-task.ts`); it writes `panel-before-close.png` and
`panel-reopened.png` beside the usual screenshots. For the release package as a user gets it:

```bash
python3 -m http.server 8080 --bind 127.0.0.1 --directory demo &
eval/.venv/bin/python tools/e2e/release_smoke.py
```

## Privacy tests

Changes to anything on the path from page to network keep these properties tested:

- no raw sensitive value appears in the bytes of a sanitized context (`privacy.spec.ts`, `guard.spec.ts`);
- the guard blocks a payload with an injected raw value or a canary;
- the vault is deterministic (same value → same placeholder) and exposes no iteration;
- hard negatives (order IDs, tracking numbers) are not redacted;
- `fetch` appears nowhere outside `src/host/egress/` (`pnpm lint` runs `check:no-network`).

## Measurements

Numbers in docs are targets until the evaluation harness produces them. A reported measurement
states n, split, hardware, browser version, backend, model versions, policy version and date, with
the failure cases next to the success rate (`CLAUDE.md` rule 5).

## Test data

- `apps/extension/test/fixtures/`: HTML pages and images used by browser tests.
- `eval/corpus/{dev,heldout}/` with labels in `eval/labels/`: generated deterministically by
  `eval/src/aegis_eval/corpus/`. The held-out split is run only with a recorded reason
  (`aegis-eval run --split heldout --reason ...`).
- `demo/`: demo pages for the e2e drivers and the release smoke test. Agent fixes are shown on real
  public sites, not on these.
