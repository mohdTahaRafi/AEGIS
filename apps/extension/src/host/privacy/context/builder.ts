// design.md §4.3 (packages/protocol's SanitizedContext) / phase_3_privacy_core.md §5 — the real
// privacy-preserving builder. Runs Channel D (already computed content-side, carried as
// `node.domSignal`) and Channel T (this file, via @aegis/recognizers) over every field value, free
// text run and the task string, fuses the results, mints typed placeholders through the vault, and
// substitutes them before anything is serialized. Nothing here ever forwards a raw sensitive value
// into the returned `SanitizedContext` — every string that could carry one goes through
// `escapePlaceholderDelimiters` → detection → `mintForRegion`/substitution first.
//
// `unexplained[]` (T-6.5/T-6.6) reports every vision-only node (canvas/img/video) regardless of
// whether vision found anything there — `computeUnexplained` below. `coverage.unanalysed` stays
// 0 (phase_3_privacy_core.md §16's forward dependency): it's still an approximation from
// nodes/runs that produced a redaction, not the real compositor's pixel-area measurement.
// [A] NER (design.md §6.3) is not a real pretrained model in this environment — see
// `perception/models/pii-ner.ts`'s doc comment for why, and `docs/CURRENT_BUILD.md` for the
// disclosed gap. Channel T (deterministic recognizers) is real and is what this builder relies on
// for the milestone demo's Aadhaar/email detections.

import type { SanitizedContext } from '@aegis/protocol';
import type { RecognizerContext } from '@aegis/recognizers';
import { findAll } from '@aegis/recognizers';
import type { Policy } from '@aegis/policy';
import { isPresenceOnly } from '@aegis/policy';
import type { AblationArm } from '../../../shared/ablation';
import type { WireScreenNode, WireTextRun } from '../../../shared/messages';
import { fuse } from '../fusion';
import { runNerStub } from '../ner-stub';
import { escapePlaceholderDelimiters } from '../placeholders/escape';
import { mintForRegion } from '../placeholders/mint';
import { substitute, type SpanReplacement } from '../placeholders/substitute';
import type { Candidate, SensitiveRegion } from '../types';
import type { Vault } from '../vault';

type SanitizedNode = SanitizedContext['nodes'][number];
type NodeValue = NonNullable<SanitizedNode['value']>;
type HistoryEntry = NonNullable<SanitizedContext['history']>[number];
type RedactionEntry = SanitizedContext['redactions'][number];

const MAX_HISTORY_ENTRIES = 5;

export interface BuildContextInput {
  stepId: string;
  task: string;
  reason: SanitizedContext['reason'];
  deltaOf?: string | null;
  viewport: { w: number; h: number; dpr: number; scrollY: number; docH: number };
  pageCategory: SanitizedContext['page']['category'];
  pageTitle: string;
  nodes: WireScreenNode[];
  removed: string[];
  textRuns: WireTextRun[];
  history: HistoryEntry[];
  clientTiming: Record<string, number>;
  vault: Vault;
  policy: Policy;
  /** Internal origin identifier — never sent (design.md §3.4). Used only for vault mint/rehydrate
   * origin-matching. */
  originKey: string;
  /** Phase 4: Channel V candidates (faces, etc.) already detected by a prior `perceive` call this
   * step, in the same viewport-pixel coordinate space as `nodes[].box`. Merged into fusion
   * alongside Channel D/T exactly like any other candidate — fusion has no notion of "vision
   * candidates are special," only `channel: 'vision'`/`'text-ocr'`. Absent (not `[]`) is the
   * normal case for a step that never captured a frame at all — kept optional so every Phase 3
   * caller/test is unaffected. */
  visionCandidates?: Candidate[];
  /** T-6.5/T-6.6: node ids whose vision analysis actually completed this step (not `timedOut`),
   * from the same `perceive` call `visionCandidates` came from — used only to set
   * `unexplained[].status`. Absent (not an empty set) means no capture happened this step at all,
   * same "vision never ran" case `visionCandidates`'s own doc comment describes. */
  visionAnalyzedNodeIds?: ReadonlySet<string>;
  /** T-6.9 (design.md §18.3): absent (the release default) behaves exactly like `'fused'`.
   * `'pixel_only'` skips Channel D/T over DOM-sourced nodes/text runs (relying entirely on the
   * OCR-derived `visionCandidates` this step's `runPerceptionStep` call already produced for the
   * whole viewport). `'blackbox'` forces every region's replacement to the bare, unresolvable
   * `⟪ENTITY⟫` form — never a real vault ref — regardless of policy. `'dom_only'` needs no
   * handling here at all: it works by `visionCandidates` simply never being passed in. */
  ablation?: AblationArm;
  /** T-6.12 (FR-36, design.md §7.1 step 9): the session's own user-un-redacted refs — the ONLY
   * de-escalation path besides a versioned policy allow-rule. A ref only ever lands here after
   * `Session.unredact()` has already minted it once and recorded the action in the ledger; this
   * function trusts that gate rather than re-deriving it, since it has no ledger/audit access of
   * its own. Absent (not an empty set) behaves exactly as before this feature existed. */
  unredactedRefs?: ReadonlySet<string>;
}

function fieldContext(node: WireScreenNode): RecognizerContext {
  return { label: node.name, name: node.id, autocomplete: node.field?.autocomplete };
}

/** Channel T over a node's own (already-escaped) value, tagged with `nodeId` so fusion's
 * node-level grouping (merge.ts) combines it with the same node's Channel D signal. */
function candidatesFromNodeValue(node: WireScreenNode, value: string): Candidate[] {
  const matches = findAll(value, fieldContext(node));
  return matches.map((m) => ({
    entity: m.entity,
    box: node.box,
    score: m.score,
    channel: 'text-dom' as const,
    source: m.source,
    nodeId: node.id,
    value,
  }));
}

function candidateFromDomSignal(node: WireScreenNode, value: string | undefined): Candidate | null {
  if (!node.domSignal) return null;
  return {
    entity: node.domSignal.entity,
    box: node.box,
    score: node.domSignal.score,
    channel: 'dom',
    source: `dom:${node.domSignal.entity.toLowerCase()}`,
    nodeId: node.id,
    value,
    presenceOnly: !node.domSignal.valueRead,
  };
}

/** Channel T (+ the NER stub) over a free-text run, tagged with `textRunId` + `span` so fusion's
 * span-overlap grouping (merge.ts) merges overlapping matches from different recognizers. */
function candidatesFromTextRun(runId: string, box: [number, number, number, number], text: string): Candidate[] {
  const patternMatches = findAll(text);
  const nerMatches = runNerStub(text);
  return [...patternMatches, ...nerMatches].map((m) => ({
    entity: m.entity,
    box,
    score: m.score,
    channel: (m.source.startsWith('ner:') ? 'ner' : 'text-dom') as Candidate['channel'],
    source: m.source,
    textRunId: runId,
    span: [m.start, m.end],
    value: m.matchedText,
  }));
}

function regionKey(region: SensitiveRegion): string {
  return region.nodeId ? `node:${region.nodeId}` : `run:${region.textRunId}:${region.span?.[0]}`;
}

function toNodeValue(
  node: WireScreenNode,
  region: SensitiveRegion | undefined,
  vault: Vault,
  policy: Policy,
  originKey: string,
  stepId: string,
  ablation?: AblationArm,
  unredactedRefs?: ReadonlySet<string>,
): NodeValue | undefined {
  if (!node.field) return undefined;

  // T-6.7: a volatile field's value is replaced unconditionally, ahead of any region — no
  // candidates were even generated for it (see the escaping step above), so `region` is always
  // undefined here anyway, but this stays the explicit first check rather than relying on that.
  if (node.state.volatile) return { kind: 'text', text: '⟪LIVE⟫' };

  if (region) {
    // T-6.9: black-box "sends no refs" — the same `presence`-shaped value (no `ref` field at
    // all) every genuinely non-resolvable entity already uses, just forced unconditionally
    // instead of only for PASSWORD/OTP/etc. Never calls `mintForRegion`/`vault.mint` at all.
    if (ablation === 'blackbox') {
      return { kind: 'presence', entity: region.entity, len: region.value?.length ?? node.state.valueLen };
    }
    const minted = mintForRegion(vault, policy, region, originKey, stepId, unredactedRefs);
    if (minted) {
      // Presence-only regions never had a value to measure (T-3.9) — report the field's own
      // observed length (from `computeState`'s `.value.length` read, never the string) instead.
      if (minted.kind === 'presence' && minted.len === 0) {
        return { ...minted, len: node.state.valueLen };
      }
      // T-6.12: an un-redacted region's raw text still needs the same delimiter-escaping every
      // other plain-text path applies (line below, `node.field.value`'s own branch) — `mint.ts`
      // hands back the raw `region.value` unescaped, since it has no reason to know this rule.
      if (minted.kind === 'text') {
        return { kind: 'text', text: escapePlaceholderDelimiters(minted.text) };
      }
      return minted as NodeValue;
    }
  }

  if (node.field.valueRead && node.field.value !== undefined) {
    return { kind: 'text', text: escapePlaceholderDelimiters(node.field.value) };
  }

  // Protected field with no formed region (shouldn't happen — Channel D scores these at 1.0,
  // always above the CRITICAL band floor — but stay honest rather than silently emitting a value
  // that was never read).
  if (!node.field.valueRead && node.domSignal) {
    return { kind: 'presence', entity: node.domSignal.entity, len: node.state.valueLen };
  }

  return { kind: 'empty' };
}

/** Builds the `entity → replacement string` for one text run's matched spans. Presence-only
 * entities (a card number typed in plain prose, say) never get a ref — design.md §7.3's "or with
 * '⟪ENTITY⟫' for non-resolvable items" branch. T-6.9's black-box arm forces every region down
 * this same bare-label path unconditionally — "send no refs," regardless of policy or whether a
 * real value exists to mint — never touching the vault at all in that arm. */
interface Replacement {
  text: string;
  /** T-6.12: true when this region's ref was previously un-redacted for this session — `text` is
   * the raw value, not a ref, and the caller must not add a `redactions[]` legend entry for it
   * (the whole point of un-redacting is that the server no longer sees this as redacted at all). */
  unredacted: boolean;
}

function replacementFor(
  region: SensitiveRegion,
  vault: Vault,
  policy: Policy,
  originKey: string,
  stepId: string,
  ablation?: AblationArm,
  unredactedRefs?: ReadonlySet<string>,
): Replacement {
  if (ablation === 'blackbox' || region.presenceOnly || isPresenceOnly(policy, region.entity) || region.value === undefined) {
    return { text: `⟪${region.entity}⟫`, unredacted: false };
  }
  const ref = vault.mint(region.entity, region.value, { originKey, stepId, class: region.class });
  if (unredactedRefs?.has(ref)) return { text: region.value, unredacted: true };
  return { text: ref, unredacted: false };
}

function toRedactionEntry(region: SensitiveRegion, ref: string | null): RedactionEntry {
  const base = {
    ref: ref as RedactionEntry['ref'],
    entity: region.entity,
    class: region.class,
    boxes: region.boxes as RedactionEntry['boxes'],
    method: 'placeholder' as const,
    confidence: region.score,
    sources: region.sources,
    unverified: region.unverified,
  };
  if (region.value !== undefined) {
    return { ...base, len: region.value.length } as RedactionEntry;
  }
  return base as RedactionEntry;
}

function windowHistory(history: HistoryEntry[]): SanitizedContext['history'] {
  const windowed = history.slice(-MAX_HISTORY_ENTRIES);
  return windowed as SanitizedContext['history'];
}

/** Every free-text string that isn't a field's own value (which uses node-level Channel D+T
 * merging instead) goes through this exact same path: escape → detect → (after the global fuse)
 * substitute. `node.name` (the accessible name) is included here — a real gap this builder had
 * until an e2e test against a real fixture caught it: an ancestor landmark's computed accessible
 * name can fall back to concatenating descendant text content, which silently forwarded raw page
 * text (including the Aadhaar line, the email, the phone number) completely unsanitized. Page
 * title is included for the same reason (design.md §4.3's schema comment: "Sanitized page title").
 */
interface FreeTextSource {
  key: string;
  box: [number, number, number, number];
  text: string;
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

type UnexplainedReason = SanitizedContext['unexplained'][number]['reason'];

/** `computeRole` (content/screen-graph/roles.ts) overloads `role: 'img'` for CANVAS/VIDEO as well
 * as real IMG (T-4.x's vision routing) — this is the one place that overload gets unpacked back
 * into the schema's real reason enum, using the tag name carried alongside it (T-6.5/T-6.6).
 * `'other'` covers a synthetic/test node with no `tagName` and any future implicit-role addition
 * this switch doesn't yet know about — never a thrown error over an unrecognised element kind. */
function unexplainedReason(tagName: string | undefined): UnexplainedReason {
  switch (tagName) {
    case 'CANVAS':
      return 'canvas';
    case 'VIDEO':
      return 'video';
    case 'IMG':
      return 'img';
    default:
      return 'other';
  }
}

/** FR-12 (design.md §4.3's `unexplained[]`): every node whose content is opaque to the DOM
 * (`role === 'img'`, the same predicate `structural-coverage.ts`/`run-step.ts` use) is reported
 * here regardless of whether vision found anything in it — `status` is what tells the server
 * whether that box is actually pixels-it-can-trust (`'analysed'`) or still just grey
 * (`'grey'`, either because this step never captured a frame, or because this node's own crop
 * timed out — `visionAnalyzedNodeIds` already excludes timed-out nodes, see `run-step.ts`). */
function computeUnexplained(nodes: readonly { id: string; role: string; box: [number, number, number, number]; tagName?: string }[], visionAnalyzedNodeIds: ReadonlySet<string> | undefined): SanitizedContext['unexplained'] {
  return nodes
    .filter((n) => n.role === 'img')
    .map((n) => ({
      box: n.box,
      reason: unexplainedReason(n.tagName),
      status: visionAnalyzedNodeIds?.has(n.id) ? ('analysed' as const) : ('grey' as const),
    }));
}

export function buildSanitizedContext(input: BuildContextInput): SanitizedContext {
  const { vault, policy, originKey, stepId } = input;

  // 1. Escape forged placeholder delimiters BEFORE anything is scanned or substituted (T-3.16).
  // T-6.7 (design.md §5.5): a volatile node's text is replaced by the literal `⟪LIVE⟫` instead —
  // deliberately NOT escaped (escaping is for page-controlled text that might forge a delimiter;
  // this string IS one, on purpose, the same bare-`⟪ENTITY⟫` shape presence-only entities already
  // use) — and skips Channel D/T entirely below: a value that might be different by the time it's
  // read is not worth detecting or minting a vault entry for.
  const LIVE_TEXT = '⟪LIVE⟫';
  const escapedTask = escapePlaceholderDelimiters(input.task);
  const escapedTitle = escapePlaceholderDelimiters(input.pageTitle);
  const escapedNodes = input.nodes.map((n) => ({
    ...n,
    name: n.state.volatile ? LIVE_TEXT : escapePlaceholderDelimiters(n.name),
    field: n.field?.value !== undefined ? { ...n.field, value: escapePlaceholderDelimiters(n.field.value) } : n.field,
  }));
  const escapedRuns = input.textRuns.map((r) => ({ ...r, text: r.volatile ? LIVE_TEXT : escapePlaceholderDelimiters(r.text) }));

  // T-6.9 (design.md §18.3): the pixel-only ablation arm "ignores Channel D and DOM text" —
  // every node/free-text-run candidate loop below is skipped for it (task/title still scan
  // normally — they aren't DOM content, they're the user's own instruction and the page's title
  // metadata). Skipping candidate generation, not the text itself, is deliberate: `sanitizeFreeText`
  // still runs over every node name/text run below exactly as it always does, it just never finds
  // a matching region to substitute, so the raw (escaped) DOM text ships through unredacted —
  // this arm's whole point is to measure what relying on the OCR/pixel channel alone looks like.
  const pixelOnly = input.ablation === 'pixel_only';

  // 2. Collect candidates: Channel D (already computed content-side) + Channel T over field
  // values and every free-text source. Volatile nodes are skipped entirely (see above).
  const candidates: Candidate[] = [];
  if (!pixelOnly) {
    for (const node of escapedNodes) {
      if (node.state.volatile) continue;
      const domCandidate = candidateFromDomSignal(node, node.field?.value);
      if (domCandidate) candidates.push(domCandidate);
      if (node.field?.valueRead && node.field.value) {
        candidates.push(...candidatesFromNodeValue(node, node.field.value));
      }
    }
  }

  // A leaf node's accessible name frequently duplicates a text run already extracted at the same
  // box (e.g. a plain `<div>` whose only content is one text node) — detecting the identical
  // string via both sources produced two independent, never-merged SensitiveRegions for the same
  // real-world value (found via this project's Phase 5 genuine end-to-end harness run against the
  // real corpus, not by inspection — every fixture with a canary or an Aadhaar-labelled field
  // showed a doubled redaction count). `sanitizeFreeText`'s original purpose — an ANCESTOR
  // landmark's name-computation fallback concatenating DESCENDANT text beyond any single run — is
  // untouched by this: only an EXACT (box, text) duplicate of an already-included run is skipped.
  const runBoxTextKeys = new Set(escapedRuns.map((r) => `${r.box.join(',')} ${r.text}`));
  const dedupedNodeNames = escapedNodes.filter((n) => !runBoxTextKeys.has(`${n.box.join(',')} ${n.name}`));

  const freeTextSources: FreeTextSource[] = [
    ...escapedRuns.map((r) => ({ key: `run:${r.id}`, box: r.box, text: r.text })),
    ...dedupedNodeNames.map((n) => ({ key: `name:${n.id}`, box: n.box, text: n.name })),
    { key: 'task', box: [0, 0, 0, 0] as [number, number, number, number], text: escapedTask },
    { key: 'title', box: [0, 0, 0, 0] as [number, number, number, number], text: escapedTitle },
  ];
  for (const source of freeTextSources) {
    if (pixelOnly && source.key !== 'task' && source.key !== 'title') continue;
    candidates.push(...candidatesFromTextRun(source.key, source.box, source.text));
  }
  if (input.visionCandidates) candidates.push(...input.visionCandidates);

  // 3. Fuse.
  const regions = fuse(policy, candidates);
  const regionsByKey = new Map(regions.map((r) => [regionKey(r), r]));

  // 4. Mint + substitute.
  const redactions: RedactionEntry[] = [];

  // T-6.9: pixel-only's full-frame OCR candidates (`run-step.ts`'s synthetic
  // `ocr-full-frame:<box>` textRunId) have neither a real node nor a real free-text run behind
  // them — there is no DOM structure backing them by design, so neither the node loop below nor
  // `sanitizeFreeText` (which only ever runs against a REAL `freeTextSources` entry) will ever
  // reach them. This is their own, third and only path to `redactions[]`.
  for (const region of regions) {
    if (!region.textRunId?.startsWith('ocr-full-frame:')) continue;
    const replacement = replacementFor(region, vault, policy, originKey, stepId, input.ablation, input.unredactedRefs);
    if (!replacement.unredacted) {
      const ref = replacement.text.startsWith('⟪') && /#\d+⟫$/.test(replacement.text) ? replacement.text : null;
      redactions.push(toRedactionEntry(region, ref));
    }
  }

  function sanitizeFreeText(key: string, text: string): string {
    const regionsForKey = regions.filter((r) => r.textRunId === key);
    const replacements: SpanReplacement[] = regionsForKey
      .filter((r): r is SensitiveRegion & { span: [number, number] } => r.span !== undefined)
      .map((r) => {
        const replacement = replacementFor(r, vault, policy, originKey, stepId, input.ablation, input.unredactedRefs);
        if (!replacement.unredacted) {
          const ref = replacement.text.startsWith('⟪') && /#\d+⟫$/.test(replacement.text) ? replacement.text : null;
          redactions.push(toRedactionEntry(r, ref));
        }
        return { span: r.span, entity: r.entity, replacement: replacement.text };
      });
    return substitute(text, replacements);
  }

  // Computed BEFORE `nodes` so a deduped node's name (see `dedupedNodeNames` above) can reuse the
  // matching run's already-substituted text instead of calling `sanitizeFreeText` a second time
  // with no candidates behind it — which would ship that node's name completely unsanitized.
  const runSubstitutionByBoxText = new Map(
    escapedRuns.map((r) => [`${r.box.join(',')} ${r.text}`, sanitizeFreeText(`run:${r.id}`, r.text)]),
  );

  const nodes: SanitizedNode[] = escapedNodes.map((node) => {
    const region = regionsByKey.get(`node:${node.id}`);
    const value = toNodeValue(node, region, vault, policy, originKey, stepId, input.ablation, input.unredactedRefs);
    if (region) {
      // `toNodeValue` only mints through a `field` (a form field's own value) — a vision-only
      // node (canvas/img/video, T-6.5/T-6.6) has no field, so its region would otherwise be
      // recorded with `ref: null` and the compositor would draw an unlabelled box instead of the
      // typed placeholder design.md §7's milestone demo describes (`⟪AADHAAR#7⟫`). Mint directly
      // from the region here, the same call `sanitizeFreeText` makes for a free-text match.
      //
      // T-6.12: `value.kind === 'text'` for a `node.field` node here can only mean "un-redacted"
      // (never volatile — `toNodeValue` returns that case before `region` is ever computed, so
      // `region` truthy at this point already rules it out) — skip the redaction entry the same
      // way the free-text paths above do for the identical reason. The vision-only branch checks
      // `replacementFor`'s own `unredacted` flag directly, from the SAME call that computes `ref`
      // (not a second one) — `vault.mint` is idempotent per region, but there is no reason to
      // call it twice.
      let ref: string | null = null;
      let unredacted = false;
      if (node.field) {
        unredacted = value?.kind === 'text';
        if (!unredacted && value && 'ref' in value) ref = value.ref;
      } else {
        const replacement = replacementFor(region, vault, policy, originKey, stepId, input.ablation, input.unredactedRefs);
        unredacted = replacement.unredacted;
        if (!unredacted) ref = replacement.text.startsWith('⟪') && /#\d+⟫$/.test(replacement.text) ? replacement.text : null;
      }
      if (!unredacted) redactions.push(toRedactionEntry(region, ref));
    }
    const duplicateOfRun = runSubstitutionByBoxText.get(`${node.box.join(',')} ${node.name}`);
    const sanitizedName = duplicateOfRun ?? sanitizeFreeText(`name:${node.id}`, node.name);
    return {
      id: node.id,
      role: node.role,
      name: truncate(sanitizedName, 200),
      box: node.box,
      frame: node.frame,
      z: node.z,
      state: {
        focused: node.state.focused,
        disabled: node.state.disabled,
        readonly: node.state.readonly,
        required: node.state.required,
        checked: node.state.checked,
        expanded: node.state.expanded,
        selected: node.state.selected,
        has_value: node.state.hasValue,
        value_len: node.state.valueLen,
        occluded: node.state.occluded,
        volatile: node.state.volatile,
      },
      affordances: node.affordances,
      value,
    };
  });

  // Reuses `runSubstitutionByBoxText`'s already-computed result rather than calling
  // `sanitizeFreeText` again — that would push every run's redaction entries into `redactions[]`
  // a second time.
  const textRunEntries = escapedRuns.map((run) => ({
    id: run.id,
    box: run.box,
    text: runSubstitutionByBoxText.get(`${run.box.join(',')} ${run.text}`)!,
  }));

  const sanitizedTask = sanitizeFreeText('task', escapedTask);
  const sanitizedTitle = truncate(sanitizeFreeText('title', escapedTitle), 200);

  const redactedFraction = redactions.length > 0 ? Math.min(1, redactions.length / Math.max(1, nodes.length + textRunEntries.length)) : 0;

  return {
    schema: 'AEGIS/1',
    step_id: input.stepId,
    task: sanitizedTask,
    reason: input.reason,
    delta_of: input.deltaOf ?? null,
    viewport: {
      w: input.viewport.w,
      h: input.viewport.h,
      dpr: input.viewport.dpr,
      scroll_y: input.viewport.scrollY,
      doc_h: input.viewport.docH,
    },
    page: { category: input.pageCategory, title: sanitizedTitle },
    nodes,
    removed: input.removed.length > 0 ? input.removed : undefined,
    text: textRunEntries,
    redactions,
    unexplained: computeUnexplained(escapedNodes, input.visionAnalyzedNodeIds),
    // [A] Phase 4 forward dependency (phase_3_privacy_core.md §16): everything is structural, so
    // `unanalysed` stays 0; `redacted` is an approximation (fraction of nodes+runs that produced a
    // redaction) until the real compositor computes it from actual pixel area.
    coverage: { cleared: 1 - redactedFraction, redacted: redactedFraction, unanalysed: 0 },
    image: null,
    history: windowHistory(input.history),
    client_timing: input.clientTiming,
  };
}
