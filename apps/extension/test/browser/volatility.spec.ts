// design.md §5.5, T-6.7 — the rate-based signals `observe.spec.ts`'s classification/epoch tests
// deliberately don't cover (see HISTORY.md's T-2.13 entry: the mutation-rate counters were
// explicitly deferred to this task).

import { afterEach, describe, expect, it } from 'vitest';
import { extractTextRuns } from '../../src/content/detect/spans';
import { EpochTracker } from '../../src/content/observe/epochs';
import { startObserving } from '../../src/content/observe/observers';
import { HostileDynamicTracker, VolatilityTracker } from '../../src/content/observe/volatility';
import { extractScreenGraph } from '../../src/content/screen-graph/extractor';
import { ContainerResolver, createNodeIdentityRegistry } from '../../src/content/screen-graph/identity';

afterEach(() => {
  document.body.innerHTML = '';
});

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('VolatilityTracker (design.md §5.5 — "mutates more than 3 times per second")', () => {
  it('is not volatile with 3 or fewer records in the last second', () => {
    const tracker = new VolatilityTracker();
    const el = document.createElement('div');
    tracker.record(el, 0);
    tracker.record(el, 200);
    tracker.record(el, 400);
    expect(tracker.isVolatile(el, 400)).toBe(false);
  });

  it('becomes volatile once more than 3 records land within the trailing 1000ms window', () => {
    const tracker = new VolatilityTracker();
    const el = document.createElement('div');
    tracker.record(el, 0);
    tracker.record(el, 200);
    tracker.record(el, 400);
    tracker.record(el, 600);
    expect(tracker.isVolatile(el, 600)).toBe(true);
  });

  it('stops being volatile once the fast mutations age out of the window', () => {
    const tracker = new VolatilityTracker();
    const el = document.createElement('div');
    for (const t of [0, 200, 400, 600]) tracker.record(el, t);
    expect(tracker.isVolatile(el, 600)).toBe(true);
    // 1500ms later, none of those four records are within the trailing 1000ms window any more.
    expect(tracker.isVolatile(el, 2100)).toBe(false);
  });

  it('tracks each element independently', () => {
    const tracker = new VolatilityTracker();
    const busy = document.createElement('div');
    const quiet = document.createElement('div');
    for (const t of [0, 100, 200, 300]) tracker.record(busy, t);
    tracker.record(quiet, 300);
    expect(tracker.isVolatile(busy, 300)).toBe(true);
    expect(tracker.isVolatile(quiet, 300)).toBe(false);
  });

  it('an element with no recorded history is never volatile', () => {
    const tracker = new VolatilityTracker();
    expect(tracker.isVolatile(document.createElement('div'), 0)).toBe(false);
  });
});

describe('HostileDynamicTracker (design.md §5.5 — ">20 semantic changes/s sustained for 2s")', () => {
  it('is not hostile-dynamic under the threshold', () => {
    const tracker = new HostileDynamicTracker();
    for (let i = 0; i < 40; i++) tracker.record(i * 50); // 40 events over 2000ms = 20/s exactly
    expect(tracker.isHostileDynamic(1950)).toBe(false);
  });

  it('becomes hostile-dynamic once the trailing 2s window exceeds the threshold', () => {
    const tracker = new HostileDynamicTracker();
    for (let i = 0; i < 45; i++) tracker.record(i * 40); // 45 events over 1760ms — well past 20/s
    expect(tracker.isHostileDynamic(1760)).toBe(true);
  });

  it('recovers once the burst ages out of the window', () => {
    const tracker = new HostileDynamicTracker();
    for (let i = 0; i < 45; i++) tracker.record(i * 40);
    expect(tracker.isHostileDynamic(1760)).toBe(true);
    expect(tracker.isHostileDynamic(1760 + 2100)).toBe(false);
  });
});

describe('startObserving — volatility integration (T-6.7)', () => {
  it('a rapidly-updating clock element is reported volatile by the shared tracker', async () => {
    document.body.innerHTML = '<div id="clock">12:00:00</div>';
    const clock = document.getElementById('clock')!;
    const volatilityTracker = new VolatilityTracker();
    const hostileDynamicTracker = new HostileDynamicTracker();
    const handle = startObserving(document.body, new ContainerResolver(), new EpochTracker(), () => {}, {
      volatilityTracker,
      hostileDynamicTracker,
    });

    try {
      for (let i = 0; i < 5; i++) {
        clock.firstChild!.textContent = `12:00:0${i}`;
        await nextMacrotask();
      }
      expect(volatilityTracker.isVolatile(clock, Date.now())).toBe(true);
    } finally {
      handle.disconnect();
    }
  });

  it('a page mutating structurally at a high rate trips onHostileDynamicChange(true)', async () => {
    document.body.innerHTML = '<div id="host"></div>';
    const host = document.getElementById('host')!;
    const volatilityTracker = new VolatilityTracker();
    const hostileDynamicTracker = new HostileDynamicTracker();
    const transitions: boolean[] = [];
    const handle = startObserving(document.body, new ContainerResolver(), new EpochTracker(), () => {}, {
      volatilityTracker,
      hostileDynamicTracker,
      onHostileDynamicChange: (active) => transitions.push(active),
    });

    try {
      // Each iteration adds and removes a real element (childList, non-cosmetic) — enough
      // batches, fast enough, to exceed 20 non-cosmetic mutations within a 2s window.
      for (let i = 0; i < 50; i++) {
        host.innerHTML = `<button>b-${i}</button>`;
        await nextMacrotask();
      }
      expect(transitions).toContain(true);
    } finally {
      handle.disconnect();
    }
  });
});

describe('extractScreenGraph / extractTextRuns — real volatile flag end to end (T-6.7)', () => {
  it('a node whose element the tracker marks volatile carries state.volatile: true in the real graph', () => {
    document.body.innerHTML = '<button id="b">Click</button>';
    const el = document.getElementById('b')!;
    const tracker = new VolatilityTracker();
    for (const t of [0, 200, 400, 600]) tracker.record(el, t);

    const graph = extractScreenGraph(createNodeIdentityRegistry(), new ContainerResolver(), {
      isVolatile: (candidate) => tracker.isVolatile(candidate, 600),
    });

    const [nodeId] = [...graph.elements.entries()].find(([, element]) => element === el)!;
    const node = graph.nodes.find((n) => n.id === nodeId);
    expect(node?.state.volatile).toBe(true);
  });

  it('a leaf text run whose element the tracker marks volatile carries volatile: true', () => {
    document.body.innerHTML = '<div id="clock">12:00:00</div>';
    const el = document.getElementById('clock')!;
    const tracker = new VolatilityTracker();
    for (const t of [0, 200, 400, 600]) tracker.record(el, t);

    const runs = extractTextRuns(
      document.body,
      { width: window.innerWidth, height: window.innerHeight, verticalMarginPx: window.innerHeight },
      (candidate) => tracker.isVolatile(candidate, 600),
    );

    const clockRun = runs.find((r) => r.text === '12:00:00');
    expect(clockRun?.volatile).toBe(true);
  });

  it('a non-volatile element gets volatile: undefined (omitted), not a stray false', () => {
    document.body.innerHTML = '<div id="clock">steady</div>';
    const runs = extractTextRuns(document.body, { width: window.innerWidth, height: window.innerHeight, verticalMarginPx: window.innerHeight });
    expect(runs.find((r) => r.text === 'steady')?.volatile).toBeUndefined();
  });
});
