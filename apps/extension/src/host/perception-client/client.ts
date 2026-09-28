// design.md §11.1 — the host's side of the typed worker message interface. Owns the one
// `perception/worker.ts` instance for the session's lifetime, correlates request/response pairs
// by `jobId` (the worker may interleave `nerResult` and `perceived` responses, so a bare
// "next message wins" listener would misroute), and is the only place in `src/host/**` that talks
// to the worker — every other host module goes through this class, never `postMessage` directly.
// This file itself must not import anything under `src/perception/**` (ESLint-enforced) — it only
// knows the neutral `shared/worker-protocol` message shapes.

import type { FromWorker, ModelSpec, ToWorker } from '../../shared/worker-protocol';

export interface WorkerLike {
  postMessage(message: ToWorker, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<FromWorker>) => void): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  terminate(): void;
}

let jobCounter = 0;
function nextJobId(): string {
  jobCounter += 1;
  return `j-${jobCounter}`;
}

export class WorkerTerminatedError extends Error {
  constructor() {
    super('perception worker was terminated before this job resolved');
    this.name = 'WorkerTerminatedError';
  }
}

/** Thin request/response wrapper. `send` resolves when a `FromWorker` message with a matching
 * `jobId` (or, for `ready`/`stats`, the next such message) arrives; if the worker dies first
 * (AC-7's "kill the perception worker mid-step"), every pending request rejects with
 * `WorkerTerminatedError` rather than hanging forever — the caller (builder/guard) is expected to
 * treat that as "no image, no vision candidates," never as a retryable transient error. */
export type WorkerProblem = { kind: 'crashed' } | { kind: 'error'; code: string };

export class PerceptionClient {
  private readonly pending = new Map<string, { resolve: (msg: FromWorker) => void; reject: (err: Error) => void }>();
  private readonly problemListeners: ((problem: WorkerProblem) => void)[] = [];
  private terminated = false;
  private terminatedByCaller = false;

  constructor(private readonly worker: WorkerLike) {
    this.worker.addEventListener('message', (event) => this.handleMessage(event.data));
    this.worker.addEventListener('error', () => this.handleTermination());
  }

  /** Jobless worker errors and worker crashes used to be dropped here with no trace — the panel
   * subscribes so a dead or failing perception path is visible instead of silently DOM-only. */
  onProblem(listener: (problem: WorkerProblem) => void): void {
    this.problemListeners.push(listener);
  }

  private notify(problem: WorkerProblem): void {
    for (const listener of this.problemListeners) listener(problem);
  }

  private handleMessage(msg: FromWorker): void {
    const jobId = 'jobId' in msg ? msg.jobId : undefined;
    if (jobId === undefined) {
      if (msg.t === 'error') this.notify({ kind: 'error', code: msg.code });
      return; // 'ready'/'stats' without a matching request are informational only
    }
    const entry = this.pending.get(jobId);
    if (!entry) return;
    this.pending.delete(jobId);
    if (msg.t === 'error') {
      entry.reject(new Error(msg.detail ?? msg.code));
    } else {
      entry.resolve(msg);
    }
  }

  private handleTermination(): void {
    if (!this.terminated && !this.terminatedByCaller) this.notify({ kind: 'crashed' });
    this.terminated = true;
    for (const entry of this.pending.values()) entry.reject(new WorkerTerminatedError());
    this.pending.clear();
  }

  private request(message: ToWorker & { jobId: string }, transfer?: Transferable[]): Promise<FromWorker> {
    if (this.terminated) return Promise.reject(new WorkerTerminatedError());
    return new Promise((resolve, reject) => {
      this.pending.set(message.jobId, { resolve, reject });
      this.worker.postMessage(message, transfer);
    });
  }

  /** `init` has no `jobId` (design.md §11.1 — it addresses the worker as a whole, not one job),
   * so it is correlated by message type instead, via a listener this method owns and removes
   * itself once `ready`/`error` arrives. Called once per session. */
  async init(backendPref: 'auto' | 'webgpu' | 'wasm', models: ModelSpec[], profile: 'S' | 'L'): Promise<Extract<FromWorker, { t: 'ready' }>> {
    return new Promise((resolve, reject) => {
      const onMessage = (event: MessageEvent<FromWorker>) => {
        if (event.data.t === 'ready') resolve(event.data);
        else if (event.data.t === 'error' && event.data.jobId === undefined) reject(new Error(event.data.detail ?? event.data.code));
        else return;
      };
      this.worker.addEventListener('message', onMessage);
      this.worker.postMessage({ t: 'init', backendPref, models, profile });
    });
  }

  async perceive(bitmap: ImageBitmap, regions: Extract<ToWorker, { t: 'perceive' }>['regions'], deadlineMs: number, fullFrame: boolean): Promise<Extract<FromWorker, { t: 'perceived' }>> {
    const jobId = nextJobId();
    const msg = await this.request({ t: 'perceive', jobId, bitmap, regions, deadlineMs, fullFrame }, [bitmap]);
    return msg as Extract<FromWorker, { t: 'perceived' }>;
  }

  async compose(
    regions: Extract<ToWorker, { t: 'compose' }>['regions'],
    cleared: Extract<ToWorker, { t: 'compose' }>['cleared'],
    scale: number,
    unlabelled = false,
  ): Promise<Extract<FromWorker, { t: 'composed' }>> {
    const jobId = nextJobId();
    const msg = await this.request({ t: 'compose', jobId, regions, cleared, scale, unlabelled });
    return msg as Extract<FromWorker, { t: 'composed' }>;
  }

  async rescan(image: ArrayBuffer, redactionBoxes: Extract<ToWorker, { t: 'rescan' }>['redactionBoxes'], halos: Extract<ToWorker, { t: 'rescan' }>['halos']): Promise<Extract<FromWorker, { t: 'rescanned' }>> {
    const jobId = nextJobId();
    const msg = await this.request({ t: 'rescan', jobId, image, redactionBoxes, halos });
    return msg as Extract<FromWorker, { t: 'rescanned' }>;
  }

  /** T-6.8: `chunks` are `builder.ts`'s `collectFreeTextSources()` output, keyed the same way
   * (`run:<id>`, `name:<id>`, `task`, `title`) so the caller can zip `nerResult.spans` straight
   * back onto `BuildContextInput.nerMatchesByKey` before calling `buildSanitizedContext`. Profile
   * S has no real model (see `pii-ner.ts`'s doc comment) — the worker still answers this call, it
   * just always returns `spans: []`; the caller does not need to know which profile is active. */
  async ner(chunks: Extract<ToWorker, { t: 'ner' }>['chunks']): Promise<Extract<FromWorker, { t: 'nerResult' }>> {
    const jobId = nextJobId();
    const msg = await this.request({ t: 'ner', jobId, chunks });
    return msg as Extract<FromWorker, { t: 'nerResult' }>;
  }

  terminate(): void {
    this.terminatedByCaller = true;
    this.worker.terminate();
    this.handleTermination();
  }
}
