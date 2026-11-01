# Phase 3 — The Privacy Core: Detection, Fusion, Typed Placeholders, the Vault & the Egress Guard

**Document type:** Phase 3 execution document
**Requirements basis:** FR-20, FR-21, FR-23, FR-24, FR-25, FR-26, FR-27, FR-28, FR-29, FR-30, FR-32, FR-33, FR-34, FR-35; NFR-2, NFR-3, NFR-6, NFR-10, NFR-12; **AC-2, AC-6, AC-9, AC-11**
**Architecture basis:** `architecture.md` §7 in full (the hard core), §2 P3–P7, §10.2 (threat model), §16 (build order step 4)
**Design basis:** `design.md` §3.2–3.4 (candidates, entities, vault), §6.1–6.3 (channels D and T, NER), §7.1–7.4 (fusion, policy, placeholders, escaping), §7.6 (guard), §8 (vault), §9.2–9.3 (risk, rehydration), §13.1 (panel)
**Depends on:** Phase 2 in full — the screen graph produces the candidates, the controller has a `SANITIZING` state to fill, the egress client already accepts only branded payloads, and the gateway already refuses unexpected fields. OQ-1, OQ-3, OQ-6, OQ-8, OQ-10 and OQ-14 should be closed before implementation; §11 states what each one changes.
**Status:** Built and tested against this document as of 2026-09-18. See §9a for implementation
notes (real deviations found by testing) and §10 for the task-by-task status.

---

## 1. Objective

This is the phase the project exists for. [SS] places 70% of the engineering effort in this layer,
and architecture §7 is titled "the hard core" for a reason: everything else is a browser agent that
has been built before. What has not been built before is an agent that completes a task requiring a
sensitive value **without the value ever leaving the device**.

The mechanism, from [SS] and architecture §7.4: every sensitive value on screen is replaced by a
**typed sealed placeholder** — `⟪AADHAAR#2⟫` — that preserves the value's *type and structure* while
destroying its *content*. The remote model can reason about it perfectly well ("the Aadhaar field
needs the value shown above it") and can even instruct the client to type it, but it cannot resolve
it. Only the client can, from an in-memory vault, and only into a field whose type matches, on the
origin where the value was seen, under a confirmation policy.

This is what makes metrics 1, 2 and 3 improve *together* rather than trade against each other, which
is the central insight of the strategy [SS]. Black-box redaction destroys the context the server
needs (metric 1) to buy recall (metric 2). Typed placeholders keep the labels, the roles, the layout
and the semantics, and remove only the value.

**By the end of this phase:** the same fixture login page from Phase 2, now with a visible Aadhaar
number and a filled password field. The developer runs the same task. The panel splits: live page on
the left, **exactly what was sent** on the right. The right-hand side reads
`"Aadhaar on record: ⟪AADHAAR#2⟫"`, and the password field shows
`{"kind":"presence","entity":"PASSWORD","len":9}` — a length, not a value, because the content
script has no code path that reads that field at all. The model returns
`type(n-7f, ref=⟪AADHAAR#2⟫)`. The panel asks for confirmation. The user allows it. The real Aadhaar
number appears in the field on the page. The server never saw it, in either direction.

Then the developer sabotages a recognizer to force a miss, re-runs, and **nothing is sent** — the
egress guard's independent sweep finds the raw value in the serialized bytes and blocks the request,
fail-closed, with the reason on screen.

**No vision, no images, no OCR.** Detection in this phase is DOM signals, deterministic text
recognizers and a small NER model over text. Faces, ID documents and canvas content are Phase 4.
The payload stays L0 — structured only.

---

## 2. What this phase inherits, builds and deletes

| Path | Inherited | Phase 3 action |
|---|---|---|
| `src/host/egress/guard-stub.ts` | `[Phase 2]` pass-through, fixture-origin only | **DELETED (T-3.26).** Its CI tripwire becomes permanent |
| `src/host/egress/{client,brand}.ts` | `[Phase 2]` accepts only branded payloads | **Kept.** Only the producer of the brand changes |
| `src/host/privacy/context/builder.ts` | `[Phase 2]` raw L0 payload | **Rewritten** to substitute placeholders and emit `redactions[]` |
| `src/content/screen-graph/extractor.ts` | `[Phase 2]` reads every field value | **Modified (T-3.9):** protected classes lose their read path entirely |
| `src/content/observe/epochs.ts` | `[Phase 2]` computes `privacyEpoch`, unread | **Consumed** — now forces re-analysis before a send |
| `packages/recognizers` | `[scaffold]` | **Filled** — checksums, patterns, context boosts, normalisation |
| `packages/policy` | `[scaffold]` | **Filled** — versioned policy JSON, loader, typed accessors |
| `src/perception/worker.ts` | `[built-spike]` Phase-0 probe/bench | **Gains the NER path only.** Faces/ViT/OCR stay Phase 4 |
| `src/host/actions/validator.ts` | `[Phase 2]` schema, lease, facets | **Extended** with rehydration rules and CRITICAL risk gating |
| Panel | `[Phase 2]` timeline, metrics | **Gains** payload viewer, redaction counts, confirmation cards, guard-block card |
| `eval/` runner | `[Phase 1]` collects empty ledger exports | **Consumed** — exports are now non-empty and carry the first real detection counts |

---

## 3. Detection

Architecture §7.2 defines three channels. Phase 3 builds two of them; Channel V is Phase 4.

### 3.1 Channel D — DOM signals

Near-certain, zero cost, and **never reads protected values**. Design.md §6.1:

| Signal | Entity | Score | Value read? |
|---|---|---|---|
| `input[type=password]`, `-webkit-text-security`, masked-glyph run | PASSWORD | 1.00 | **No** |
| `autocomplete~=one-time-code`, or numeric field with OTP wording | OTP | 1.00 | **No** |
| `autocomplete~=cc-number` | CARD_NUMBER | 1.00 | **No** |
| `autocomplete~=cc-csc` | CARD_CVV | 1.00 | **No** |
| `autocomplete~=cc-exp*`, `cc-name` | CARD_EXPIRY / PERSON_NAME | 1.00 / 0.95 | Yes |
| `autocomplete` ∈ email, tel*, street-address, postal-code, bday*, name, username | mapped | 0.95 | Yes |
| `type=email`, `type=tel`, `inputmode=email/tel` | mapped | 0.85 | Yes |
| Name/id/label heuristics (`aadhaar`, `aadhar`, `uid`, `pan`, `acct`, `ifsc`, `dob`, `passport`, `upi`) | mapped | 0.60 | Yes |
| Field inside a KYC/payment-lexicon form | +0.15 boost | — | — |

### 3.2 The protected-value rule — FR-23, and how it is enforced

For PASSWORD, OTP, CARD_NUMBER, CARD_CVV and SECRET fields, the content script records `hasValue`
and `valueLen` and nothing else. Design.md §6.1 is explicit: *there is no code path that reads
`.value` for them*.

This is a **deletion, not a check**. A conditional that reads the value and then decides not to send
it is one refactor away from a leak, and it puts the value in a JavaScript string that a later bug
could log. The extractor is restructured so the read is unreachable for those classes:

```ts
// The classification happens BEFORE any value access, and the protected branch
// has no expression that touches .value at all.
const protectedClass = classifyProtected(el);      // FR-23
if (protectedClass) {
  return { inputType, autocomplete, maskedCss,
           valueRead: false, hasValue: el.value.length > 0, valueLen: el.value.length };
  //                                    ^^^^^^^^^^^^^^^^^ length only — never the string
}
```

Even `.value.length` is a read of the property; what matters is that the *string* is never bound to
a variable, never enters the graph, never enters the vault, and therefore can never be serialized.
T-3.9's acceptance test asserts this at the source level as well as behaviourally.

**The consequence for the demo**, from architecture §1.3 C-2: the vault never holds a password, so
`type(field, ⟪PASSWORD#n⟫)` has nothing to resolve and is rejected. The strategy's "log in" demo
works because the password is *already in the field* (typed by the user or their password manager)
and the agent only clicks submit.

### 3.3 Channel T — deterministic recognizers

`packages/recognizers`, pure functions, no DOM, no browser APIs — so they are unit-testable in Node
and reusable by the harness. Design.md §6.2:

| Recognizer | Validator | Base score (valid / invalid) |
|---|---|---|
| Aadhaar (12 digits, first 2–9, optional 4-4-4 grouping) | **Verhoeff** | 0.95 / 0.30 (0.60 with label context) |
| Masked Aadhaar (`XXXX XXXX 1234`) | none | 0.70 |
| PAN (`[A-Z]{5}[0-9]{4}[A-Z]`, 4th char in holder-type set) | structure | 0.90 |
| GSTIN (state + PAN + entity + Z + check) | **GSTIN check character** | 0.95 / 0.40 |
| IFSC (`[A-Z]{4}0[A-Z0-9]{6}`) | structure | 0.85 |
| UPI VPA | not-an-email-TLD; handle list as context | 0.80 |
| Card (13–19 digits) | **Luhn + IIN ranges** | 0.95 / 0.10 |
| Indian mobile (`[6-9]\d{9}`, optional +91/0) | length | 0.80 |
| International phone | per-country length table | 0.70 |
| Email | TLD sanity | 0.95 |
| Passport IN (`[A-Z][0-9]{7}`) | **label context required** | 0.30 → 0.85 |
| Vehicle registration IN | state-code table | 0.75 |
| PIN code | **address context required** | 0.20 → 0.70 |
| DOB | **label context required** | 0.30 → 0.85 |
| Secrets (API keys, JWT shape, PEM headers) | entropy threshold | 0.85 |

**Checksums are what make metric 3 achievable.** NFR-3 asks for a false-redaction rate under 2% on
hard negatives, and AC-11 is an explicit criterion about it. A 16-digit order number and a card
number are indistinguishable by pattern; Luhn separates them. A 12-digit tracking id and an Aadhaar
number are indistinguishable by pattern; Verhoeff separates them. The 0.10 and 0.30 scores for
checksum-invalid matches are what turn these into non-detections after thresholding.

**Normalisation before matching** (design.md §6.2): Unicode NFKC, **Indic digits mapped to ASCII**,
zero-width characters removed, full-width folded. The Indic mapping is not optional — A-4 assumes
page content may include Indic scripts, and an Aadhaar number written in Devanagari digits is still
an Aadhaar number. A recognizer that only sees ASCII digits has a silent recall hole exactly where
the problem statement's context is strongest.

### 3.4 Channel T — NER over free text

Design.md §6.3. Profile **S** (default): a small pretrained token classifier, WASM-capable, running
in the perception worker. Profile L (OpenAI Privacy Filter, q4, WebGPU-only) is **Phase 6** — it is
reportedly ~770 MB of weights, which is a metric-4 problem, and OQ-7 says decide from harness
numbers rather than from a preference.

- **Pre-filter** before the model runs at all: capitalised word runs, gazetteer hits, digit
  clusters, proximity to a context lexicon, or any text inside form/profile/contact containers. The
  model is the expensive path; most text never reaches it.
- Chunking ≤256 tokens with 32-token overlap, batched per step.
- Output mapped to the entity enum via a per-profile table.
- Results cached by normalized-text hash.

No training and no fine-tuning (C-6, [SS]) — pretrained, off-the-shelf, as-is.

---

## 4. Fusion and policy

### 4.1 The fusion algorithm

Design.md §7.1, in order:

```
1. map each candidate to a class via policy.entityClass(entity)
2. threshold with a fail-closed uncertainty band:
     score ≥ τ(class)                  → accept
     τ(class) − 0.15 ≤ score < τ(class) → accept, unverified = true
     score < τ(class) − 0.15           → drop
3. cross-channel agreement: DOM span and OCR box overlapping (IoU ≥ 0.5), same entity
     → merge, keep DOM geometry (more precise), take max score
4. group by overlap (IoU > 0, or touching after 1 px dilation)
     same entity → union of boxes;  different → highest class wins, entities[] unions
5. rectangle decomposition (≤4 rects per region; merge if area gain < 10%)
6. dilation: +2 px all sides, vertical +8% of line height,
     clamped so a box never enters a non-sensitive sibling's box by more than 1 px
7. token expansion: a partial span expands to the whole whitespace-delimited token
8. OCR line fallback: word confidence < 0.8 → redact the whole line
9. de-escalation ONLY via a versioned policy allow-rule or a user session un-redact
10. LOW class → no region (pass through)
```

**Step 2's band is the fail-closed principle in arithmetic.** A candidate that is *probably* an
Aadhaar number but below threshold is not discarded — it is accepted and marked `unverified`. The
asymmetry is deliberate and directional: a false redaction costs metric 3 a little; a missed
detection costs metric 2 and, if it reaches the wire, costs the entire privacy claim.

**Steps 5–7 are where metric 3 is won or lost.** Dilation that swallows the neighbouring label
destroys the context the model needs; dilation that is too tight leaves antialiased glyph edges
readable. The clamp against sibling boxes is what keeps "Aadhaar number: ⟪AADHAAR#2⟫" fully
actionable while the value itself is gone.

**Step 9 is a one-way ratchet.** Any channel may escalate; nothing may de-escalate except an
explicit versioned rule or a deliberate user action. This is what stops a low-confidence "it's
probably fine" signal from unblocking a high-confidence detection.

### 4.2 Policy as versioned data

Design.md §7.2. Classes, thresholds, operators, entity→class map, presence-only list, partial
disclosure, cross-origin rule, risk rules — all in `packages/policy/policies/default.policy.json`,
schema-validated at load, **version recorded in every payload**.

```jsonc
{
  "id": "default", "version": "2026.09.1",
  "classes": {
    "CRITICAL": { "threshold": 0.30, "operator": "placeholder_or_fill", "rehydrate": "confirm" },
    "HIGH":     { "threshold": 0.50, "operator": "placeholder", "rehydrate": "auto_same_origin" },
    "MEDIUM":   { "threshold": 0.70, "operator": "placeholder", "rehydrate": "auto_same_origin" },
    "LOW":      { "threshold": 0.85, "operator": "pass", "rehydrate": "n/a" }
  },
  "presenceOnly": ["PASSWORD","OTP","CARD_NUMBER","CARD_CVV","SECRET"],
  "partialDisclosure": { "CARD_NUMBER": { "last4": false } },   // OQ-6
  "crossOriginRehydration": "deny",                              // OQ-8
  "allowRules": [],
  "riskRules": { "confirm": ["submit_on_auth_or_payment_form","send","delete","purchase",
                             "download","navigate_other_origin","click_point","rehydrate_critical"] }
}
```

Note the **class-asymmetric thresholds**: CRITICAL accepts at 0.30, LOW demands 0.85. Cheap to be
wrong about a city name; expensive to be wrong about an Aadhaar number.

Policy is data so that Phase 5's harness can sweep thresholds without a code change, and so that
every reported number can name the policy version it was produced under (FR-54).

---

## 5. Typed placeholders and the vault

### 5.1 Placeholder identity

Architecture §7.5 evaluated three schemes and selected the third:

| Option | Verdict |
|---|---|
| Random id per occurrence | **Rejected** — the server cannot tell two occurrences are the same value, losing coreference |
| HMAC(session key, value) truncated to 2 bytes | **Rejected** — 16-bit ids collide within a session (a correctness bug), and a truncated keyed hash adds no protection the vault does not already provide |
| **Per-session counter via the vault's value→ref map** | **Selected** — same value → same ref within a session; different values never collide; a new session renumbers, so refs are not linkable across sessions |

FR-27 requires the same value to map to the same placeholder; the counter gives that for free, and
`mint()` is a map lookup before it is an allocation.

### 5.2 What a placeholder looks like on the wire

```
In text:          "Signed in as ⟪EMAIL#1⟫"
In a node value:  { "kind":"placeholder", "ref":"⟪AADHAAR#2⟫", "entity":"AADHAAR", "len":12 }
Presence-only:    { "kind":"presence", "entity":"PASSWORD", "len":9 }      // no ref
In an image:      opaque box with the placeholder drawn inside it          // Phase 4
```

Labels, roles and layout are untouched. `"Aadhaar number: ⟪AADHAAR#2⟫"` is fully actionable.

The delimiters `⟪` `⟫` (U+27EA/U+27EB) were chosen because they essentially never occur on real
pages — which makes §5.3's defence cheap and unambiguous.

### 5.3 Escaping page text — a real attack, cheaply closed

Design.md §7.4. If page text already contains `⟪` or `⟫`, they are rewritten to `‹‹` / `››` **before**
substitution.

Without this, a hostile page can render the literal text `⟪AADHAAR#2⟫` and try to convince the model
to emit `type(comment_box, ref=⟪AADHAAR#2⟫)` — an exfiltration attempt that routes the user's real
Aadhaar number into an attacker-readable field. The escaping means a page can never produce a
string that *looks* like a mint, and the client independently only resolves refs that exist in the
vault and were minted this session.

This is defence in depth against architecture §10.2's "prompt injection from page content" and
"malicious or compromised server" rows at once.

### 5.4 The vault

Design.md §8. An in-memory `Map` in the agent host with a deliberately minimal surface:

```ts
interface Vault {
  mint(entity, value, ctx): string;                    // returns ref
  has(ref): boolean;
  describe(ref): { entity, class, len } | undefined;   // metadata only, never the value
  resolveFor(ref, target): ResolveResult;              // policy-checked, §6.2
  normalizedValues(): IterableIterator<string>;        // GUARD ONLY, module-private export
  clear(): void;
}
```

**There is no `toJSON`, no `entries()`, no iteration, no `values()`.** A module that cannot be
serialized cannot be accidentally serialized — this is FR-28 enforced by API shape rather than by
review. `normalizedValues()` exists solely for the guard's leak sweep and is a module-private
export.

Lifetime: created per task; `clear()` on task end, cancel, panel `pagehide`, and after 10 minutes
idle.

**A stated limitation, not hidden** (design.md §8): JavaScript offers no secure memory zeroing.
Values are ordinary strings. The design limits exposure by keeping them in one module, never logging
them, and dropping references on clear. The honest-claims rule (NFR-15) means this appears in the
README and in the judge Q&A, not only in a design document.

---

## 6. Rehydration — the feature the project exists for

### 6.1 The flow

Architecture §9.4:

```
server plan:  type(n-12, ref=⟪AADHAAR#2⟫)
client:       schema ok → lease ok → n-12 exists, visible, role=textbox, name≈"Aadhaar"
              → field type matches AADHAAR (label / autocomplete / pattern evidence)
              → origin matches where #2 was seen
              → CRITICAL: confirmation (OQ-1) — "Type your Aadhaar (•••• •••• 1234) into
                'Aadhaar number'?"
              → user allows → vault resolves #2 → content script types the real value
server sees:  only ⟪AADHAAR#2⟫, before and after
```

### 6.2 `resolveFor` — all six conditions

Design.md §9.3. The value is returned **only if every one holds**:

1. `ref` was minted **in this session** and exists in the vault.
2. The target is a text-entry control and is **not** a presence-only class.
3. **Type match** — the target's own evidence (autocomplete token, input type, label/name
   recognizer, `maxlength`, `pattern`) supports the ref's entity. AADHAAR requires an Aadhaar-lexicon
   label or a 12-digit numeric pattern; EMAIL requires `type=email`, `autocomplete=email` or an
   email label.
4. **Origin match** — the target frame's origin equals the origin where the value was seen, unless
   policy allows cross-origin with confirmation (OQ-8, default deny).
5. **Class rule** — CRITICAL requires confirmation (OQ-1 default); HIGH/MEDIUM allowed same-origin.
6. The field is visible, enabled and un-occluded (Phase 2's pre-flight).

Conditions 3 and 4 are the anti-exfiltration core. A compromised server never has the values, so
the only attack available to it is to get the *client* to place them somewhere the attacker can
read. Type matching stops an Aadhaar number going into a comment box; origin matching stops it going
to another site. Both are enforced on the client, which is the only party that can be trusted here.

Each failure returns a specific code — `REF_UNKNOWN`, `TYPE_MISMATCH`, `ORIGIN_MISMATCH`,
`CONFIRM_DECLINED`, `PRESENCE_ONLY` — which is sent back in the next step's `history` so the model
can re-plan rather than retry blindly.

### 6.3 Confirmation UX

Design.md §9.4: shown in the panel, with the target outlined on the page via a **closed shadow root**
(so the page cannot style, read or intercept it). Content: the verb, the target's name, the entity
type, and a partially masked local preview (last 4 characters — local display only, never
disclosure to the server). Buttons: *Allow once* / *Deny*. **No "always allow" in the first build.**
60-second timeout → deny.

---

## 7. The egress guard — the single choke point

Architecture §7.8, design.md §7.6. This is the mechanism that turns the privacy claim from an
architectural argument into something that fails closed.

### 7.1 The algorithm

Runs on the **final serialized bytes**, independently of the detectors that produced them:

```
guard(payload):
  bytes ← canonicalJSON(payload without image.data)
  1. validateSchema(payload)                          else BLOCK(SCHEMA)
  2. id-like fields match the opaque pattern          else BLOCK(ID_SHAPE)
  3. for v in vault.normalizedValues():
        if normalizedContains(bytes, v):              BLOCK(VAULT_LEAK, entity)
  4. for s in allStrings(payload):
        for rec in recognizers where class ≥ HIGH:
            if rec.match(s) and rec.validate(s):      BLOCK(PATTERN, entity)
  5. if payload.image: …                              # Phase 4
  6. debug/harness builds: canary strings             BLOCK(CANARY)   # Phase 5
  7. return brand(payload)                            # GuardedPayload
```

**Step 3 is the one that catches a detector bug.** Every value the vault knows about is searched for
in the outgoing bytes. If a value was detected somewhere (so it is in the vault) but a *different*
occurrence of it was missed by the substitution pass, step 3 finds it. `normalizedContains` compares
digit-only and whitespace-folded forms, so `1234 5678 9012` and `123456789012` both match.

**Step 4 is the one that catches a substitution bug.** The recognizers run *again*, over the final
payload, independently. A value that was never detected at all — so never entered the vault — is
caught here if any recognizer can see it.

### 7.2 Why "independent" is the load-bearing word

If the guard called the same detection code over the same inputs it would agree with itself
perfectly and catch nothing. Its value comes from running over **different inputs** (serialized
output bytes, not DOM nodes) at a **different time** (after substitution, not during).

Architecture §7.8 states the honest limit plainly: *the guard can only find what its recognizers and
detectors can find. A PII type none of them knows can pass.* That residual risk is measured by the
harness's independent auditor (Phase 5, T-5.7), which is re-implemented in Python rather than ported
from the TypeScript — because a ported implementation shares the original's blind spots.

### 7.3 Structural enforcement

Architecture §7.8: the egress client's `send()` accepts **only** objects produced by the guard — a
branded TypeScript type plus a runtime `WeakSet` membership check.

This replaces the earlier draft's same-heap HMAC "attestation", which architecture §1.3 C-8(e)
correctly dismisses: two modules in the same JavaScript heap signing messages to each other adds
complexity without a security boundary. A brand plus a `WeakSet` is honest about what it is — a
mechanism that makes the wrong call a *type error at compile time and a throw at runtime*, not a
cryptographic guarantee.

### 7.4 Fail-closed

On any block: the request is **not sent**, the ledger records `{step, rule, entity, count}` — counts,
never values — and the panel shows the block. The step stops. The user may retry (after
re-analysis) or stop.

There is no "send anyway" path. NFR-10 is unconditional: a crash, timeout, missing model or denied
permission must never result in unsanitized data being sent.

---

## 8. Task-text sanitization

FR-33 and architecture §7.10. The user's task string is sent to the server so the model knows the
goal, and the user may well type PII into it — *"pay my Airtel bill for 9876543210"*. It therefore
goes through the same Channel T analysis and placeholder substitution before sending.

Neither source document discusses this; it is a necessary technical consequence of FR-21's "before
any network request", and it is easy to forget because the task text does not come from the page.

---

## 9. The privacy ledger and the payload viewer

FR-34 and AC-9 make demonstrability a requirement, not a nicety: *the user (and judges) shall be
able to see exactly what was sent for each step, next to the real page.* [SS] calls the panel the
demo instrument.

**The ledger** (architecture §5.5, §12.1) is an in-memory, per-session record of every payload **as
sent**, plus timings, entity counts by class and channel, coverage, guard verdict and detector
versions. It is viewable in the panel and exportable for the harness — which is exactly what the
Phase 1 runner has been collecting empty.

It never uploads itself anywhere. Whether it should persist beyond the session is OQ-9 (default:
session-only, exportable).

**The payload viewer** shows the sanitized image (Phase 4) and the **exact bytes** with a raw-JSON
expander, side by side with the live page. The redaction summary shows counts by entity and channel
and the coverage triple.

Logs remain closed-vocabulary (design.md §15): numbers, enums and version strings only — never page
text, node names or values. The ledger, which does hold sanitized payload bytes, is separate from
logs.

---

## 9a. Implementation notes (real deviations found by testing, 2026-09-18)

This phase was built in full, including a real end-to-end test suite against a real fixture
(`test/fixtures/profile-aadhaar.html`, `test/e2e/privacy.spec.ts`), which is what caught the
following — none of these were found by inspection or by the unit-level checksum/pattern tests
alone:

1. **§6.2's Aadhaar invalid/no-context score (0.30) is a real bug, not just a coincidence.** It
   exactly equals `default.policy.json`'s CRITICAL accept threshold (also 0.30 — copied from
   design.md §7.2's table). A checksum-invalid, no-context 12-digit run — a plain tracking or order
   number — was therefore *fully accepted* as AADHAAR, not merely marked `unverified`, directly
   violating AC-11 and this very document's own hard-negative example. Fixed by scoring it 0.10
   instead (matching the card recognizer's invalid score), which is below even the fail-closed
   band floor. See `packages/recognizers/src/patterns/aadhaar.ts`'s comment and `DECISIONS.md`'s
   OQ-3 entry.
2. **§7.1's fusion algorithm as literally scoped (candidates from field values and free text runs)
   missed a real leak surface: `node.name` (the accessible name) and `page.title`.** Neither this
   document nor design.md §4.3 flagged these as needing sanitization, but they are ordinary strings
   in `SanitizedNode`/`SanitizedContext` that can carry raw page text — confirmed directly by a real
   fixture where an ancestor `<main>` element's accessible-name computation fell back to
   concatenating all descendant text, forwarding the raw Aadhaar number, email and phone number
   unredacted. `context/builder.ts` now runs every free-text source — text runs, node names, page
   title, and the task string — through the identical escape→detect→substitute path.
3. **§7.6's `normalizedContains` needs the digit-run search to be *bounded*, not "strip every
   non-digit character from the whole payload."** Applied naively across an entire serialized JSON
   payload, this merges unrelated numeric fields (box coordinates, `z`, `confidence`, `len`) from
   across the document into one digit stream, producing false `VAULT_LEAK` blocks on a genuinely
   clean payload. Fixed by searching maximal digit runs separated only by spaces/hyphens
   (`guard/normalize-contains.ts`), which is what the "1234 5678 9012" grouping example in §7.6
   actually implies once you have to implement it against a real multi-field JSON document rather
   than a single string.
4. **§8's "no serialization API" needs real `#`-private fields, not TypeScript's `private`
   keyword.** `private` is compile-time only; the vault's internal `Map`s and idle-timer handle
   were ordinary enumerable instance properties at runtime, and `JSON.stringify(vault)` threw
   outright (a live `Timeout` handle has circular internal references) rather than merely being
   bad practice. Converted to `#`-private fields, which are structurally invisible to any
   enumeration-based serialization.
5. A related, purely mechanical fix in the same file: a browser's `setTimeout`/`clearTimeout` are
   Web IDL methods that require `this === window`, so storing the bare global reference as a class
   field and calling it as `this.#setTimer(...)` throws `Illegal invocation` in a real browser
   (not in Node, which is why the Node-project unit tests passed while the first browser-project
   e2e run failed outright). Fixed by wrapping the defaults in arrow functions.
6. **§6.3's NER is not built as a real model this phase — a disclosed, not silent, gap.** No model
   weights are available in this sandboxed environment (the same category of gap as Phase 2's
   missing live vLLM). `perception/prefilter.ts` and `perception/models/pii-ner.ts` implement the
   real, tested pre-filter and call shape; `host/privacy/ner-stub.ts` (what `context/builder.ts`
   actually calls) always returns no findings. Channel D and Channel T are unaffected.
7. **§6.1's Channel D signals and the protected-value rule are computed content-side and carried to
   the host as `WireScreenNode.domSignal`**, rather than re-derived host-side from raw field
   values — the host never receives a protected field's value at all (T-3.9), so there is nothing
   for it to re-derive from. This wasn't explicit in this document's file list but follows directly
   from architecture §15.2's context boundary.
8. **§9.3 condition 4 (origin match) supports only the default (`crossOriginRehydration: "deny"`,
   strict equality)** — `"confirm"`/`"allow"` are not wired into `Vault.resolveFor`. Not built,
   since the shipped default doesn't need it; flagged in `DECISIONS.md`'s OQ-8 entry and the
   vault's own doc comment so it isn't rediscovered as a silent gap later.
9. **§9.4's on-page closed-shadow-root confirmation outline was not built.** The panel-side
   `ConfirmAction` card (verb, target, masked preview, Allow once/Deny, 60s timeout) is built and
   tested; highlighting the target element on the actual page is not.

---

## 10. Tasks & Acceptance Criteria

## done tasks

All 38 tasks (T-3.1…T-3.38) built and tested as of 2026-09-18, on explicit user instruction to
proceed despite Phase 2's live-model exit gate (OQ-13) still being unconfirmed in this GPU-less
environment (see [phase_2_spine.md](phase_2_spine.md) §9 — that caveat is unchanged and carries
forward). §9a above records the real deviations testing found; a handful of items below are marked
**[A] partial** — built and tested, but not the full literal scope of the row — rather than folded
silently into a plain "done".

| # | Task | Acceptance Criteria | Status |
|---|---|---|---|
| 3.1 | Verhoeff, Luhn, GSTIN check-character implementations | Table-driven suites: Verhoeff over ≥50 valid and ≥50 invalid 12-digit strings; Luhn over published test vectors; GSTIN over ≥20 real-format valid and invalid examples | done |
| 3.2 | Pattern recognizers for every entity in design.md §6.2 | Each returns correct spans and base scores; each has ≥10 positive and ≥10 negative cases | done |
| 3.3 | Context boosts from label, name attribute and autocomplete | A bare `[A-Z][0-9]{7}` scores 0.30; the same string in a field labelled "Passport number" scores 0.85 | done |
| 3.4 | Normalisation: NFKC, Indic digits, zero-width, full-width | An Aadhaar number written in Devanagari digits is detected with the same score as its ASCII form; a zero-width-joiner-interrupted card number is detected | done |
| 3.5 | Hard-negative suite | Every hard negative from design.md §6.2 and every `entity: "NONE"` fixture label from Phase 1 is **not** detected **(AC-11)** | done |
| 3.6 | `default.policy.json` + schema + typed loader | Policy validates at load; an invalid policy fails loudly at startup, never silently defaults; `policy.version` appears in every payload | done |
| 3.7 | Policy engine | Thresholds, operators, entity→class, presence-only and allow-rules all read from data; changing a threshold in JSON changes behaviour with no code change | done |
| 3.8 | Channel D signal table | Every row of design.md §6.1 produces its documented entity and score on a fixture | done |
| 3.9 | **Protected-value rule** | On a page with a filled password, OTP, CVV and card field: no message, payload, log or vault entry contains any character of those values; `valueLen` is correct; **a source-level assertion that no `.value` string read is reachable for those classes** **(FR-23, AC-2)** | done |
| 3.10 | NER profile S in the worker | Names and addresses in prose detected; pre-filter rejects ≥80% of text before the model runs; results cached by normalized-text hash | **[A] partial** — pre-filter and call shape real and tested; no model weights available, `classify()` returns `[]` (§9a.6) |
| 3.11 | Fusion steps 1–4 | Uncertainty-band acceptance marks `unverified: true`; two channels on the same entity merge keeping DOM geometry; different entities keep the highest class | done |
| 3.12 | Rectangle decomposition + clamped dilation | ≤4 rects per region; a dilated box never enters a non-sensitive sibling's box by >1 px, asserted on a dense form fixture | done (dormant — no image caller this phase) |
| 3.13 | Token expansion + OCR line fallback | A span covering half a token expands to the whole token; the OCR branch is present but inert until Phase 4 | done |
| 3.14 | Placeholder minting | Same value → same ref within a session; different values never collide; a new session renumbers from 1 **(FR-27)** | done |
| 3.15 | Text substitution | Overlapping spans resolve to the highest class; adjacent same-entity refs separated only by spacing collapse into one | done |
| 3.16 | `⟪`/`⟫` escaping | A page rendering the literal text `⟪AADHAAR#2⟫` produces `‹‹AADHAAR#2››` in the payload, and the client refuses to resolve a ref it did not mint | done |
| 3.17 | Vault module with exactly design.md §8's surface | No `toJSON`/`entries`/`values`/`Symbol.iterator` exported — asserted by a lint rule **and** a runtime reflection test | done (needed real `#`-private fields, §9a.4) |
| 3.18 | Vault lifetime | Cleared on task end, cancel, panel `pagehide` and 10-min idle; after clear, `has()` is false for every prior ref | done |
| 3.19 | Vault import boundary | Lint proves no module outside `privacy/` and `actions/` imports the vault; `normalizedValues` importable only by the guard | done, with `session.ts` as a disclosed exception (owns the vault's lifecycle, never reads a value) |
| 3.20 | Sanitized context builder | Emits `redactions[]`, placeholder `value` kinds, coverage triple and history window; validates against the Phase-1 schema | done |
| 3.21 | Task-text sanitization | A task containing a phone number is sent with a placeholder, not the number **(FR-33)** | done |
| 3.22 | Guard steps 1–2 | A payload with a malformed id shape is blocked with `GUARD_BLOCK_ID_SHAPE` | done |
| 3.23 | Guard step 3 — vault-leak sweep | With a deliberately sabotaged substitution pass, the raw value in the bytes is found and the request is blocked; digit-grouped and ungrouped forms both match **(AC-6)** | done |
| 3.24 | Guard step 4 — independent pattern sweep | A value never detected by any channel (planted post-substitution) is caught by the re-scan and blocked | done |
| 3.25 | `GuardedPayload` brand + `WeakSet` | `send()` rejects an unbranded object at compile time and throws on a forged one at runtime | done |
| 3.26 | **Delete `guard-stub.ts`** | File gone; the Phase-2 CI tripwire now fails the build if it ever returns; the red no-redaction banner is removed | done |
| 3.27 | Privacy ledger | Per step: bytes as sent, counts by entity and channel, coverage, guard verdict, per-stage timings, detector and policy versions; exportable; never uploaded | done |
| 3.28 | `resolveFor` with all six conditions | Each condition has a test that isolates it; each failure returns its documented code **(AC-5)** | done |
| 3.29 | Rejection codes in history | A `TYPE_MISMATCH` rejection appears in the next step's `history` so the model can re-plan | done |
| 3.30 | Risk classification + raise-only `risk_hint` | A server `risk_hint: "low"` on a submit action still requires confirmation | done |
| 3.31 | Confirmation card + on-page outline | Outline is injected in a **closed** shadow root; 60 s with no answer denies; *Deny* sends `CONFIRM_DECLINED` | **[A] partial** — panel card done (60s/Deny/`CONFIRM_DECLINED`); on-page outline not built (§9a.9) |
| 3.32 | Payload viewer | Shows the exact bytes for every step with a raw-JSON expander, side by side with the live page **(FR-34, AC-9)** | **[A] partial** — exact-bytes expander done; no image (Phase 4) and no side-by-side layout |
| 3.33 | Redaction counts and coverage display | Counts by entity and channel, plus the coverage triple, for every step | done |
| 3.34 | Guard-block card | Rule, entity and count shown; *Retry* re-analyses; *Stop* ends the task | done |
| 3.35 | **AC-2 end to end** | For the demo task, every captured outbound payload contains no Aadhaar number and no password character; an independent scan of all payloads reports **0 leaks** | done — `test/e2e/privacy.spec.ts` |
| 3.36 | **AC-6 end to end** | Forcing a detector miss on a fixture causes the guard to block; **nothing is sent** | done — both `VAULT_LEAK` and `PATTERN` paths |
| 3.37 | **AC-11 end to end** | No checksum-invalid look-alike in the hard-negative fixtures is redacted as Aadhaar or a card | done — this is exactly the test that caught §9a.1's boundary bug |
| 3.38 | Zero-egress completion | `type(n, ⟪AADHAAR#2⟫)` resolves locally after confirmation and types the real value; both the request and the next observation show only the placeholder | done |

## not done yet

Nothing from this phase's own task list. What remains is what §9a and §16 already declare as
forward dependencies to later phases: a real NER model, the on-page confirmation outline,
`crossOriginRehydration`'s `"confirm"`/`"allow"` values, and everything Channel V/vision-related.

---

## 11. Open questions that gate this phase

| OQ | Question | Default | What changes if the answer differs |
|---|---|---|---|
| **OQ-1** | May the agent type CRITICAL values, and under what control? | Per-action confirmation, same origin, type-matched | If "never automatic", `classes.CRITICAL.rehydrate` becomes `"deny"` and T-3.38's demo becomes a user-typed step. **This is the killer feature; it needs an explicit decision, not a default** |
| **OQ-3** | Final entity→class mapping and thresholds | Design.md §3.3's table | Changes `entityClass` and `classes[].threshold` in policy JSON only — no code change, by construction |
| **OQ-6** | May placeholders reveal partial values (last 4 card digits)? | No | If yes, `partialDisclosure` gains entries and the placeholder gains a metadata field; the guard must then *not* treat those digits as a leak |
| **OQ-8** | May a value seen on one origin be typed on another? | Deny | If "confirm", condition 4 of §6.2 becomes a confirmation rather than a rejection. This is the main exfiltration path — change it carefully |
| **OQ-10** | Which actions need confirmation? | Design.md §9.2's list | Changes `riskRules.confirm` in policy JSON only |
| **OQ-14** | May `type` carry literal task text? | Yes, after sanitization | If no, delete the `text` branch from the action schema (Phase 1 wrote it to make this a one-hunk change) |

---

## 12. Milestone Definition

Phase 3 is **complete** when:

> A developer opens the panel on a fixture page that shows a citizen's profile: a photo, the line
> *"Aadhaar on record: 2345 6789 0123"*, an email, a phone number, and a login form whose password
> field already holds nine characters. They type *"log in and submit the form"* and press run.
>
> The panel splits. Left: the live page. Right: **what the server saw**. The right-hand pane reads
> `"Aadhaar on record: ⟪AADHAAR#2⟫"`, `"Signed in as ⟪EMAIL#1⟫"`, and for the password field,
> `{"kind":"presence","entity":"PASSWORD","len":9}`. Below: *Redactions: AADHAAR 1 · EMAIL 1 ·
> PHONE 1 · PASSWORD 1 (presence)*. They expand the raw JSON and read the actual transmitted bytes.
> The digits `2345 6789 0123` are not there, in any grouping. Neither is any character of the
> password — and when they search the extension's entire message log for it, it was never read in
> the first place.
>
> The model returns a plan. The panel shows *→ type ⟪AADHAAR#2⟫ into "Aadhaar number"* and a
> confirmation card: **Type your Aadhaar (•••• •••• 0123) into 'Aadhaar number'?** On the page, the
> target field is outlined. They press **Allow once**. The real number appears in the field. The
> next observation goes out — and it still says `⟪AADHAAR#2⟫`. The server has now helped complete a
> task that required the Aadhaar number, in both directions, without ever receiving it.
>
> Then they break it on purpose. They comment out the Verhoeff check so the Aadhaar recognizer
> misses, and re-run. The payload viewer never fills: a red card reads **Blocked — VAULT_LEAK,
> entity AADHAAR, count 1**. Nothing was sent. They restore it, and instead plant the raw number in
> a part of the page the substitution pass does not walk. Again blocked, this time **PATTERN,
> entity AADHAAR** — the guard's independent re-scan found what the detectors did not.
>
> Finally they load the hard-negative fixtures: a parcel tracking number of exactly twelve digits,
> an order number of exactly sixteen, a product code shaped like a PAN. The payload viewer shows
> all three passing through **unredacted**, because none of them satisfies Verhoeff, Luhn or the
> PAN holder-type rule. *Redactions: 0.* The page is still fully readable to the model.
>
> The differentiator exists, it fails closed when broken, and it does not over-redact when it
> should not.

---

## 13. Files to Create

```
packages/recognizers/src/
├── checksums/{verhoeff,luhn,gstin}.ts          # [new]
├── patterns/{aadhaar,pan,gstin,ifsc,upi,card,phone,email,passport,vehicle,pin,dob,secret}.ts  # [new]
├── context/{lexicons,boost}.ts                 # [new]
├── normalize.ts                                # [new] NFKC, Indic digits, ZW, full-width
├── registry.ts                                 # [new]
└── index.ts                                    # [modify]

packages/policy/
├── policies/default.policy.json                # [new]
├── policy.schema.json                          # [new]
└── src/{loader,accessors,types}.ts             # [new]

apps/extension/src/
├── content/detect/{channel-d,protected,spans}.ts        # [new]
├── content/screen-graph/extractor.ts                    # [modify] protected-value rule
├── perception/models/pii-ner.ts                         # [new] profile S
├── perception/prefilter.ts                              # [new]
├── host/privacy/
│   ├── fusion/{merge,arbitrate,decompose,dilate}.ts     # [new]
│   ├── placeholders/{mint,substitute,escape}.ts         # [new]
│   ├── vault/index.ts                                   # [new] no serialization API
│   ├── context/builder.ts                               # [modify] redactions + placeholders
│   └── guard/{guard,sweeps,normalize-contains}.ts       # [new]
├── host/egress/guard-stub.ts                            # [DELETE]
├── host/actions/{rehydrate,risk}.ts                     # [new]
├── host/ledger/{ledger,export}.ts                       # [new]
└── ui/{PayloadViewer,RedactionSummary,ConfirmAction,GuardBlockCard}.tsx   # [new]

apps/extension/test/
├── unit/{verhoeff,luhn,gstin,patterns,normalize,fusion,dilation,mint,vault,guard,rehydrate}.spec.ts
├── fixtures/{profile-aadhaar,kyc-form,hard-negatives,indic-digits,forged-placeholder}.html
└── e2e/{privacy,ac2,ac6,ac11,zero-egress}.spec.ts
```

---

## 14. Performance Validation

| Metric | How to Measure | Target |
|---|---|---|
| Text analysis, cached | Ledger `client_timing.fuse` | ≤ 10 ms p95 (design.md §10.2) |
| Guard, L0 | Ledger `client_timing.guard` | ≤ 5 ms p95 — it runs on every step and is in the critical path |
| Vault-leak sweep | Bench with 50 vault entries over a 200 KB payload | Sub-millisecond; it is a normalized substring search, not a regex sweep |
| Pattern re-sweep | Bench over the same payload | ≤ 3 ms — HIGH/CRITICAL recognizers only, not the full registry |
| NER profile S, per step | Worker timings | Within the 120 ms frame deadline including pre-filter; report the pre-filter's rejection rate |
| Recognizer registry, cold | Vitest bench | Regexes compiled once at module load (design.md §19), not per call |
| Payload size delta vs Phase 2 | Compare captured payloads | Placeholders are *shorter* than the values they replace; `redactions[]` adds bytes. Record the net |

---

## 15. Estimated Complexity

| Component | New LOC | Files |
|---|---|---|
| Checksums (Verhoeff, Luhn, GSTIN) | ~220 | 3 |
| Pattern recognizers | ~640 | 13 |
| Context lexicons + boost | ~180 | 2 |
| Normalisation | ~140 | 1 |
| Registry | ~110 | 1 |
| Policy JSON + schema + loader | ~330 | 5 |
| Channel D + protected-value restructure | ~290 | 3 |
| NER profile S + pre-filter | ~260 | 2 |
| Fusion (merge, arbitrate, decompose, dilate) | ~520 | 4 |
| Placeholders (mint, substitute, escape) | ~230 | 3 |
| Vault | ~180 | 1 |
| Context builder rewrite | ~240 | 1 |
| Egress guard + sweeps | ~380 | 3 |
| Rehydration + risk | ~310 | 2 |
| Ledger + export | ~220 | 2 |
| Panel: viewer, summary, confirm, block card | ~560 | 4 |
| Unit suites | ~1,450 | 11 |
| Fixtures + e2e | ~780 | 10 |
| **Total** | **~7,040** | **71** |

New runtime dependencies: **1** — the NER profile-S model (bundled, sha256-verified through the
Phase-0 manifest mechanism). No new libraries; the recognizers are hand-written by necessity, since
Indian identifier checksums are not in any general-purpose library.

---

## 16. Forward Dependencies Declared Here

- **Guard step 5 (image re-scan) is a no-op** — there is no image. **[Phase 4, T-4.18: face
  detection over the composed image plus OCR in 24 px halos around every redaction box, one
  recompose with +50% dilation, then drop the image and fall back to L0.]**
- **Guard step 6 (canary check) is not implemented.** **[Phase 5, T-5.8 wires it into debug and
  harness builds and makes any canary escape a hard CI failure.]**
- **Fusion step 3 (cross-channel agreement) and step 8 (OCR line fallback) have no OCR input.**
  **[Phase 4 supplies Channel V and OCR boxes; the code paths exist and are exercised by synthetic
  candidates until then.]**
- **`coverage` is `{cleared: 1, redacted: n, unanalysed: 0}`** because everything is structural.
  **[Phase 4's additive compositor computes the real triple, and `unanalysed` becomes meaningful —
  it is the fraction of the screen that was withheld because it could not be cleared in time.]**
- **Entity types FACE, ID_DOCUMENT, SIGNATURE, QR_CODE are in the enum and never produced.**
  **[Phase 4's Channel V produces them; they are presence-only in images and carry no `ref`.]**
- **NER profile L is not built.** **[Phase 6, gated on OQ-7 and on Phase 5's measurement of whether
  profile S's free-text recall meets NFR-2's ≥0.95.]**
- **The ledger is session-only.** **[OQ-9. If the answer becomes "persist", it needs a storage
  design that does not itself become a record of which sensitive screens the user visited.]**
- **`unverified: true` regions are marked and treated identically to verified ones.** **[Phase 5
  measures whether the uncertainty band is costing more in metric 3 than it gains in metric 2, and
  the band width becomes a tunable swept by the harness.]**
- **Per-entity redaction policy is not exposed in the UI.** **[Phase 6's F-H09/T-6.11, FR-35.]**
- **Session un-redact (FR-36, P3) is not built.** **[Phase 6, T-6.12. It is the only de-escalation
  path besides a versioned allow-rule, so it must be auditable in the ledger when it lands.]**
