import { afterEach, describe, expect, it } from 'vitest';
import { extractScreenGraph } from '../../src/content/screen-graph/extractor';
import { ContainerResolver, createNodeIdentityRegistry } from '../../src/content/screen-graph/identity';

afterEach(() => {
  document.body.innerHTML = '';
});

// T-2.10 / phase_2_spine.md §12: "observe stage (delta), 2,000-node page, 50 runs, target ≤10ms
// p95 — on the reference laptop (OQ-16, not yet chosen)". This environment is a sandboxed headless
// Chromium, not that laptop, so the number below is reported, not asserted against the 10ms
// target — asserting a hardware-dependent target against the wrong hardware would be exactly the
// "measure, don't assert" violation this project's own rules warn against (CLAUDE.md §5). The
// generous bound here only catches a genuine algorithmic regression (e.g. accidental O(n²)).
describe('extractScreenGraph — 2,000-node performance (T-2.10, unverified against the reference laptop)', () => {
  it('completes well within a sanity bound and reports the measured distribution', () => {
    const parts: string[] = [];
    for (let i = 0; i < 2000; i += 1) {
      parts.push(`<button style="display:block;width:40px;height:20px;">n${i}</button>`);
    }
    document.body.innerHTML = parts.join('');

    const durations: number[] = [];
    for (let run = 0; run < 50; run += 1) {
      const identity = createNodeIdentityRegistry();
      const containerResolver = new ContainerResolver();
      const start = performance.now();
      const { nodes } = extractScreenGraph(identity, containerResolver);
      durations.push(performance.now() - start);
      if (run === 0) expect(nodes.length).toBeGreaterThan(0);
    }

    durations.sort((a, b) => a - b);
    const p50 = durations[Math.floor(durations.length * 0.5)]!;
    const p95 = durations[Math.floor(durations.length * 0.95)]!;

    console.log(
      `[bench] extractScreenGraph, n=2000 buttons, 50 runs, sandboxed headless Chromium ` +
        `(NOT the reference laptop, OQ-16 unresolved): p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms`,
    );

    // Sanity bound only — catches an algorithmic regression, not a target claim.
    expect(p95).toBeLessThan(500);
  });
});
