# Phase 1 — The Protocol Contract, Dependency Enforcement & the Evaluation Harness Skeleton

**Document type:** Phase 1 execution document
**Requirements basis:** FR-44, FR-50, FR-51, FR-52, FR-54; NFR-2, NFR-3, NFR-15; AC-8 (prepares), AC-11 (fixtures)
**Architecture basis:** `architecture.md` §2 P1 ("the rubric is the specification"), §12.3 (evaluation harness), §13.4 (CI), §15.2 (one contract), §15.3 (dependency rules), §16 (build order step 2)
**Design basis:** `design.md` §4 (network protocol), §4.6 (action DSL schema), §4.7 (error model), §17 (testing strategy), §18.1 (corpus format), §18.4 (held-out discipline)
**Depends on:** Phase 0 — the workspace, the extension shell, and `check-no-network.ts`. The go/no-go verdict is **not** a hard blocker for this phase: the contract and the harness are worth building whatever the spike says, and if the spike forces a model-stack change it does not change the wire format.
**Status:** **Essentially complete.** All of §3–§6 (protocol contract, dependency enforcement,
harness skeleton, CI) are built and verified end to end — T-1.1 through T-1.21, all of Phase 1's
task table. A real 30-screen corpus exists and a full harness run against it, in real Chromium
with the real extension loaded, completes 30/30. Several real bugs were found and fixed along the
way (a cross-language contract gap, two JSON Schema vacuous-truth mistakes, CSS box-model errors
caught by a dedicated Playwright spot-check) — see the Implementation Notes appended at the end of
this document for the full account. The one thing genuinely not verifiable from this environment is
`.github/workflows/ci.yml` actually running on a real GitHub Actions runner; every command inside
it was instead run and confirmed directly.

---

## 1. Objective

Architecture §2's first principle is that **the rubric is the specification**, and its consequence
is that the evaluation harness is a first-class component built *before* the product. Phase 1
honours that, and pairs it with the other thing that must exist before two teams can work in
parallel: the contract between the client and the server.

Both are infrastructure. Neither detects anything, redacts anything or drives a page. What they do
is make every later phase measurable and make the client and server halves independently
buildable — Phase 2 writes an extension against a schema the gateway already validates, and Phase 3
can prove a redaction change moved the numbers rather than asserting it.

**By the end of this phase:** a developer writes a sample sanitized-context payload by hand, runs
it through the TypeScript validator and through the gateway's Pydantic models, and both accept it —
or both reject it with the same field named. They add a field to
`sanitized-context.schema.json`, run `pnpm gen:protocol`, and see the generated TypeScript type and
the generated Pydantic model both change; if they forget to regenerate, CI tells them. They run
`uv run aegis-eval run --split dev` and Playwright launches Chromium with the unpacked extension
loaded, walks a small set of local fixture pages, and writes a report — empty of metrics, because
nothing detects anything yet, but with the plumbing end-to-end: fixture → browser → extension →
ledger export → scorer input. They try `--split heldout` and the runner refuses without an explicit
flag.

**No detection, no redaction, no vault, no guard, no agent, no model calls.** The fixtures contain
planted synthetic PII and canary strings, and nothing in this phase looks for them. That is the
point: the corpus and the scoring plumbing exist first, so that when Phase 3's recognizers arrive
there is already something to measure them with, and the first number is produced by a harness
nobody tuned to flatter it.

---

## 2. What this phase inherits and what it changes

| Path | Inherited state | What Phase 1 does |
|---|---|---|
| `packages/protocol/` | `[scaffold]` — `package.json`, `tsconfig.json`, `export {}`, README, empty `schema/` | **Filled.** Four JSON Schemas, a generator, committed generated types, a runtime validator |
| `packages/protocol/scripts/generate.ts` | `[scaffold]` — prints "not implemented" | **Implemented.** Schema → TS types → Pydantic models, idempotent, CI-checkable |
| `packages/recognizers/`, `packages/policy/` | `[scaffold]` | **Untouched.** Phase 3 owns them. Their `lint` stubs stay |
| `apps/extension/scripts/check-no-network.ts` | `[built]` — negative half only | **Untouched this phase.** Phase 2 adds the positive half when `host/egress/` exists |
| `apps/extension/` (spike panel, worker) | `[built-spike]` | **Untouched.** Phase 2 replaces the panel. The harness loads whatever build exists, which in Phase 1 is still the spike UI — that is fine, the runner is exercising its own plumbing |
| `server/gateway/` | `[scaffold]` — `create_app()` + `/healthz` | **Gains `protocol/`** — the generated Pydantic models — and a contract round-trip test. Routes are Phase 2 |
| `eval/` | `[scaffold]` — CLI stub exiting 1 | **Filled.** Corpus layout, label schema, Playwright runner, report skeleton, held-out guard |
| `.github/workflows/` | *(empty)* | **`ci.yml` created** |
| `.eslintrc` / `eslint.config.js` | *(absent)* | **Created** with architecture §15.3's boundary rules |

---

## 3. The protocol contract

### 3.1 Why JSON Schema is the source of truth, and not TypeScript

The contract crosses a language boundary: a TypeScript extension talks to a Python gateway.
Architecture §15.2 makes JSON Schema (draft 2020-12) the single source and generates both sides,
because the alternative — hand-maintained types in two languages — drifts silently, and the drift
shows up as a 400 at demo time.

There is a second reason specific to this project. FR-41 requires the server to be "aware of the
redaction scheme". Architecture §8.2 makes that awareness **literal**: it is this schema, plus the
prompt builder. A payload that does not validate is not a payload the server will reason about, and
`extra="forbid"` on the Pydantic side means an unexpected field is a rejection rather than an
ignored leak vector.

### 3.2 The four schemas

```
packages/protocol/schema/
├── sanitized-context.schema.json    # StepRequest — design.md §4.3
├── action-plan.schema.json          # StepResponse — design.md §4.5, §4.6
├── session.schema.json              # SessionCreate / SessionCreated — design.md §4.2
└── error.schema.json                # design.md §4.7
```

**`sanitized-context.schema.json`** is the important one and the one with the safety-relevant
constraints. Beyond shape, it must mechanically enforce the rules design.md §4.3 states in prose:

| Rule | How the schema enforces it |
|---|---|
| Node ids are opaque | `"pattern": "^n-[0-9a-z]+$"`; text runs `^t-[0-9a-z]+$`; frames `^f-[0-9]+$`; steps `^s-[0-9]+$` |
| No URLs, selectors, XPaths, frame URLs anywhere | `"additionalProperties": false` at **every** object level, so a field that does not exist in the schema cannot be present at all |
| `value.kind` is a closed set | `"enum": ["empty", "presence", "placeholder", "text"]` |
| A placeholder value carries a ref; a presence value never does | `oneOf` branches per `kind`, with `ref` `required` in the placeholder branch and forbidden in the presence branch |
| Placeholder refs are well-formed | `"pattern": "^⟪[A-Z_]+#[0-9]+⟫$"` |
| Entity types are a closed enum | The 28-entry enum from design.md §3.3, shared by `redactions[].entity` and `value.entity` |
| Page identity is a category, not an origin | `page.category` enum only (`gov|banking|email|social|health|docs|canvas_app|unknown`), **no `origin` or `url` field exists** — OQ-11's default made structural |
| Coverage is a complete triple | `coverage` requires `cleared`, `redacted`, `unanalysed`, each `0..1` |

The `additionalProperties: false` discipline is worth stating plainly: it is the difference between
"we do not put URLs in the payload" and "a URL cannot be in the payload". The egress guard
(Phase 3) re-checks this independently at runtime, but the schema is the first line and the one the
server also enforces.

**`action-plan.schema.json`** is reproduced nearly verbatim from design.md §4.6 — eleven operations
(`click`, `type`, `select`, `scroll`, `wait`, `click_point`, `request_observation`, `report`,
`ask_user`, `done`, `stop`), `maxItems: 5`, `additionalProperties: false` on every branch. Two
details carry real weight:

- **`type` has a `oneOf` over `ref` and `text`.** OQ-14 asks whether literal task text may be
  typed at all. The schema is written so the `text` branch can be deleted outright if the answer is
  no, without touching any other branch.
- **The schema is also the structured-decoding grammar.** vLLM is given this exact schema as
  `response_format` (architecture §8.3), so a hallucinated action is a decoding-time impossibility
  rather than a runtime rejection. This is what FR-44 means by "malformed or invented actions are
  rejected rather than executed", and it is why the schema must be strict enough to be useful as a
  grammar — loose `additionalProperties` would let the model invent fields.

### 3.3 Generation

```
schema/*.json
   ├──► src/generated/*.ts        (committed) + validate.ts (compiled validators)
   └──► server/gateway/src/aegis_gateway/protocol/*.py   (committed Pydantic v2, extra="forbid")
```

`pnpm gen:protocol` runs both. Both outputs are **committed**, and CI regenerates and fails on a
diff (T-1.7). Committing generated code is a deliberate choice: it makes the contract reviewable in
a pull request, and it means a fresh checkout can typecheck without running a generator.

Tooling: `json-schema-to-typescript` for TS, `datamodel-code-generator` for Pydantic. Both are
mature and neither needs customisation beyond `additionalProperties: false → extra="forbid"`.

**The runtime validator** is separate from the types. TypeScript types vanish at runtime; the
extension needs to *reject* a malformed server response, which means a real validator. Ajv compiles
the schema to a standalone validation function at build time, which avoids shipping the Ajv
compiler and keeps the extension bundle down — a metric-4 consideration, small but free.

### 3.4 The round-trip test

T-1.7, and the thing that makes the contract real rather than aspirational:

```
tests/contract/samples/*.json   — hand-written, one per schema, plus deliberate violations
      │
      ├──► TypeScript validator  → expect accept / expect reject with field path
      └──► Pydantic model        → expect accept / expect reject with field path
```

The violation samples matter more than the valid ones. At minimum:
a payload carrying a `url` field; a node id shaped like a CSS selector; a `value.kind: "presence"`
that also carries a `ref`; a `ref` whose entity is not in the enum; an action with a twelfth
operation; a plan with six actions; a `type` action carrying both `ref` and `text`.

Each must be rejected **by both implementations**, and the test asserts that — not just that
something failed, but that the same field was named. A contract where the two sides disagree about
*why* something is invalid is a contract with a seam in it.

---

## 4. Dependency enforcement

Architecture §15.3 lists the import rules. Phase 0 built the hardest one to express (no-network, a
global rather than a module). Phase 1 expresses the rest as ESLint boundaries.

```js
// eslint.config.js  [new]
// eslint-plugin-boundaries or import/no-restricted-paths
{
  zones: [
    { target: 'packages/recognizers', from: ['apps', 'server', 'eval'] },
    { target: 'packages/policy',      from: ['apps', 'server', 'eval'] },
    { target: 'apps/extension/src/content',    from: ['apps/extension/src/host', 'apps/extension/src/perception'] },
    { target: 'apps/extension/src/perception', from: ['apps/extension/src/host', 'apps/extension/src/content'] },
    // host may not be imported by the other two; it talks by messages only
  ]
}
```

Two rules cannot be expressed as import zones and are written as custom checks:

- **`packages/recognizers` and `packages/policy` must not touch browser APIs.** They are pure
  functions reused by the harness in Node (architecture §15.2). A lint rule forbidding `document`,
  `window`, `navigator` and `chrome`/`browser` identifiers in those packages.
- **`src/host/privacy/vault` must export no serialization.** Phase 3 adds a check that the vault
  module exports no `toJSON`, `entries`, `values` or `[Symbol.iterator]`, with `normalizedValues()`
  whitelisted for the guard. Written in Phase 1 as a placeholder that passes trivially (the folder
  does not exist yet) so Phase 3 does not have to remember to add it.

---

## 5. The evaluation harness skeleton

### 5.1 Why it is built now, empty

The harness is the instrument. If it is built after the product, it gets built to confirm what the
product already does, and every threshold gets chosen to make the numbers look good. Architecture
§12.3 and [SS] both put it first for that reason, and design.md §18.4 adds the held-out discipline
that only means something if it is enforced from the start.

Phase 1 builds the plumbing and ~30 fixtures. Phase 5 builds the scorers and grows the corpus to
200–300. The scorers are deliberately *not* built here — there is nothing to score, and a scorer
written against an imagined output shape is a scorer that gets rewritten.

### 5.2 Corpus and label format

Design.md §18.1, unchanged:

```
eval/corpus/<split>/<screen_id>/
  page/              # saved page (HTML + assets), or a script that renders it
  screenshot.png     # reference render at a fixed viewport
  meta.json          # category, language/script, viewport, source, licence, notes

eval/labels/<screen_id>.json
```

```jsonc
{
  "screen_id": "gov-0042",
  "viewport": [1280, 720], "dpr": 1,
  "items": [
    { "entity": "AADHAAR", "box": [372,300,140,24], "value_hash": "sha256:…", "canary": false },
    { "entity": "FACE", "box": [40,90,96,96] },
    { "entity": "NONE", "box": [600,300,160,24], "note": "order number, looks like a card" }
  ],
  "tasks": ["task-login-submit-01"]
}
```

**Values are stored as hashes, never plaintext.** Design.md §18.1's reason is exact: the auditor
must be able to detect a leaked value in a captured payload without the corpus itself being a
plaintext PII store sitting in the repository. The auditor hashes candidate strings from the
payload and compares.

**Canary items** carry unique high-entropy strings. These are the tripwire: they appear on the
fixture page, and if one ever appears in an outbound payload, the guard's canary check (Phase 5's
T-5.8) fails CI. A canary that escapes is a leak that the recognizers did not have to be clever
enough to catch.

### 5.3 The Phase-1 fixture set (~30 screens)

Weighted toward the cases that will be hardest and most decisive later, not toward volume:

| Group | Count | Contents |
|---|---|---|
| Structured Indian identifiers | 8 | Aadhaar (valid Verhoeff, grouped and ungrouped), PAN, GSTIN, IFSC, UPI VPA, card numbers (valid Luhn), Indian mobile, email — each with its label in context |
| **Hard negatives** | 8 | 12-digit tracking ids that fail Verhoeff; 16-digit order numbers that fail Luhn; PAN-shaped product codes in a catalogue; prices; dates outside DOB context; a 6-digit number that is not a PIN code |
| Login / payment forms | 4 | `type=password` with a value present, `autocomplete=one-time-code`, `cc-number` + `cc-csc`, a KYC form |
| Faces and documents | 4 | Profile avatar, an ID-card image, a signature image, a QR code |
| Free text | 3 | Names and addresses in prose, a chat transcript, a profile page |
| Canvas / PDF | 2 | A canvas-rendered form, a PDF.js viewer page |
| Indic script | 1 | Devanagari text including Devanagari digits |

Every identifier is **synthetic with a valid checksum** and fictitious (design.md §17). Face images
need a licence permitting this use, recorded per image in `eval/corpus/README.md`.

The hard negatives are 8 of 30 on purpose. NFR-3 sets a false-redaction rate under 2% on hard
negatives, and AC-11 is an explicit acceptance criterion about checksum-invalid look-alikes. A
corpus without them measures only recall and flatters over-redaction.

### 5.4 The Playwright runner

```
eval/src/aegis_eval/runner/
├── browser.py      # persistent Chromium context with the unpacked extension
├── drive.py        # navigate fixtures, run scripted tasks, trigger observations
├── collect.py      # pull the privacy-ledger export out of the panel
└── resources.py    # OS-level process sampling
```

Two constraints from architecture §12.3 that shape this:

- **Playwright's bundled Chromium, not branded Chrome.** Branded Chrome builds have removed the
  side-loading flags that let an unpacked extension be injected. Firefox is run separately and
  manually (its temporary-add-on flow is not scriptable the same way) — which is consistent with
  Firefox being a Phase 6 target anyway.
- **Resource sampling happens on the harness side**, from OS process statistics and CDP driven by
  the harness process — *not* by giving the extension the `debugger` permission. Architecture §10.4
  explicitly refuses that permission, and a measurement instrument that changes the thing it
  measures (by widening the extension's own trust surface) would not be measuring the shipped
  product.

In Phase 1 the runner's job is only to prove the loop closes: launch → load extension → open a
fixture → obtain a ledger export (which will be empty) → write a report row. No assertions about
content.

### 5.5 The held-out guard

Design.md §18.4: the runner **refuses** `heldout/` unless invoked with an explicit flag, and writes
an audit line into the report every time it is used.

```
$ uv run aegis-eval run --split heldout
error: the held-out split is touched once, before submission.
       Re-run with --i-am-really-using-heldout and a reason:
       --reason "final pre-submission scoreboard, 2026-XX-XX"
```

This is built in Phase 1, when the folder is still empty, precisely because a guard added later is
a guard added after someone has already peeked. The audit lines accumulate in the report and are
part of what makes the reported numbers honest (NFR-15).

### 5.6 Report skeleton

One CSV per run plus one Markdown/HTML scoreboard. Every row carries, from the start: `n`, split,
hardware, browser version, backend, extension version, model versions, policy version, date
(design.md §18.2, FR-54). In Phase 1 the metric columns exist and are empty. Filling them is
Phase 5.

---

## 6. CI

```yaml
# .github/workflows/ci.yml  [new]
on: [push, pull_request]
jobs:
  build:
    steps:
      - pnpm install --frozen-lockfile
      - pnpm lint                     # boundaries + no-network + purity
      - pnpm -r typecheck
      - pnpm -r test                  # Vitest
      - pnpm gen:protocol && git diff --exit-code    # schema drift check
      - pnpm --filter @aegis/extension build
      - pnpm --filter @aegis/extension build:firefox
      - uv sync && uv run pytest      # gateway contract round-trip
      - uv run aegis-eval canary --split dev         # placeholder; real from Phase 5
```

The schema drift check (`gen && git diff --exit-code`) is the mechanism that makes "one contract"
true. The canary step is wired now and passes trivially; it becomes a real privacy regression gate
in Phase 5 (T-5.8), and from then on **any canary escape fails the build**.

---

## 7. Tasks & Acceptance Criteria

| # | Task | Acceptance Criteria |
|---|---|---|
| 1.1 | `sanitized-context.schema.json` per design.md §4.3 | Validates the document's own worked example; `additionalProperties: false` at every object level; no `url`/`origin`/`selector` field exists anywhere in the schema; id patterns enforced |
| 1.2 | `action-plan.schema.json` per design.md §4.6 | All 11 ops present; `maxItems: 5`; `type` is a `oneOf` over `ref`/`text` such that deleting the `text` branch is a one-hunk change; a 12th op and a 6-action plan both fail validation |
| 1.3 | `session.schema.json`, `error.schema.json` | `SessionCreate` carries no page data — asserted by a test that the schema has no field capable of holding page content; error codes match design.md §4.7's table exactly |
| 1.4 | `scripts/generate.ts` → TypeScript | `pnpm gen:protocol` writes `src/generated/*.ts`; output is byte-identical across two consecutive runs (idempotent) |
| 1.5 | Runtime validators compiled from schema | `validate.ts` exports a validator per schema; rejects each violation sample with the offending field path; no Ajv compiler in the shipped bundle |
| 1.6 | Schema → Pydantic v2 with `extra="forbid"` | Generated models importable from `aegis_gateway.protocol`; an unknown field raises `ValidationError` naming it |
| 1.7 | Contract round-trip test | ≥6 valid and ≥7 violation samples; every sample produces the **same verdict and the same named field** on both sides; runs in CI on both the JS and Python jobs |
| 1.8 | ESLint boundary rules from architecture §15.3 | An import from `src/content` to `src/host` fails lint; an import of `document` inside `packages/recognizers` fails lint; both demonstrated by a deliberately-added violation that is then reverted |
| 1.9 | Extend `check-no-network.ts` scope check | Unchanged behaviour, plus a test that the script itself exits 1 on an injected violation (the Phase-0 manual check, automated) |
| 1.10 | `.github/workflows/ci.yml` | All steps green on a clean checkout; the schema drift step fails when a schema is edited without regenerating |
| 1.11 | Wire the canary step into CI as a no-op placeholder | Step runs, exits 0, and is documented as becoming a hard gate in Phase 5 |
| 1.12 | `eval/corpus/` layout + `README.md` | Categories, quotas, sources and per-asset licensing documented; `dev/` and `heldout/` exist |
| 1.13 | Label file schema + validator | `aegis-eval validate-labels` passes over every label file; a label with a plaintext `value` instead of `value_hash` is rejected |
| 1.14 | ~30 dev fixtures per §5.3 | Distribution matches §5.3's table; every identifier is synthetic and checksum-valid; `validate-labels` passes over all 30 |
| 1.15 | Hard-negative fixtures | ≥8 hard negatives present, each with an `entity: "NONE"` label and a `note` explaining what it mimics; includes a Verhoeff-failing 12-digit and a Luhn-failing 16-digit |
| 1.16 | Canary strings planted | Every fixture carries ≥1 unique high-entropy canary recorded in its label file; no canary string appears in two fixtures |
| 1.17 | Playwright runner: persistent Chromium + unpacked extension | `uv run aegis-eval run --split dev` launches, loads the built extension, opens every dev fixture, exits 0 |
| 1.18 | Ledger export collection | Runner obtains an export object per fixture (empty in Phase 1) and writes it to `reports/<run>/ledger/`; a missing export is an error, not a silent skip |
| 1.19 | OS-level resource sampling | Runner records peak/mean RSS and CPU% per fixture **without** the extension holding the `debugger` permission — asserted by checking the built manifest in the same test |
| 1.20 | Held-out guard | `--split heldout` refuses without the explicit flag **and** a `--reason`; with them, it runs and appends an audit line naming the reason and date to the report |
| 1.21 | Report skeleton | CSV + Markdown scoreboard emitted with every provenance column populated (n, split, hardware, browser, backend, versions, date) and metric columns present-but-empty |

---

## 8. Milestone Definition

Phase 1 is **complete** when:

> A developer adds a field called `page_url` to `sanitized-context.schema.json`, thinking it would
> help the server. `pnpm lint` is fine. `pnpm gen:protocol` regenerates both sides. Then the
> contract round-trip test fails — not because the field is misspelled, but because a violation
> sample asserting *no payload may carry a URL* now passes validation when it must not. They read
> the test's message, read design.md §7.11, and delete the field. That is the contract doing its
> job before a single line of product code exists.
>
> They then run `uv run aegis-eval run --split dev`. Playwright's Chromium starts with the unpacked
> extension loaded, walks 30 local fixture pages — a fake Aadhaar enrolment portal, a login form
> with a filled password field, a product catalogue whose order numbers look exactly like card
> numbers but fail Luhn, a Devanagari municipal page, a PDF.js viewer — and writes
> `reports/2026-XX-XX-dev/scoreboard.md`. Every provenance column is filled in: 30 screens, dev
> split, the reference laptop named in DECISIONS.md, Chromium 1xx, backend wasm, extension 0.1.0,
> policy `default@2026.09.1`. Every metric column is blank, because nothing measures anything yet.
> They try `--split heldout` and are refused, twice — once for the flag and once for the reason.
>
> Nothing has been detected. Nothing has been redacted. Nothing has been sent anywhere. But the
> instrument that will judge the whole project is built, the corpus it will judge against contains
> eight traps specifically designed to catch over-redaction, and the contract that the client and
> server will both be held to rejects a URL by construction rather than by good intentions.

---

## 9. Files to Create

```
aegis_main/
├── eslint.config.js                          # [new] §15.3 boundaries + purity rules
├── .github/workflows/ci.yml                  # [new]
├── packages/protocol/
│   ├── schema/
│   │   ├── sanitized-context.schema.json     # [new] design.md §4.3
│   │   ├── action-plan.schema.json           # [new] design.md §4.6
│   │   ├── session.schema.json               # [new] design.md §4.2
│   │   └── error.schema.json                 # [new] design.md §4.7
│   ├── src/
│   │   ├── generated/*.ts                    # [new, committed] TS types
│   │   ├── validate.ts                       # [new] Ajv standalone validators
│   │   └── index.ts                          # [modify] real exports
│   ├── scripts/generate.ts                   # [modify] real generator
│   └── test/contract/
│       ├── samples/valid/*.json              # [new] ≥6
│       ├── samples/violation/*.json          # [new] ≥7
│       └── roundtrip.spec.ts                 # [new]
├── server/gateway/src/aegis_gateway/
│   └── protocol/*.py                         # [new, committed] generated Pydantic
├── server/gateway/tests/test_contract.py     # [new] Python half of the round-trip
├── eval/
│   ├── corpus/
│   │   ├── README.md                         # [modify] categories, quotas, licensing
│   │   └── dev/<30 screens>/                 # [new] page/, screenshot.png, meta.json
│   ├── labels/
│   │   ├── label.schema.json                 # [new]
│   │   └── <screen_id>.json                  # [new] ×30
│   ├── src/aegis_eval/
│   │   ├── cli.py                            # [modify] run / validate-labels / canary
│   │   ├── corpus/{loader.py,schema.py}      # [new]
│   │   ├── runner/{browser,drive,collect,resources}.py   # [new]
│   │   └── report/{writer.py,scoreboard.py}  # [new] provenance now, metrics Phase 5
│   └── tests/{test_labels.py,test_heldout_guard.py}      # [new]
└── docs/planning/phase_1_contract_harness.md # [this file]
```

---

## 10. Performance Validation

Phase 1 ships no runtime code into the extension, so there is nothing to optimise. What it does
establish are the budgets the contract itself imposes.

| Metric | How to Measure | Target |
|---|---|---|
| Sanitized-context payload size, typical L0 | `JSON.stringify` over the valid samples | Well under the 4 MB request cap (design.md §4.1); record the actual typical size so Phase 2 notices growth |
| Schema validation time, client | Bench the compiled Ajv validator over the samples | ≤ 2 ms — it runs on every step and is inside the guard's budget (design.md §10.2 allots ~2 ms to `guard`) |
| Generated bundle contribution | Size of `validate.ts` output in the built extension | Standalone validators only; **no Ajv compiler in the bundle** — asserted by a build-output grep |
| Harness run wall clock, 30 fixtures | `time uv run aegis-eval run --split dev` | Recorded as the baseline; Phase 5 grows the corpus 10× and needs to know the slope |
| CI wall clock | GitHub Actions run time | Recorded; the 28 MB ORT binary makes the two extension builds the dominant cost |

---

## 11. Estimated Complexity

| Component | New LOC | Files |
|---|---|---|
| `sanitized-context.schema.json` | ~320 | 1 |
| `action-plan.schema.json` | ~180 | 1 |
| `session` + `error` schemas | ~90 | 2 |
| `generate.ts` (TS + Pydantic, idempotent) | ~140 | 1 |
| `validate.ts` + generated validators | ~60 hand-written | 1 |
| Contract samples + round-trip specs (both languages) | ~280 | 16 |
| `eslint.config.js` + custom purity rules | ~130 | 2 |
| `ci.yml` | ~90 | 1 |
| Corpus loader + label schema + validator | ~210 | 3 |
| 30 fixtures (HTML + meta + labels) | ~1,400 | ~90 |
| Playwright runner (browser, drive, collect, resources) | ~430 | 4 |
| Held-out guard + audit line | ~70 | 1 |
| Report writer + scoreboard skeleton | ~240 | 2 |
| Harness tests | ~180 | 2 |
| **Total** | **~3,820** | **~127** |

New runtime dependencies in the extension: **1** (the compiled validator's tiny runtime; the Ajv
compiler stays out). Build/dev: `json-schema-to-typescript`, `ajv` + `ajv-cli`,
`eslint-plugin-boundaries`. Python: `datamodel-code-generator`, `playwright`, `pandas`.

---

## 12. Forward Dependencies Declared Here

- **The schemas define fields nothing writes yet** — `redactions[]`, `coverage`, `image`,
  `history`, `client_timing`. **[Phase 2 writes `nodes`, `text`, `history`, `client_timing`;
  Phase 3 writes `redactions` and the placeholder `value` kinds; Phase 4 writes `image` and the
  full `coverage` triple.]**
- **`action-plan.schema.json` is written to be a vLLM grammar, and is not used as one yet.**
  **[Phase 2's T-2.36 passes it as `response_format` to the model server.]**
- **`type`'s `text` branch exists pending OQ-14.** **[If the decision is "no literal text", the
  branch is deleted and the gateway's post-validation (Phase 2, T-2.38) loses one rule. The schema
  is structured so this is a single-hunk change.]**
- **The corpus has 30 screens and needs 200–300.** **[Phase 5's T-5.1. The categories and the
  80/20 split are fixed now so the growth is additive, not a re-layout.]**
- **Canary strings are planted and nothing checks them.** **[Phase 5's T-5.8 makes the guard's
  canary check a hard CI gate. Until then their presence is inert.]**
- **The runner collects ledger exports that are empty.** **[Phase 3 builds the privacy ledger
  (T-3.27); from then the exports carry per-step bytes, counts, coverage and verdicts, which is
  what every Phase 5 scorer reads.]**
- **Resource sampling is wired and unvalidated.** **[Phase 5's metric-4 scorer (T-5.5) depends on
  it; the reference laptop it must run on is OQ-16, closed in Phase 0.]**
- **The Pydantic models exist with no routes to validate.** **[Phase 2's T-2.33 wires them into
  `POST /v1/sessions/{id}/steps` with `extra="forbid"`, which is the moment FR-41's
  "server aware of the redaction scheme" becomes mechanically true.]**
- **The vault serialization lint check passes trivially** because `src/host/privacy/vault` does not
  exist. **[Phase 3 creates it; the check starts having an opinion the moment it does.]**

---

## 13. Implementation Notes — deviations found and decided during the build

Per CLAUDE.md's execution discipline: where implementation revealed this doc's plan was wrong or
in tension with itself, the decision taken is recorded here rather than left to drift silently
between spec and code.

1. **A real cross-language contract bug, found by the round-trip test doing its job.** §3.2's
   `type` action was originally written exactly as design.md §4.6 shows it: one object schema with
   `properties: {ref, text, ...}` and an inner `"oneOf": [{"required":["ref"]},{"required":["text"]}]`
   to express "exactly one of ref/text". Ajv evaluates that correctly — `type-both-ref-and-text.json`
   (a payload carrying both) is rejected. `datamodel-codegen`, however, flattens an inner `oneOf`
   by generating **two independent Pydantic models** (`Action2` with `ref` required and `text`
   optional; `Action3` with `text` required and `ref` optional), each of which — because the
   *other* field is merely optional, not forbidden — accepts a payload carrying both. Pydantic's
   union validation picks whichever member matches first and stops, so the same payload that Ajv
   correctly rejects **validated successfully** under the generated Python model. Caught by
   T-1.7's round-trip test (`type-both-ref-and-text.json` in the violation manifest) before this
   reached the gateway's own action validator.

   **Fixed at the schema, not by hand-patching generated code** (which would violate "never
   hand-edit generated files," CLAUDE.md §6): `action-plan.schema.json`'s `type` action was split
   into two genuinely disjoint top-level branches — one requiring `ref` and not declaring `text` as
   a property at all, one requiring `text` and not declaring `ref`. With `additionalProperties:
   false` and no shared inner `oneOf`, each branch now rejects the other field as an unrecognized
   extra property on **both** sides, verified identically by Ajv (`additionalProperties`,
   `instancePath: "/actions/0"`, `additionalProperty: "text"`) and Pydantic (`extra_forbidden`,
   `loc` containing `text`). This also directly serves OQ-14's forward dependency noted above: the
   literal-text branch is now trivially the "one-hunk deletion" design.md intends, since it is a
   fully independent branch rather than a shared field.

2. **`ajv-formats`' `format: "uuid"` cannot be used in standalone ESM output.** The original
   `session_id` field used `"format": "uuid"`. Ajv's format-checking function for `uuid` is
   registered by `ajv-formats` at runtime and the standalone code generator emits a `require(...)`
   call to reach it — which throws `ReferenceError: require is not defined` under Node's ESM
   loader, `require` not existing there. Rather than post-processing around `ajv-formats`
   specifically, `sessionId` in `common.schema.json` was changed to a `pattern` (a UUIDv4-shaped
   regex) instead of `format: uuid`, and `ajv-formats` was dropped from the generator entirely —
   removing the whole class of problem rather than working around one instance of it.

3. **A second, unrelated `require()` in Ajv's own standalone output, needing a genuinely portable
   fix.** Independent of (2), Ajv's standalone codegen always emits
   `const fN = require("ajv/dist/runtime/ucs2length").default;` at module scope for Unicode-correct
   `maxLength`/`minLength` checking — this is Ajv's own internal runtime helper, unrelated to
   `ajv-formats`, and unavoidable given the schemas' `maxLength` usage. `code.esm: true` only
   controls the *export* syntax; it does not rewrite internal `require()` calls into `import`
   statements. `scripts/generate.ts`'s `esmifyRuntimeRequires()` post-processes the generated
   source, hoisting each such `require` into a real static `import * as ns from "<path>.js"` at the
   top of the file. Getting the *binding* right took two more rounds, each measured rather than
   assumed:
   - Under native Node, a namespace import's `.default` resolves to the *whole* CJS
     `module.exports` object (not to `exports.default`) for these TS-compiled-CJS modules, because
     Node's cjs-module-lexer statically detects a named export literally called `default` and that
     collides with the synthetic whole-module default — so the real function sits one level
     deeper, at `ns.default.default`.
   - Under Vite/esbuild's CJS interop — which is what Vitest and, ultimately, the WXT extension
     build both use — `ns.default` is *already* the function; `.default.default` is `undefined`,
     and calling it throws `TypeError: func2 is not a function`.

   Verified empirically against this exact module under both runtimes rather than assumed from
   documentation. The generated const is defensive rather than environment-specific:
   `typeof ns.default === 'function' ? ns.default : ns.default.default`, which resolves correctly
   under both. Confirmed: `pnpm --filter @aegis/protocol test` (Vitest/Vite) and a plain `node`
   invocation of the generated module both pass all 12 round-trip cases.

4. **Two Pydantic root-class names needed an override to match the TS side.**
   `datamodel-codegen` names the root class from the schema's `title` when a file has exactly one
   root type; `sanitized-context.schema.json`'s title `"SanitizedContext (StepRequest)"` and
   `action-plan.schema.json`'s `"ActionPlan (StepResponse)"` produced `SanitizedcontextSteprequest`
   and `ActionplanStepresponse` — technically correct, awkward for code that will import and use
   them constantly in Phase 2. `--class-name` is now passed for exactly these two files
   (`PYDANTIC_CLASS_NAME_OVERRIDE` in `generate.ts`), producing `SanitizedContext` / `ActionPlan` to
   match the TS-side names exactly. `session.schema.json` and `error.schema.json` needed no
   override — their `$defs` keys and title already produced `SessionCreate` / `SessionCreated` /
   `ErrorResponse` correctly.

5. **The equivalent naming problem on the TypeScript side had the same root cause, fixed
   differently.** `json-schema-to-typescript`'s `compile(schema, name, options)` prefers
   `schema.title` over the passed `name` when both are present, and then falls back to a
   `$id`-derived name if `title` is absent — so simply deleting `title` was not enough; `$id` had
   to be deleted too before compiling. Both are deleted from an in-memory copy of the schema object
   handed to the compiler, never from the schema file on disk.

6. **`readdirSync(...).filter((f) => ...)` and `execFileSync(runner[0], ...)` needed `@types/node`
   and a tuple return type respectively** to satisfy `noUncheckedIndexedAccess` — already present
   transitively in the lockfile, added as an explicit devDependency for clarity; `findDatamodelCodegen()`'s
   return type was changed from `string[]` to `[string, ...string[]]` so `runner[0]` is known
   non-empty at the type level rather than requiring a runtime guard.

7. **`datamodel-code-generator` is not installed globally** (neither `uv` nor `uvx` exist in this
   environment, consistent with the Phase-0 finding). Installed into `server/gateway/.venv`
   (already created in Phase 0) via plain `pip`, and `findDatamodelCodegen()` prefers that venv's
   binary first, falling back to `uvx` and then a bare `datamodel-codegen` on `PATH` — so the
   generator works today and will also work once the team installs `uv`, without a code change
   either way.

   **A real gap this exposed, caught and closed rather than left standing:** the tool was only
   ever `pip install`ed manually into that venv — nowhere in version control declared it as a
   dependency. A fresh clone (or CI) would have `pip install -e ".[dev]"` succeed, `pytest` pass,
   and then `pnpm gen:protocol` silently fail at the Pydantic step with no working
   `datamodel-code-generator` anywhere the script looks. Fixed by adding it to
   `server/gateway/pyproject.toml`'s `dev` extras. **Verified, not assumed:** deleted `.venv`
   entirely, rebuilt it from nothing but `pip install -e ".[dev]"`, and confirmed
   `datamodel-codegen --version` works and all 13 pytest cases pass from that clean install alone.
   Separately verified the generator is genuinely idempotent (T-1.4's acceptance criterion): ran
   `pnpm gen:protocol` twice in a row and diffed the output — byte-identical.

8. **ESLint boundary rules (T-1.8) verified live, not by reading the config.** Each direction was
   proven by writing a real temporary violation, running `eslint` against it, confirming the exact
   expected failure, then deleting the temp file: `document` referenced inside
   `packages/recognizers` (caught by `no-restricted-globals`); `src/content` importing
   `src/host`, `src/perception` importing `src/content`, and `src/host` importing `src/content`
   (all three caught by `no-restricted-imports` patterns, each with its own message naming the
   violated boundary). A plain `eslint .` over the whole repo returns clean both before and after.
   Implemented with ESLint's built-in `no-restricted-imports`/`no-restricted-globals` rather than
   `eslint-plugin-boundaries` — no extra dependency needed for this project's specific, small set
   of directory rules.

9. **`check-no-network.ts`'s scan logic was extracted into a pure, parameterized function**
   (`no-network-scan.ts`) specifically so T-1.9's acceptance criterion — the check demonstrably
   failing on a real violation — could become a permanent, automated Vitest suite
   (`test/unit/no-network-scan.test.ts`, 5 cases run against a scratch temp directory) rather than
   the manual "add a violation, run it, revert it" verification done by hand in Phase 0. The CLI
   entrypoint is now a ~10-line wrapper around the tested function. Re-ran the real CLI against the
   actual extension source afterward to confirm the refactor changed nothing observable
   (`4 files scanned`, same as before).

10. **`.github/workflows/ci.yml` (T-1.10) is written and YAML-syntax-validated, but has not run on
    a real GitHub Actions runner** — this environment has no such runner to exercise it against.
    Every command inside it was instead verified to work by running it directly: `pnpm install`,
    `pnpm lint`, `pnpm -r typecheck`, `pnpm -r test`, both extension builds, `uv pip install -e
    ".[dev]"` into a fresh venv, `pytest`, and `pnpm gen:protocol && git diff --exit-code` (item 7
    above). What is **not** verified is the GitHub Actions-specific plumbing itself — the
    `astral-sh/setup-uv` and `pnpm/action-setup` actions, caching behaviour, and job dependency
    ordering (`needs: [js, py]`) — which can only be confirmed by an actual run once this is
    pushed. Flagged rather than claimed.

11. **Playwright's Chromium runs genuinely headless in this environment, including with the real
    extension loaded — measured, not assumed possible.** `playwright install chromium` succeeded
    without `--with-deps` (no sudo available; the OS is unrecognised by Playwright's dependency
    installer, "ubuntu24.04-x64 as a fallback"). The default `headless=True` launches the
    "headless shell" binary, which **does not support extension loading at all** — confirmed by a
    direct failure (`Executable doesn't exist at .../chrome-headless-shell`). The documented
    workaround — `headless=False` combined with the raw `--headless=new` Chromium flag, which
    selects the full binary but still runs with no display — was tested and confirmed by loading
    the real built extension and observing its background service worker actually start
    (`ctx.service_workers` non-empty). A `--no-sandbox` flag was tried first (copied reflexively
    from a common pattern) and then **removed after testing that the launch succeeds without it**
    — disabling Chromium's own sandbox unconditionally would have been a real, unnecessary
    security regression in a security-conscious project, and it was not needed here.

12. **A JSON Schema `if`/`then` vacuous-truth bug, the same class as Phase-0's, found again in
    `label.schema.json`.** The `canary_id` requirement was written as
    `if: {properties: {canary: {const: true}}}` — but `properties` only constrains a property
    *if present*; when `canary` is absent (the common case), the sub-schema is vacuously
    satisfied, so the `if` matched *every* item and required `canary_id` on all of them,
    immediately failing the very first hand-written test label. Fixed by adding
    `required: ["canary"]` to the `if`, mirroring the fix already recorded for the protocol schema
    in this document. **This is the second time this exact mistake was made independently** —
    worth remembering as a standing gotcha (`properties` is not `required`) rather than a one-off.

13. **The `value_hash`-required rule needed two more exclusions than first written, both found by
    running the validator against real generated data rather than by re-reading the schema.**
    Presence-only entities (PASSWORD, OTP, CARD_NUMBER, CARD_CVV — FR-23, nothing is ever read to
    hash) and canary items (their value is already plaintext in `canary_id`; a redundant hash adds
    nothing) both initially failed `'value_hash' is a required property` on real fixture data.
    Both added to the exclusion list; the field's schema `description` was rewritten to state the
    full, now-correct rule rather than the original partial one.

14. **Real Verhoeff/Luhn/GSTIN implementations were verified against external reference data, not
    only internal round-trips — and one assumed-known test vector turned out to be wrong.** Luhn
    was checked against the widely-published test number `4532015112830366` (passes) and
    `...67` (correctly fails). GSTIN's algorithm, implemented from public documentation with no
    official test vector on hand, was corroborated independently: the prefix
    `27AAPFU0939F1Z` — a commonly cited example GSTIN recalled from memory — produced check
    character `V` under this implementation, reproducing the full number `27AAPFU0939F1ZV`
    exactly as commonly published elsewhere. Separately, an assumed "all-zero Verhoeff base has
    check digit 0" turned out to be simply wrong when tested (`AssertionError: '3' == '0'`) — it
    was never a documented fact, just an unverified guess, and the test was rewritten to assert
    genuine round-trip validity instead of a memorised-and-incorrect digit. Both single-digit-change
    exhaustive-detection tests (Verhoeff and Luhn) pass over every position and every wrong digit,
    which is the real, meaningful guarantee these checksums exist to provide.

15. **A dedicated Playwright-based spot-check (`test_fixture_boxes_match_dom.py`) caught two real
    CSS box-model bugs in the fixture generator that hand-verified arithmetic had missed, exactly
    as its own docstring anticipated it might.** Both are the same underlying mistake — assuming a
    `position:absolute` element's `left`/`top` are always relative to the viewport, when they are
    actually relative to the nearest **positioned** ancestor:
    - `pdf-001`'s Aadhaar field was nested inside a `position:absolute` "viewer frame" div; its
      `left:80px;top:160px` was relative to that frame (itself at `40,60`), rendering at
      `(120,220)`, not the labelled `(80,160)`. Fixed by separating the CSS-local coordinates
      (relative to the frame) from the label's viewport-absolute coordinates.
    - `freetext-001`'s `PERSON_NAME` span was nested inside an **also-`position:absolute`**
      wrapping `<p>`, shifting it by that paragraph's own `(16,16)` offset. Fixed by making the
      wrapping `<p>` `position:static` (normal flow) so it no longer establishes a containing
      block, rather than computing a second coordinate offset.

    A related, non-nesting bug was found by the same test: browsers apply a default
    `margin: 1em 0` to `<p>` elements, and — because `position:absolute` positions the **margin
    box**, not the border box — that default margin still shifted `freetext-001`'s `#addr` element
    by 16px despite explicit `left`/`top`. The project's CSS reset only zeroed `body` margin/padding;
    fixed by resetting `* { margin: 0; padding: 0; }` globally instead of per-element, closing the
    whole class of bug rather than the one instance found.

    Two more fixtures needed fixes once the check covered all 30 rather than an initial 8-fixture
    sample: `faces-001..004`'s SVG placeholder containers had no `id` attribute at all, so nothing
    matched a positional query for them (masked by the test only checking a sample that happened
    not to include them); and `freetext-002`'s `PHONE` label box was sized to the phone number's
    own visual width, but the actual DOM element is the whole containing sentence ("Call me at …
    when you land") — widened the label box to the sentence's real measured width and documented
    this as intentionally representing design.md §7.1's OCR line-fallback behaviour (a low-confidence
    partial match expands to the whole line), not a mistake to hide.

    The test itself had a masking bug of its own, also fixed: its nearest-measured-element matching
    did not remove a matched element from the candidate pool, so two labels could silently match
    the *same* real element — which is exactly how the `freetext-001` bug initially passed an x/y
    check by accident (matching against the wrong, coincidentally-nearby `#addr` element rather than
    the real, off-target `#name`). Fixed by removing each match from the pool once claimed.

    Final state: all 29 measurable fixtures (every fixture except `canvas-001`, whose value is
    drawn on a `<canvas>` with no DOM box to measure) pass, verified against real
    `getBoundingClientRect()` output in real Chromium, not against the generator's own arithmetic.

16. **`screenshot.png` (part of the corpus layout `eval/corpus/README.md` documents) was missing
    from the initial generation pass** — a real gap, not a deferred item — and was closed in the
    same session with `screenshot_fixtures.py`, then spot-checked visually (not just "ran without
    error"): a plain text fixture, a placeholder avatar graphic, the Devanagari fixture (confirming
    real Devanagari digit glyphs render correctly, not just that the Unicode codepoints are present
    in the file), and `pdf-001` after its nesting fix (confirming the Aadhaar field visually sits
    inside the viewer frame where it now correctly belongs).

17. **`eslint.config.js` (T-1.8) had a real gap, found only by running the final whole-workspace
    verification after this phase's Python venvs existed to trip over it.** ESLint's flat config
    does **not** read `.gitignore` automatically (unlike the legacy `.eslintrc` era) — a fact that
    had no visible consequence in Phase 1's first pass, when `eslint.config.js`'s own `ignores`
    list happened to cover everything that existed at the time. Once `eval/.venv/` and
    `server/gateway/.venv/` came into existence (this same session), `eslint .` recursed into
    them and linted a **vendored third-party file**,
    `eval/.venv/.../playwright/driver/package/cli.js`, producing **10,009 errors** — almost
    entirely noise from code never meant to be linted, plus two real-looking-but-irrelevant
    `no-require-imports` hits inside Playwright's own driver bundle. Fixed by adding
    `**/.venv/**` (and, defensively, `**/.pytest_cache/**` and `**/corpus/**`) to the ignores
    list. Verified the fix both ways: `eslint .` is clean again, **and** the boundary rules still
    fire correctly afterward — re-ran the exact `document`-in-`packages/recognizers` violation
    from item 8 above and confirmed it is still caught, so the fix silenced only what it was meant
    to silence.
