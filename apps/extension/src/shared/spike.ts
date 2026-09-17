/**
 * Phase-0 spike protocol. Replaced by the real worker interface (design §11.1) in Phase 4.
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
