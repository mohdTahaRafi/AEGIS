import { afterEach, describe, expect, it } from 'vitest';
import { waitForSettle } from '../../src/content/execute/settle';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('waitForSettle (design.md §5.10 AC)', () => {
  it('resolves "settled" at roughly the quiet window on a calm page', async () => {
    document.body.innerHTML = '<div id="target"></div>';
    const start = performance.now();
    const outcome = await waitForSettle(document.body, { quietMs: 250, maxWaitMs: 1500 });
    const elapsed = performance.now() - start;
    expect(outcome).toBe('settled');
    expect(elapsed).toBeLessThan(1000); // well under the 1500ms cap
  });

  it('caps at maxWaitMs on a page that polls every 100ms', async () => {
    document.body.innerHTML = '<div id="target"></div>';
    const target = document.getElementById('target')!;
    const interval = setInterval(() => {
      target.setAttribute('data-tick', String(Date.now()));
    }, 100);

    const start = performance.now();
    const outcome = await waitForSettle(document.body, { quietMs: 250, maxWaitMs: 1500 });
    const elapsed = performance.now() - start;
    clearInterval(interval);

    expect(outcome).toBe('timeout');
    expect(elapsed).toBeGreaterThanOrEqual(1450);
    expect(elapsed).toBeLessThan(2000);
  });

  it('resolves "navigated" immediately on pagehide, without waiting for quiet', async () => {
    document.body.innerHTML = '<div id="target"></div>';
    const target = document.getElementById('target')!;
    const interval = setInterval(() => {
      target.setAttribute('data-tick', String(Date.now()));
    }, 50);

    const promise = waitForSettle(document.body, { quietMs: 250, maxWaitMs: 5000 });
    setTimeout(() => window.dispatchEvent(new Event('pagehide')), 50);
    const outcome = await promise;
    clearInterval(interval);
    expect(outcome).toBe('navigated');
  });
});
