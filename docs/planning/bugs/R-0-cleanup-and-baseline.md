# R-0 — Cleanup, commit, baseline

**Priority:** P0 · **Depends on:** nothing · **Unblocks:** every other step
**Bugs fixed:** A14 · **Parent list:** [tasks.md](tasks.md)

Paths are relative to the `AEGIS/` repo root unless they start with `docs/`, which means
`sih_project/docs/`. Every "Today" statement was checked against the code on 2026-09-28.

## Goal

1. Remove code that nothing uses and comments that point at deleted docs.
2. Fix the one confirmed listener leak (A14).
3. Record a baseline that every later step compares against.

This step changes no product behaviour. Test counts may only drop by the tests deleted here, which
are listed below.

## Today (verified)

- `git status`: only `DEPLOYMENT.md` is modified and `tools/vlm/` is untracked. The earlier
  "57 modified + 30 new files" have already been committed (HEAD `452314b`).
- `tools/models/vit-vision.fp32.onnx` (351 MB) is **not** ignored. `.gitignore` covers
  `tools/models/.venv` and `__pycache__/`, but not `*.fp32.onnx`.
- Nothing imports `apps/extension/src/perception/spike-protocol.ts`. Only comments mention it
  (`perception/worker.ts:2-4`, `shared/worker-protocol.ts:1-3`).
- `apps/extension/test/unit/percentile.test.ts` tests a local copy of `percentile`/`at` helpers,
  described as "mirrors the private helpers in `src/perception/worker.ts`". Those helpers no longer
  exist in `worker.ts`, so the test covers nothing that ships.
- In `perception/models/pii-ner.ts`, `chunkForNer` and `PROFILE_S_LABEL_MAP` are used only by
  `test/unit/pii-ner.spec.ts` (one `describe` block). The S map is also wrong: `ORG → BANK_ACCOUNT`.
- The `pii-ner.ts` header (lines 1–14) says `public/models/privacy-filter/` is bundled. It isn't:
  `public/models/` holds only the face, OCR and ViT files. CI downloads `privacy-filter/`
  (`.github/workflows/ci.yml:88-95`), and `.gitignore` excludes it.
- `perception/worker.ts:442` ends with `export { compose, encodeWebp, type RedactionBoxSet };`.
  Nothing imports `perception/worker` as a module; the panel loads it by URL
  (`main.tsx:128`).
- `OCR_REC_DEVANAGARI_MODEL_SPEC` is passed to `init` but never loaded. **Keep it**:
  `test/unit/model-spec-manifest-parity.spec.ts` requires every hash in `models.manifest.json` to
  appear in `main.tsx`. R-17 wires script routing.
- `PerceptionClient.init` (`host/perception-client/client.ts:93-103`) adds a `message` listener
  and never removes it (A14).
- Files outside `docs/` that link to retired docs (`HISTORY.md`, `DECISIONS.md`,
  `CURRENT_BUILD.md`, `TASKS.md`, `context.md`): 51 files, 39 references in source and the rest in
  markdown. The command below lists them. References to `phase_N_*.md`, `design.md`,
  `architecture.md` and `product-requirements.md` are **not** dangling; those files exist in `docs/`.
- `AEGIS/CLAUDE.md` links `docs/...` relative to `AEGIS/`, but the docs live one level up in
  `sih_project/docs/`. Every link in its tables is broken.

## Implementation

### 1. `.gitignore`

Append:

```gitignore
# fp32 intermediates from tools/models/export_*.py — only the quantized output is shipped
tools/models/*.fp32.onnx
```

Check: `git check-ignore -v tools/models/vit-vision.fp32.onnx` prints the new rule.

### 2. Delete the Phase-0 spike leftovers

```bash
git rm apps/extension/src/perception/spike-protocol.ts apps/extension/test/unit/percentile.test.ts
```

Then fix the two comments that name them:

- `apps/extension/src/perception/worker.ts` lines 2–4. Replace
  `// design.md §11.1 — the real perception-worker message loop, replacing the Phase-0 spike's`
  `// probe/bench handlers (kept as \`spike-protocol.ts\`; its pure math is still locked down by`
  `// \`test/unit/percentile.test.ts\`). This is the only place raw pixels live (architecture §5.3):`
  with
  `// design.md §11.1 — the perception-worker message loop. This is the only place raw pixels live (architecture §5.3):`
  and leave the rest of that comment block unchanged.
- `apps/extension/src/shared/worker-protocol.ts` lines 1–3. Replace
  `// design.md §11.1 — the real perception-worker message interface, replacing the Phase-0 spike`
  `// protocol (\`perception/spike-protocol.ts\`, kept only for the probe/bench types the percentile`
  `// math test still mirrors). Every message is a plain, structured-clone-safe object; the one`
  with
  `// design.md §11.1 — the perception-worker message interface. Every message is a plain, structured-clone-safe object; the one`.

### 3. `pii-ner.ts`

- Delete `chunkForNer` (lines 18–35, including its doc comment) and `PROFILE_S_LABEL_MAP`
  (lines 37–47, including its doc comment).
- Replace the header, lines 1–14, with:

```ts
// design.md §6.3 — free-text PII detection (Channel N), run inside the perception worker
// (`worker.ts:handleNer`). Two profiles:
// - Profile S: no model yet — `classifyProfileS` returns no findings (R-8 adds one).
// - Profile L: `openai/privacy-filter` q4 (Apache-2.0), WebGPU-only, loaded through
//   `@huggingface/transformers`. NOT bundled in the repo: CI downloads it into
//   `public/models/privacy-filter/` (.github/workflows/ci.yml). Without that folder, profile L
//   fails to load and the worker falls back to no NER findings (fail closed: text stays as
//   Channel D/T left it).
```

- `apps/extension/test/unit/pii-ner.spec.ts`: remove `chunkForNer` from the import on line 2, and
  delete the whole `describe('chunkForNer — …')` block (lines 62–73).

### 4. `worker.ts` re-export

Delete the last line of `apps/extension/src/perception/worker.ts`:
`export { compose, encodeWebp, type RedactionBoxSet };`.
Also remove `type RedactionBoxSet` from the import on line 21 **only if** it becomes unused:
`handleCompose` still casts to it (`msg.regions as RedactionBoxSet[]`), so it stays.

### 5. Fix A14 — `PerceptionClient.init` listener leak

In `apps/extension/src/host/perception-client/client.ts`:

1. Add `removeEventListener` to `WorkerLike`:

```ts
export interface WorkerLike {
  postMessage(message: ToWorker, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<FromWorker>) => void): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<FromWorker>) => void): void;
  terminate(): void;
}
```

2. Replace the body of `init`:

```ts
async init(backendPref: 'auto' | 'webgpu' | 'wasm', models: ModelSpec[], profile: 'S' | 'L'): Promise<Extract<FromWorker, { t: 'ready' }>> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<FromWorker>) => {
      if (event.data.t === 'ready') {
        this.worker.removeEventListener('message', onMessage);
        resolve(event.data);
      } else if (event.data.t === 'error' && event.data.jobId === undefined) {
        this.worker.removeEventListener('message', onMessage);
        reject(new Error(event.data.detail ?? event.data.code));
      }
    };
    this.worker.addEventListener('message', onMessage);
    this.worker.postMessage({ t: 'init', backendPref, models, profile });
  });
}
```

3. Fix the doc comment above `init`: it already claims the listener "removes itself once
   `ready`/`error` arrives", which is now true. No change needed.
4. `test/unit/perception-client.spec.ts`: every fake worker must now implement
   `removeEventListener`. Add a test:

```ts
it('init removes its own message listener once ready arrives', async () => {
  const listeners = new Set<(e: MessageEvent) => void>();
  const worker = {
    postMessage: () => queueMicrotask(() => listeners.forEach((l) => l({ data: { t: 'ready', backend: 'wasm', loaded: [], failed: [] } } as MessageEvent))),
    addEventListener: (_t: string, l: (e: MessageEvent) => void) => listeners.add(l),
    removeEventListener: (_t: string, l: (e: MessageEvent) => void) => listeners.delete(l),
    terminate: () => {},
  };
  const client = new PerceptionClient(worker as unknown as WorkerLike);
  const sizeAfterConstructor = listeners.size; // the client's own permanent routing listener
  await client.init('wasm', [], 'S');
  expect(listeners.size).toBe(sizeAfterConstructor);
});
```

   The constructor registers one `message` listener and one `error` listener. Adapt
   `sizeAfterConstructor` if the fake stores both in the same set.

### 6. Dangling doc references

List them:

```bash
grep -rnE "(HISTORY|DECISIONS|CURRENT_BUILD|TASKS)\.md|docs/context\.md" \
  apps/extension/src apps/extension/entrypoints apps/extension/scripts apps/extension/test \
  apps/extension/*.ts packages/*/src packages/*/scripts packages/*/test server eval/src eval/tests \
  tools .github .gitignore CLAUDE.md AGENTS.md README.md DEVELOPMENT.md TESTING.md DEPLOYMENT.md API.md \
  | grep -v node_modules | grep -v .venv
```

Apply one rule to each hit, mechanically:

| Hit shape | Edit |
|---|---|
| A parenthetical or trailing clause that only points, e.g. `(see docs/HISTORY.md)`, `— see docs/HISTORY.md's 2026-09-19 entry`, `; recorded in DECISIONS.md` | Delete the clause and keep the sentence. |
| A whole sentence or comment line that only points, e.g. `// See docs/HISTORY.md for the fuller account.` | Delete the line. |
| A reference that carries a fact, e.g. `OQ-13 decided (docs/DECISIONS.md): hosted Qwen` | Keep the fact and drop the path: `OQ-13 decided: hosted Qwen`. |
| Markdown link in a `.md` file (`[x](docs/DECISIONS.md)`) | Replace the link with plain text of the fact, or point it at `docs/planning/bugs/tasks.md` if it pointed at planning/decisions. |
| `.gitignore` comment (line 24) | Delete `(see docs/HISTORY.md's 2026-09-26 T-6.8 entries)`. |

Do not rewrite surrounding comment blocks in this pass. After the edits, the grep above must print
nothing.

The two remediation files were merged into `docs/planning/bugs/tasks.md` and deleted. Two known
places still link them; point both at `tasks.md`:
- `tools/vlm/smoke.py` line 1: `R-1 (docs/planning/remediation_plan.md)` →
  `R-1 (docs/planning/bugs/tasks.md)`.
- `tools/vlm/README.md` line 3: `[remediation plan](../../../docs/planning/remediation_plan.md)` →
  `[task list](../../../docs/planning/bugs/tasks.md)`.

Then `grep -rn "remediation_plan\|remediation_implementation" . --include=*.py --include=*.ts --include=*.md | grep -v node_modules`
must print nothing.

### 7. `AEGIS/CLAUDE.md`

Replace these sections exactly:

- The **"Requirement documents"** table links: change `docs/product-requirements.md`,
  `docs/architecture.md`, `docs/design.md` to `../docs/product-requirements.md`,
  `../docs/architecture.md`, `../docs/design.md`.
- Replace the whole **"Working documents — in this repo"** section with:

```markdown
## Working documents

| Document | Purpose |
|---|---|
| [tasks.md](tasks.md) | The task list (R-0…R-18), audit bugs, and the Decision log |
| [planning/bugs/](./) | One implementation file per P0 step (`R-N-*.md`) |
| [planning/phase_N_*.md](../) | Historical phase designs; read for background, not for current status |

The code is the source of truth. When a doc disagrees with the code, fix the doc.
```

- In **"Rules of engagement"**, replace §1 "Work phase by phase" and §2 "Maintain the docs every
  time" with:

```markdown
### 1. Work step by step
Work on the lowest-numbered open step in `../docs/planning/bugs/tasks.md`. Implement from its
`R-N-*.md` file when one exists. Tick the step's boxes only when its acceptance check passes.

### 2. Keep the task list true
After a unit of work, in the same change: tick the boxes in `tasks.md`, add any new bug to its
audit table, and add a row to its Decision log for any decision made.
```

- Replace the **"Commands"** section body with the command block from §9 below.
- Keep §3–§7 (privacy invariants, runtime layout, measure-don't-assert, one contract, scope) and
  the Style section unchanged.

### 8. `AGENTS.md`, `README.md`, `DEVELOPMENT.md`, `DEPLOYMENT.md`

Apply the rule from §6 to these files. `DEPLOYMENT.md`'s uncommitted diff already reflects the R-1
model work; keep it, and only fix its `docs/DECISIONS.md` link (section 3, "Live (Production)",
first paragraph) to plain text:
"The server model is a hosted open-weights Qwen VLM (OQ-13, decided — see
`docs/planning/bugs/tasks.md`)."

### 9. Run everything and record the baseline

Run from `AEGIS/`, in this order. Record each result (pass/fail counts, duration) in the table at
the end of this file.

```bash
pnpm install
pnpm -r typecheck
pnpm lint
pnpm -r test                                            # extension: node + browser projects
(cd server/gateway && .venv/bin/python -m pytest -q)
(cd eval && .venv/bin/python -m pytest -q)
(cd eval && .venv/bin/aegis-eval run --split dev)       # writes eval/reports/<timestamp>-dev/
```

The browser project needs Playwright's Chromium: `pnpm --filter @aegis/extension exec playwright
install chromium` if it's missing.

Keep the dev report folder as the **R-baseline**. Copy its path into the table below and into
`tasks.md` §1 as the "Source" for every metric row.

### 10. Commits (team)

The team makes these commits after review; Claude doesn't commit. Suggested grouping:

1. `chore: ignore fp32 export intermediates`
2. `chore: remove Phase-0 spike leftovers and unused NER helpers`
3. `fix(extension): remove PerceptionClient.init message listener after ready`
4. `docs: drop links to retired status docs; point CLAUDE.md at the task list`
5. `chore: add tools/vlm (R-1 probe) and deployment notes` (the currently untracked `tools/vlm/`
   plus the modified `DEPLOYMENT.md`). Before committing, make sure `tools/vlm/__pycache__/` is not
   staged; it is ignored by `.gitignore:6`.

## Tests deleted by this step (expected count drop)

| File | What |
|---|---|
| `apps/extension/test/unit/percentile.test.ts` | the whole file |
| `apps/extension/test/unit/pii-ner.spec.ts` | the `chunkForNer` describe block (2 tests) |

## Tests added

| File | Test |
|---|---|
| `apps/extension/test/unit/perception-client.spec.ts` | `init removes its own message listener once ready arrives` |

## Acceptance

- [ ] `git check-ignore tools/models/vit-vision.fp32.onnx` succeeds.
- [ ] `grep -rn "spike-protocol\|chunkForNer\|PROFILE_S_LABEL_MAP" apps` prints nothing.
- [ ] The dangling-reference grep in §6 prints nothing.
- [ ] `pnpm -r typecheck`, `pnpm lint`, `pnpm -r test`, gateway pytest and eval pytest are all
  green. Counts equal the pre-change counts minus the deleted tests, plus 1.
- [ ] A dated dev-split report exists and its path is recorded below and in `tasks.md` §1.
- [ ] After the team's commits, `git status` is clean.

## Baseline record (fill in)

| Suite | Result | Date | Machine |
|---|---|---|---|
| `pnpm -r typecheck` | | | |
| `pnpm lint` | | | |
| extension node project | | | |
| extension browser project | | | |
| gateway pytest | | | |
| eval pytest | | | |
| `aegis-eval run --split dev` report path | | | |
