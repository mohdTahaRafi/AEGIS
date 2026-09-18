// AC-7's core mechanism: killing the perception worker mid-step must never leave a caller (the
// context builder awaiting `perceive`, or the guard awaiting `rescan`) hanging forever waiting on
// a promise that will never resolve — it must reject promptly so the step can fall back to "no
// image" / L0. A fake `WorkerLike` stands in for the real `Worker` so this is testable without a
// real extension/worker runtime.

import { describe, expect, it, vi } from 'vitest';
import { PerceptionClient, WorkerTerminatedError, type WorkerLike } from '../../src/host/perception-client/client';
import type { FromWorker } from '../../src/shared/worker-protocol';

function fakeWorker() {
  const listeners: { message: ((e: MessageEvent<FromWorker>) => void)[]; error: (() => void)[] } = { message: [], error: [] };
  const worker: WorkerLike = {
    postMessage: vi.fn(),
    addEventListener: (type: string, listener: any) => {
      if (type === 'message') listeners.message.push(listener);
      else listeners.error.push(listener);
    },
    terminate: vi.fn(),
  };
  return {
    worker,
    emit: (data: FromWorker) => listeners.message.forEach((l) => l({ data } as MessageEvent<FromWorker>)),
    crash: () => listeners.error.forEach((l) => l()),
  };
}

function fakeBitmap(): ImageBitmap {
  return { close: vi.fn() } as unknown as ImageBitmap;
}

describe('PerceptionClient (AC-7 — killing the worker mid-step)', () => {
  it('a pending perceive() call rejects with WorkerTerminatedError when the worker errors out', async () => {
    const { worker, crash } = fakeWorker();
    const client = new PerceptionClient(worker);
    const pending = client.perceive(fakeBitmap(), [], 120, false);
    crash();
    await expect(pending).rejects.toBeInstanceOf(WorkerTerminatedError);
  });

  it('a request made after termination rejects immediately, without posting to the dead worker', async () => {
    const { worker, crash } = fakeWorker();
    const client = new PerceptionClient(worker);
    crash();
    const postCountBefore = (worker.postMessage as any).mock.calls.length;
    await expect(client.perceive(fakeBitmap(), [], 120, false)).rejects.toBeInstanceOf(WorkerTerminatedError);
    expect((worker.postMessage as any).mock.calls.length).toBe(postCountBefore);
  });

  it('a resolved perceive() call correlates by jobId, not "whatever arrives next"', async () => {
    const { worker, emit } = fakeWorker();
    const client = new PerceptionClient(worker);
    const call = client.perceive(fakeBitmap(), [], 120, false);
    // An unrelated message with a different jobId must not resolve this call.
    emit({ t: 'perceived', jobId: 'not-mine', candidates: [], timings: {}, timedOut: [] });
    let resolved = false;
    call.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
  });

  it('terminate() rejects every still-pending request', async () => {
    const { worker } = fakeWorker();
    const client = new PerceptionClient(worker);
    const pending = client.perceive(fakeBitmap(), [], 120, false);
    client.terminate();
    await expect(pending).rejects.toBeInstanceOf(WorkerTerminatedError);
    expect(worker.terminate).toHaveBeenCalled();
  });
});
