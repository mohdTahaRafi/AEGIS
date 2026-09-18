// design.md §4.3 (packages/protocol's SanitizedContext) / phase_3_privacy_core.md §5 — the real
// privacy-preserving builder. Runs Channel D (already computed content-side, carried as
// `node.domSignal`) and Channel T (this file, via @aegis/recognizers) over every field value, free
// text run and the task string, fuses the results, mints typed placeholders through the vault, and
// substitutes them before anything is serialized. Nothing here ever forwards a raw sensitive value
// into the returned `SanitizedContext` — every string that could carry one goes through
// `escapePlaceholderDelimiters` → detection → `mintForRegion`/substitution first.
//
// [A] No vision channel this phase (Phase 4): `unexplained` stays `[]`, `coverage` stays
// `{cleared:1, redacted:n, unanalysed:0}` (phase_3_privacy_core.md §16). [A] NER (design.md §6.3)
// is not a real pretrained model in this environment — see `perception/models/pii-ner.ts`'s doc
// comment for why, and `docs/CURRENT_BUILD.md` for the disclosed gap. Channel T (deterministic
// recognizers) is real and is what this builder relies on for the milestone demo's Aadhaar/email
// detections.

import type { SanitizedContext } from '@aegis/protocol';
import type { RecognizerContext } from '@aegis/recognizers';
import { findAll } from '@aegis/recognizers';
import type { Policy } from '@aegis/policy';
import { isPresenceOnly } from '@aegis/policy';
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
   * candidates are special," only `channel: 'vision'`. Absent (not `[]`) is the normal case for a
   * step that never captured a frame at all — kept optional so every Phase 3 caller/test is
   * unaffected. */
  visionCandidates?: Candidate[];
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

function toNodeValue(node: WireScreenNode, region: SensitiveRegion | undefined, vault: Vault, policy: Policy, originKey: string, stepId: string): NodeValue | undefined {
  if (!node.field) return undefined;

  if (region) {
    const minted = mintForRegion(vault, policy, region, originKey, stepId);
    if (minted) {
      // Presence-only regions never had a value to measure (T-3.9) — report the field's own
      // observed length (from `computeState`'s `.value.length` read, never the string) instead.
      if (minted.kind === 'presence' && minted.len === 0) {
        return { ...minted, len: node.state.valueLen };
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
 * '⟪ENTITY⟫' for non-resolvable items" branch. */
function replacementFor(region: SensitiveRegion, vault: Vault, policy: Policy, originKey: string, stepId: string): string {
  if (region.presenceOnly || isPresenceOnly(policy, region.entity) || region.value === undefined) {
    return `⟪${region.entity}⟫`;
  }
  return vault.mint(region.entity, region.value, { originKey, stepId, class: region.class });
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

export function buildSanitizedContext(input: BuildContextInput): SanitizedContext {
  const { vault, policy, originKey, stepId } = input;

  // 1. Escape forged placeholder delimiters BEFORE anything is scanned or substituted (T-3.16).
  const escapedTask = escapePlaceholderDelimiters(input.task);
  const escapedTitle = escapePlaceholderDelimiters(input.pageTitle);
  const escapedNodes = input.nodes.map((n) => ({
    ...n,
    name: escapePlaceholderDelimiters(n.name),
    field: n.field?.value !== undefined ? { ...n.field, value: escapePlaceholderDelimiters(n.field.value) } : n.field,
  }));
  const escapedRuns = input.textRuns.map((r) => ({ ...r, text: escapePlaceholderDelimiters(r.text) }));

  // 2. Collect candidates: Channel D (already computed content-side) + Channel T over field
  // values and every free-text source.
  const candidates: Candidate[] = [];
  for (const node of escapedNodes) {
    const domCandidate = candidateFromDomSignal(node, node.field?.value);
    if (domCandidate) candidates.push(domCandidate);
    if (node.field?.valueRead && node.field.value) {
      candidates.push(...candidatesFromNodeValue(node, node.field.value));
    }
  }

  const freeTextSources: FreeTextSource[] = [
    ...escapedRuns.map((r) => ({ key: `run:${r.id}`, box: r.box, text: r.text })),
    ...escapedNodes.map((n) => ({ key: `name:${n.id}`, box: n.box, text: n.name })),
    { key: 'task', box: [0, 0, 0, 0] as [number, number, number, number], text: escapedTask },
    { key: 'title', box: [0, 0, 0, 0] as [number, number, number, number], text: escapedTitle },
  ];
  for (const source of freeTextSources) {
    candidates.push(...candidatesFromTextRun(source.key, source.box, source.text));
  }
  if (input.visionCandidates) candidates.push(...input.visionCandidates);

  // 3. Fuse.
  const regions = fuse(policy, candidates);
  const regionsByKey = new Map(regions.map((r) => [regionKey(r), r]));

  // 4. Mint + substitute.
  const redactions: RedactionEntry[] = [];

  function sanitizeFreeText(key: string, text: string): string {
    const regionsForKey = regions.filter((r) => r.textRunId === key);
    const replacements: SpanReplacement[] = regionsForKey
      .filter((r): r is SensitiveRegion & { span: [number, number] } => r.span !== undefined)
      .map((r) => {
        const replacement = replacementFor(r, vault, policy, originKey, stepId);
        const ref = replacement.startsWith('⟪') && /#\d+⟫$/.test(replacement) ? replacement : null;
        redactions.push(toRedactionEntry(r, ref));
        return { span: r.span, entity: r.entity, replacement };
      });
    return substitute(text, replacements);
  }

  const nodes: SanitizedNode[] = escapedNodes.map((node) => {
    const region = regionsByKey.get(`node:${node.id}`);
    const value = toNodeValue(node, region, vault, policy, originKey, stepId);
    if (region) {
      const ref = value && 'ref' in value ? value.ref : null;
      redactions.push(toRedactionEntry(region, ref));
    }
    return {
      id: node.id,
      role: node.role,
      name: truncate(sanitizeFreeText(`name:${node.id}`, node.name), 200),
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

  const textRunEntries = escapedRuns.map((run) => ({
    id: run.id,
    box: run.box,
    text: sanitizeFreeText(`run:${run.id}`, run.text),
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
    unexplained: [],
    // [A] Phase 4 forward dependency (phase_3_privacy_core.md §16): everything is structural, so
    // `unanalysed` stays 0; `redacted` is an approximation (fraction of nodes+runs that produced a
    // redaction) until the real compositor computes it from actual pixel area.
    coverage: { cleared: 1 - redactedFraction, redacted: redactedFraction, unanalysed: 0 },
    image: null,
    history: windowHistory(input.history),
    client_timing: input.clientTiming,
  };
}
