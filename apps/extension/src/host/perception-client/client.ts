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

/** A worker crash, a jobless worker error, a request the worker never answered, or a replacement
 * worker coming up — the panel shows each, so a failing perception path is never silent. */
export type WorkerProblem = { kind: 'crashed' } | { kind: 'error'; code: string } | { kind: 'timeout'; job: string } | { kind: 'restarted' };

/** Per-request ceilings: a worker that has not answered by then is presumed wedged (a stuck GPU
 * queue, a runaway model) and is replaced. */
const REQUEST_TIMEOUT_MS: Partial<Record<ToWorker['t'], number>> = { perceive: 45_000, compose: 15_000, rescan: 30_000, ner: 30_000 };
const INIT_TIMEOUT_MS = 120_000;
const RESPAWN_MIN_INTERVAL_MS = 3000;

type InitArgs = [backendPref: 'auto' | 'webgpu' | 'wasm', models: ModelSpec[], profile: 'S' | 'L'];

/** Thin request/response wrapper. A request resolves when a `FromWorker` message with a matching
 * `jobId` arrives; if the worker dies first (AC-7's "kill the perception worker mid-step"), every
 * pending request rejects with `WorkerTerminatedError` rather than hanging forever — the caller
 * treats that as "no image, no vision candidates" for that step.
 *
 * Built from a worker FACTORY (the panel does this), the client heals itself: a crashed or
 * unresponsive worker, or one whose `init` failed, is replaced by a fresh one initialised with the
 * same models on the next request — one bad step never costs the rest of the task its vision.
 * Built from a single worker (tests), a dead worker stays dead. */
export class PerceptionClient {
  private readonly pending = new Map<string, { resolve: (msg: FromWorker) => void; reject: (err: Error) => void }>();
  private readonly problemListeners: ((problem: WorkerProblem) => void)[] = [];
  private worker: WorkerLike;
  private readonly factory?: () => WorkerLike;
  private terminated = false;
  private terminatedByCaller = false;
  private initArgs: InitArgs | null = null;
  private ready = false;
  private recovering: Promise<void> | null = null;
  private lastRecoveryAt = 0;

  constructor(workerOrFactory: WorkerLike | (() => WorkerLike)) {
    if (typeof workerOrFactory === 'function') {
      this.factory = workerOrFactory;
      this.worker = workerOrFactory();
    } else {
      this.worker = workerOrFactory;
    }
    this.listen(this.worker);
  }

  private listen(worker: WorkerLike): void {
    worker.addEventListener('message', (event) => {
      if (worker === this.worker) this.handleMessage(event.data);
    });
    worker.addEventListener('error', () => {
      if (worker === this.worker) this.handleTermination();
    });
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
    this.ready = false;
    for (const entry of this.pending.values()) entry.reject(new WorkerTerminatedError());
    this.pending.clear();
  }

  /** A fresh worker (after a crash or a hang), or another try at an `init` that failed; at most one
   * attempt per `RESPAWN_MIN_INTERVAL_MS`. Rejects if it still cannot initialise. */
  private recover(): Promise<void> {
    if (!this.recovering) {
      this.recovering = (async () => {
        const wait = this.lastRecoveryAt + RESPAWN_MIN_INTERVAL_MS - Date.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        this.lastRecoveryAt = Date.now();
        if (this.terminated && this.factory) {
          try {
            this.worker.terminate();
          } catch {
            // already gone
          }
          this.worker = this.factory();
          this.terminated = false;
          this.listen(this.worker);
        }
        if (this.initArgs) await this.init(...this.initArgs);
        this.notify({ kind: 'restarted' });
      })().finally(() => {
        this.recovering = null;
      });
    }
    return this.recovering;
  }

  private async request(message: ToWorker & { jobId: string }, transfer?: Transferable[]): Promise<FromWorker> {
    if (this.terminatedByCaller) throw new WorkerTerminatedError();
    if (this.terminated && !this.factory) throw new WorkerTerminatedError();
    if (this.factory && (this.terminated || (this.initArgs && !this.ready))) await this.recover();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(message.jobId)) return;
        this.notify({ kind: 'timeout', job: message.t });
        if (this.factory) {
          // Presumed wedged: every pending job fails now, and the next request gets a new worker.
          try {
            this.worker.terminate();
          } catch {
            // already gone
          }
          this.handleTermination();
        } else {
          this.pending.delete(message.jobId);
          reject(new WorkerTerminatedError());
        }
      }, REQUEST_TIMEOUT_MS[message.t] ?? 30_000);
      this.pending.set(message.jobId, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.worker.postMessage(message, transfer);
    });
  }

  /** `init` has no `jobId` (design.md §11.1 — it addresses the worker as a whole, not one job),
   * so it is correlated by message type instead. Its arguments are kept, so a replacement worker
   * is initialised exactly the same way. */
  async init(backendPref: 'auto' | 'webgpu' | 'wasm', models: ModelSpec[], profile: 'S' | 'L'): Promise<Extract<FromWorker, { t: 'ready' }>> {
    this.initArgs = [backendPref, models, profile];
    const worker = this.worker;
    const ready = await new Promise<Extract<FromWorker, { t: 'ready' }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('INIT_TIMEOUT')), INIT_TIMEOUT_MS);
      worker.addEventListener('message', (event: MessageEvent<FromWorker>) => {
        if (event.data.t === 'ready') {
          clearTimeout(timer);
          resolve(event.data);
        } else if (event.data.t === 'error' && event.data.jobId === undefined) {
          clearTimeout(timer);
          reject(new Error(event.data.detail ?? event.data.code));
        }
      });
      worker.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new WorkerTerminatedError());
      });
      worker.postMessage({ t: 'init', backendPref, models, profile });
    });
    if (worker === this.worker) this.ready = true;
    return ready;
  }

  /** True once `init` has succeeded on the current worker. */
  isReady(): boolean {
    return this.ready && !this.terminated;
  }

  async perceive(bitmap: ImageBitmap, regions: Extract<ToWorker, { t: 'perceive' }>['regions'], deadlineMs: number, fullFrame: boolean, textBoxes?: Extract<ToWorker, { t: 'perceive' }>['textBoxes']): Promise<Extract<FromWorker, { t: 'perceived' }>> {
    const jobId = nextJobId();
    const msg = await this.request({ t: 'perceive', jobId, bitmap, regions, deadlineMs, fullFrame, ...(textBoxes ? { textBoxes } : {}) }, [bitmap]);
    return msg as Extract<FromWorker, { t: 'perceived' }>;
  }

  async compose(
    regions: Extract<ToWorker, { t: 'compose' }>['regions'],
    cleared: Extract<ToWorker, { t: 'compose' }>['cleared'],
    scale: number,
    unlabelled = false,
    options: { clearDefault?: boolean; grey?: Extract<ToWorker, { t: 'compose' }>['grey'] } = {},
  ): Promise<Extract<FromWorker, { t: 'composed' }>> {
    const jobId = nextJobId();
    const msg = await this.request({ t: 'compose', jobId, regions, cleared, scale, unlabelled, ...(options.clearDefault ? { clearDefault: true, grey: options.grey ?? [] } : {}) });
    return msg as Extract<FromWorker, { t: 'composed' }>;
  }

  async rescan(image: ArrayBuffer, redactionBoxes: Extract<ToWorker, { t: 'rescan' }>['redactionBoxes'], halos: Extract<ToWorker, { t: 'rescan' }>['halos'], scale = 1): Promise<Extract<FromWorker, { t: 'rescanned' }>> {
    const jobId = nextJobId();
    const msg = await this.request({ t: 'rescan', jobId, image, redactionBoxes, halos, scale });
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
