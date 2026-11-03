import { describe, expect, it } from 'vitest';
import type { SanitizedContext } from '@aegis/protocol';
import { draftKey, fitRecord, forgetTask, forgetWindow, loadDraft, loadTask, saveDraft, saveTask, savedTaskKey, stepsStarted, wasCutOff, type SavedTask, type SavedTaskStore } from '../../src/host/saved-task';
import { EMPTY_RUN_LOG, type StepLog } from '../../src/ui/RunLog';

function memoryStore(): SavedTaskStore & { items: Map<string, unknown> } {
  const items = new Map<string, unknown>();
  return {
    items,
    get: async (key) => (items.has(key) ? { [key]: items.get(key) } : {}),
    set: async (values) => {
      for (const [k, v] of Object.entries(values)) items.set(k, structuredClone(v));
    },
    remove: async (key) => {
      items.delete(key);
    },
  };
}

function step(stepId: string, imageBytes: number): StepLog {
  const payload = { step_id: stepId, nodes: [], redactions: [], image: { level: 'L1', region: [0, 0, 10, 10], scale: 1, format: 'image/webp', sha256: '0'.repeat(64), data: 'A'.repeat(imageBytes), legend: '' } } as unknown as SanitizedContext;
  return { stepId, payload, protectedFields: [], serverNotes: [], activity: [], modelTexts: [], pageNotes: [] };
}

function record(steps: StepLog[]): SavedTask {
  return { version: 1, task: 'find the price', startedAt: 1, tabId: 7, state: 'running', errorMessage: null, log: { ...EMPTY_RUN_LOG, steps }, history: [] };
}

describe('saved task (closing the panel keeps the task view)', () => {
  it('round-trips a record per window and forgets it', async () => {
    const store = memoryStore();
    await saveTask(store, 3, record([step('s-1', 10)]));
    expect(await loadTask(store, 4)).toBeNull();
    const loaded = await loadTask(store, 3);
    expect(loaded?.task).toBe('find the price');
    expect(loaded?.log.steps[0]?.payload?.image?.data).toBe('A'.repeat(10));
    await forgetTask(store, 3);
    expect(store.items.has(savedTaskKey(3))).toBe(false);
  });

  it('keeps the task-box draft per window; an emptied box removes it; a closed window drops both', async () => {
    const store = memoryStore();
    await saveDraft(store, 3, 'compare SSD prices');
    expect(await loadDraft(store, 3)).toBe('compare SSD prices');
    expect(await loadDraft(store, 4)).toBe('');
    await saveDraft(store, 3, '');
    expect(store.items.has(draftKey(3))).toBe(false);
    await saveDraft(store, 3, 'x');
    await saveTask(store, 3, record([]));
    await forgetTask(store, 3);
    expect(await loadDraft(store, 3)).toBe('x');
    await saveTask(store, 3, record([]));
    await forgetWindow(store, 3);
    expect(store.items.size).toBe(0);
  });

  it('ignores a value that is not a saved task', async () => {
    const store = memoryStore();
    store.items.set(savedTaskKey(1), { version: 2, task: 'x' });
    expect(await loadTask(store, 1)).toBeNull();
  });

  it('only the states a live panel can be in mean the task was cut off', () => {
    expect(wasCutOff('running')).toBe(true);
    expect(wasCutOff('awaiting-confirmation')).toBe(true);
    expect(wasCutOff('done')).toBe(false);
    expect(wasCutOff('error')).toBe(false);
    expect(wasCutOff('interrupted')).toBe(false);
  });

  it('counts the steps the saved run started', () => {
    expect(stepsStarted(EMPTY_RUN_LOG)).toBe(0);
    expect(stepsStarted({ ...EMPTY_RUN_LOG, steps: [step('s-4', 0), step('s-5', 0)] })).toBe(5);
  });

  it('drops the oldest screenshots first to fit, keeping the latest step whole', () => {
    const big = record([step('s-1', 40_000), step('s-2', 40_000), step('s-3', 40_000)]);
    const fitted = fitRecord(big, 50_000)!;
    const data = fitted.log.steps.map((s) => s.payload?.image?.data.length);
    expect(data).toEqual([0, 0, 40_000]);
    // The input is not modified.
    expect(big.log.steps[0]!.payload!.image!.data.length).toBe(40_000);
  });

  it('drops older payloads before the latest screenshot, and gives up when nothing fits', () => {
    const big = record([step('s-1', 0), step('s-2', 3000)]);
    const fitted = fitRecord(big, 3700)!;
    expect(fitted.log.steps.map((s) => s.payload !== undefined)).toEqual([false, true]);
    expect(fitted.log.steps[1]!.payload!.image!.data.length).toBe(3000);
    expect(fitRecord(big, 50)).toBeNull();
  });
});
