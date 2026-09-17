import { describe, expect, it } from 'vitest';
import { DeltaTracker } from '../../src/content/observe/delta';
import type { WireScreenNode } from '../../src/shared/messages';

function node(id: string, overrides: Partial<WireScreenNode> = {}): WireScreenNode {
  return {
    id,
    frame: 'f-0',
    role: 'button',
    name: `Button ${id}`,
    box: [0, 0, 10, 10],
    z: 0,
    state: { focused: false, disabled: false, readonly: false, required: false, hasValue: false, valueLen: 0, occluded: false, volatile: false },
    affordances: ['click'],
    container: 'root',
    textRuns: [],
    ...overrides,
  };
}

describe('DeltaTracker (design.md §5.7, phase_2_spine.md §3.7 AC)', () => {
  it('the first compute() is always a full graph', () => {
    const tracker = new DeltaTracker();
    const result = tracker.compute([node('n-1'), node('n-2')], 0);
    expect(result.full).toBe(true);
    expect(result.nodes.map((n) => n.id).sort()).toEqual(['n-1', 'n-2']);
    expect(result.removed).toEqual([]);
  });

  it('step 2 on an unchanged page sends added: []', () => {
    const tracker = new DeltaTracker();
    tracker.compute([node('n-1'), node('n-2')], 0);
    const second = tracker.compute([node('n-1'), node('n-2')], 0);
    expect(second.full).toBe(false);
    expect(second.nodes).toEqual([]);
    expect(second.removed).toEqual([]);
  });

  it('reports a genuinely new node as added and a removed one by id', () => {
    const tracker = new DeltaTracker();
    tracker.compute([node('n-1'), node('n-2')], 0);
    const second = tracker.compute([node('n-1'), node('n-3')], 0);
    expect(second.full).toBe(false);
    expect(second.nodes.map((n) => n.id)).toEqual(['n-3']);
    expect(second.removed).toEqual(['n-2']);
  });

  it('reports a node whose content changed (same id) as changed', () => {
    const tracker = new DeltaTracker();
    tracker.compute([node('n-1', { name: 'Old label' })], 0);
    const second = tracker.compute([node('n-1', { name: 'New label' })], 0);
    expect(second.full).toBe(false);
    expect(second.nodes).toEqual([node('n-1', { name: 'New label' })]);
  });

  it('a privacyEpoch bump forces a full graph', () => {
    const tracker = new DeltaTracker();
    tracker.compute([node('n-1')], 0);
    const second = tracker.compute([node('n-1')], 1);
    expect(second.full).toBe(true);
    expect(second.nodes.map((n) => n.id)).toEqual(['n-1']);
  });

  it('forces a full graph every N steps to bound drift (N=10)', () => {
    const tracker = new DeltaTracker(10);
    tracker.compute([node('n-1')], 0); // the first call: always full
    for (let i = 0; i < 10; i += 1) {
      const r = tracker.compute([node('n-1')], 0); // exactly N=10 delta calls follow it
      expect(r.full).toBe(false);
    }
    const next = tracker.compute([node('n-1')], 0); // the 11th call since the last full: full again
    expect(next.full).toBe(true);
  });

  it('reset() clears history so the next compute() is a full graph again', () => {
    const tracker = new DeltaTracker();
    tracker.compute([node('n-1')], 0);
    tracker.reset();
    const afterReset = tracker.compute([node('n-1')], 0);
    expect(afterReset.full).toBe(true);
  });

  it('a fresh tracker (simulating re-injection after a top-level navigation) starts full', () => {
    const before = new DeltaTracker();
    before.compute([node('n-1')], 0);
    before.compute([node('n-1')], 0); // now a delta-capable tracker

    // A real navigation destroys the document's JS context; the new content script gets a brand
    // new tracker instance, not this one.
    const afterNavigation = new DeltaTracker();
    const result = afterNavigation.compute([node('n-1')], 0);
    expect(result.full).toBe(true);
  });
});
