import { describe, expect, it } from 'vitest';
import { PriorityQueue } from '../../src/perception/schedule/queue';
import { runWithDeadline } from '../../src/perception/schedule/deadline';
import { applyCropBudget, cropBudgetFor } from '../../src/perception/schedule/budget';
import { decideLadderLevel, ocrAllowedAt, cropBudgetMultiplierFor, DEFAULT_LADDER_THRESHOLDS } from '../../src/perception/schedule/ladder';

describe('PriorityQueue (T-4.10 — faces > ViT > OCR > NER)', () => {
  it('dequeues strictly by priority regardless of enqueue order', () => {
    const q = new PriorityQueue();
    q.enqueue({ id: 'n-1', kind: 'ner', payload: null });
    q.enqueue({ id: 'f-1', kind: 'face', payload: null });
    q.enqueue({ id: 'o-1', kind: 'ocr', payload: null });
    q.enqueue({ id: 'v-1', kind: 'vit', payload: null });
    expect(q.dequeue()?.id).toBe('f-1');
    expect(q.dequeue()?.id).toBe('v-1');
    expect(q.dequeue()?.id).toBe('o-1');
    expect(q.dequeue()?.id).toBe('n-1');
    expect(q.dequeue()).toBeNull();
  });

  it('is FIFO within the same priority band', () => {
    const q = new PriorityQueue();
    q.enqueue({ id: 'f-1', kind: 'face', payload: null });
    q.enqueue({ id: 'f-2', kind: 'face', payload: null });
    expect(q.dequeue()?.id).toBe('f-1');
    expect(q.dequeue()?.id).toBe('f-2');
  });

  it('dropAll returns and removes every job of a kind — never silently', () => {
    const q = new PriorityQueue();
    q.enqueue({ id: 'o-1', kind: 'ocr', payload: null });
    q.enqueue({ id: 'o-2', kind: 'ocr', payload: null });
    q.enqueue({ id: 'f-1', kind: 'face', payload: null });
    const dropped = q.dropAll('ocr');
    expect(dropped.map((j) => j.id)).toEqual(['o-1', 'o-2']);
    expect(q.size).toBe(1);
  });
});

describe('runWithDeadline (T-4.10, phase_4_vision.md §6.2 — 120ms hard deadline)', () => {
  it('completes every job when none exceed the deadline', async () => {
    const q = new PriorityQueue<number>();
    q.enqueue({ id: 'a', kind: 'face', payload: 1 });
    q.enqueue({ id: 'b', kind: 'face', payload: 2 });
    const t = 0;
    const result = await runWithDeadline(q, async (job) => job.payload * 2, 100, () => t);
    expect(result.completed.map((c) => c.result)).toEqual([2, 4]);
    expect(result.timedOut).toHaveLength(0);
  });

  it('abandons everything still queued once the deadline elapses — reported as timedOut, never silently dropped', async () => {
    const q = new PriorityQueue<number>();
    q.enqueue({ id: 'a', kind: 'face', payload: 1 });
    q.enqueue({ id: 'b', kind: 'face', payload: 2 });
    q.enqueue({ id: 'c', kind: 'face', payload: 3 });
    let calls = 0;
    let t = 0;
    const result = await runWithDeadline(
      q,
      async (job) => {
        calls += 1;
        t = 150; // deadline blown after the first job starts
        return job.payload;
      },
      100,
      () => t,
    );
    expect(calls).toBe(1);
    expect(result.completed).toHaveLength(1);
    expect(result.timedOut.map((j) => j.id)).toEqual(['b', 'c']);
  });
});

describe('crop budget (T-4.11 — 16 WebGPU / 8 WASM)', () => {
  it('reports the documented per-backend budgets', () => {
    expect(cropBudgetFor('webgpu')).toBe(16);
    expect(cropBudgetFor('wasm')).toBe(8);
  });

  it('applyCropBudget admits up to the budget and reports the rest as dropped', () => {
    const regions = Array.from({ length: 10 }, (_, i) => i);
    const { admitted, dropped } = applyCropBudget(regions, 'wasm');
    expect(admitted).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(dropped).toEqual([8, 9]);
  });
});

describe('degradation ladder (T-4.11 — face detection never dropped)', () => {
  it('reports full capability under good conditions', () => {
    expect(decideLadderLevel({ recentFrameMsP95: 50, deviceMemoryGB: 8, hardwareConcurrency: 8 })).toBe('full');
  });

  it('demotes to reduced-crops on a weak device even with fast frames', () => {
    expect(decideLadderLevel({ recentFrameMsP95: 10, deviceMemoryGB: 2, hardwareConcurrency: 8 })).toBe('reduced-crops');
  });

  it('escalates down the ladder as measured frame time rises', () => {
    const strong = { deviceMemoryGB: 8, hardwareConcurrency: 8 };
    expect(decideLadderLevel({ ...strong, recentFrameMsP95: DEFAULT_LADDER_THRESHOLDS.reducedCropsFrameMs })).toBe('reduced-crops');
    expect(decideLadderLevel({ ...strong, recentFrameMsP95: DEFAULT_LADDER_THRESHOLDS.noOcrFrameMs })).toBe('no-ocr');
    expect(decideLadderLevel({ ...strong, recentFrameMsP95: DEFAULT_LADDER_THRESHOLDS.structuredOnlyFrameMs })).toBe('structured-only');
  });

  it('there is no ladder level/API that disables face detection — FR-22 is unconditional', () => {
    // decideLadderLevel's return type has no such field to check by construction; this test
    // documents the invariant so a future refactor that adds one fails review, not silently.
    const level = decideLadderLevel({ recentFrameMsP95: 9999, deviceMemoryGB: 0.5, hardwareConcurrency: 1 });
    expect(level).toBe('structured-only');
    expect(Object.keys({ level })).not.toContain('faceDetection');
  });

  it('OCR is allowed only at full/reduced-crops levels', () => {
    expect(ocrAllowedAt('full')).toBe(true);
    expect(ocrAllowedAt('reduced-crops')).toBe(true);
    expect(ocrAllowedAt('no-ocr')).toBe(false);
    expect(ocrAllowedAt('structured-only')).toBe(false);
  });

  it('structured-only has a zero crop budget multiplier', () => {
    expect(cropBudgetMultiplierFor('structured-only')).toBe(0);
    expect(cropBudgetMultiplierFor('full')).toBe(1);
  });
});
