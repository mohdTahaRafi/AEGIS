// design.md §5.7 / phase_2_spine.md §3.7 (T-2.16) — added/changed/removed per node.
//
// "Reset on top-level navigation" needs no explicit call here: a real top-level navigation
// destroys the document's JS context entirely, so the content script is re-injected fresh and a
// brand-new `DeltaTracker` starts with an empty `previous` map — which already forces a full
// graph on its first `compute()` call. A `reset()` is still exposed for a host-requested resync.
import type { WireScreenNode } from '../../shared/messages';

export interface DeltaResult {
  /** Full node set on a full graph; only added-or-changed nodes on a delta. */
  nodes: WireScreenNode[];
  /** Ids present before and absent now. Always `[]` on a full graph — "removed" is meaningless
   * against a graph that already lists everything current. */
  removed: string[];
  full: boolean;
}

function serialize(node: WireScreenNode): string {
  return JSON.stringify(node);
}

export class DeltaTracker {
  private previous = new Map<string, string>();
  private stepsSinceFullGraph = 0;
  private lastPrivacyEpoch: number | null = null;
  private readonly fullGraphEveryNSteps: number;

  constructor(fullGraphEveryNSteps = 10) {
    this.fullGraphEveryNSteps = fullGraphEveryNSteps;
  }

  reset(): void {
    this.previous = new Map();
    this.stepsSinceFullGraph = 0;
    this.lastPrivacyEpoch = null;
  }

  /**
   * `privacyEpoch` bumping forces a full graph — a stale delta computed against a page state from
   * before a password field appeared must never be trusted (phase_2_spine.md §3.6); in Phase 2
   * nothing reads that guarantee yet (T-2.16's forward dependency), but the mechanism exists now
   * so Phase 3 does not have to retrofit it.
   */
  compute(nodes: WireScreenNode[], privacyEpoch: number): DeltaResult {
    const privacyEpochChanged = this.lastPrivacyEpoch !== null && privacyEpoch !== this.lastPrivacyEpoch;
    const forceFull = this.previous.size === 0 || privacyEpochChanged || this.stepsSinceFullGraph >= this.fullGraphEveryNSteps;
    this.lastPrivacyEpoch = privacyEpoch;

    if (forceFull) {
      this.previous = new Map(nodes.map((n) => [n.id, serialize(n)]));
      this.stepsSinceFullGraph = 0;
      return { nodes, removed: [], full: true };
    }

    const currentIds = new Set(nodes.map((n) => n.id));
    const removed: string[] = [];
    for (const id of this.previous.keys()) {
      if (!currentIds.has(id)) removed.push(id);
    }

    const changedOrAdded: WireScreenNode[] = [];
    const nextSnapshot = new Map<string, string>();
    for (const node of nodes) {
      const serialized = serialize(node);
      nextSnapshot.set(node.id, serialized);
      if (this.previous.get(node.id) !== serialized) changedOrAdded.push(node);
    }

    this.previous = nextSnapshot;
    this.stepsSinceFullGraph += 1;
    return { nodes: changedOrAdded, removed, full: false };
  }
}
