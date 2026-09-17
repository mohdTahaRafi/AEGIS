/**
 * Phase-0 spike protocol for `worker.ts`'s probe/bench messages. Replaced by the real worker
 * interface (design §11.1) in Phase 4. Moved out of `src/shared/` in Phase 2 (T-2.1): these types
 * are perception-worker-internal, not a cross-context contract, and `src/shared/` no longer
 * carries anything named "spike" per that task's AC.
 */

export type Backend = 'webgpu' | 'wasm';

export interface BackendProbe {
  backend: Backend;
  available: boolean;
  /** Reason the backend was rejected, as a closed-vocabulary code. */
  reason?: 'no_navigator_gpu' | 'no_adapter' | 'no_device' | 'warmup_failed' | 'timeout' | 'init_failed';
  adapter?: { vendor: string; architecture: string; device: string; description: string };
  /** SIMD and threads apply to the WASM backend only. */
  simd?: boolean;
  threads?: number;
  crossOriginIsolated?: boolean;
  probeMs: number;
}

export interface BenchResult {
  backend: Backend;
  model: string;
  /** Inference runs contributing to the statistics, excluding warm-up. */
  n: number;
  warmupMs: number;
  loadMs: number;
  p50Ms: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  inputShape: number[];
}

export interface SpikeEnvironment {
  userAgent: string;
  hardwareConcurrency: number;
  deviceMemoryGB: number | null;
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  offscreenCanvas: boolean;
  workerContext: boolean;
}

export type ToWorker =
  | { t: 'probe' }
  | { t: 'bench'; backend: Backend; modelUrl: string; model: string; runs: number };

export type FromWorker =
  | { t: 'env'; env: SpikeEnvironment }
  | { t: 'probed'; probes: BackendProbe[] }
  | { t: 'benched'; result: BenchResult }
  | { t: 'error'; code: string; detail: string };
