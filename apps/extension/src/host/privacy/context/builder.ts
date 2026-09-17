// design.md §4.3 (packages/protocol's SanitizedContext) / phase_2_spine.md §14 forward
// dependency — Phase 2 builds the L0 payload shape with **no redaction**: every field-bearing
// node's value is sent as raw text, `redactions` is always `[]`, and `coverage` reports
// everything as `cleared`. This is the controlled, temporary exposure phase_2_spine.md §8
// governs (the Phase-2 guard stub + fixture-origin allowlist) — this builder doesn't hide it or
// pretend otherwise.
//
// `SanitizedNode`/`NodeValue` aren't re-exported from the package root (only the top-level
// document types are — see host/actions/dispatch.ts's same note about `Action`), so they're
// derived here via indexed access on `SanitizedContext` itself.

import type { SanitizedContext } from '@aegis/protocol';
import type { WireScreenNode } from '../../../shared/messages';

type SanitizedNode = SanitizedContext['nodes'][number];
type NodeValue = NonNullable<SanitizedNode['value']>;
type HistoryEntry = NonNullable<SanitizedContext['history']>[number];

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
  /** Windowed to the most recent `MAX_HISTORY_ENTRIES` (design.md §12.2's history windowing,
   * K=5) — a caller may pass more and this function keeps only what fits. */
  history: HistoryEntry[];
  clientTiming: Record<string, number>;
}

function toNodeValue(node: WireScreenNode): NodeValue | undefined {
  if (!node.field) return undefined;
  return { kind: 'text', text: node.field.value ?? '' };
}

function toSanitizedNode(node: WireScreenNode): SanitizedNode {
  return {
    id: node.id,
    role: node.role,
    name: node.name,
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
    value: toNodeValue(node),
  };
}

/** Cast at the boundary: the generated schema represents "array, maxItems 5" as a union of fixed-
 * length tuples rather than `T[]`, which is exact but awkward to construct incrementally. The
 * length check just above is what actually enforces the ≤5 invariant; the cast only tells
 * TypeScript about a shape already guaranteed true. */
function windowHistory(history: HistoryEntry[]): SanitizedContext['history'] {
  const windowed = history.slice(-MAX_HISTORY_ENTRIES);
  return windowed as SanitizedContext['history'];
}

export function buildSanitizedContext(input: BuildContextInput): SanitizedContext {
  return {
    schema: 'AEGIS/1',
    step_id: input.stepId,
    task: input.task,
    reason: input.reason,
    delta_of: input.deltaOf ?? null,
    viewport: {
      w: input.viewport.w,
      h: input.viewport.h,
      dpr: input.viewport.dpr,
      scroll_y: input.viewport.scrollY,
      doc_h: input.viewport.docH,
    },
    page: { category: input.pageCategory, title: input.pageTitle },
    nodes: input.nodes.map(toSanitizedNode),
    removed: input.removed.length > 0 ? input.removed : undefined,
    // No text-run extraction exists yet (RawScreenNode.textRuns is always [] — not a Phase 2
    // task); no redaction layer exists yet (Phase 3).
    text: [],
    redactions: [],
    unexplained: [],
    // `coverage` is a 0..1 fraction of the page, not a node count (packages/protocol/schema:
    // maximum 1). Phase 2 has no analysis layer at all, so per phase_2_spine.md §14's forward
    // dependency this is always exactly {cleared:1, redacted:0, unanalysed:0} — Phase 4 computes
    // the real fractions from the compositor.
    coverage: { cleared: 1, redacted: 0, unanalysed: 0 },
    image: null,
    history: windowHistory(input.history),
    client_timing: input.clientTiming,
  };
}
