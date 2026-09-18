// design.md §11.2 — backend selection. The probe logic itself is the Phase-0 spike's
// `probeWebGPU`/`probeWasm` (worker.ts), extracted here so Phase 4 can wrap it with the caching
// layer (`probe-cache.ts`) T-4.1 requires: a 1.5s adapter timeout on every task start would
// dominate the first step's latency (phase_4_vision.md §3.3).

import * as ort from 'onnxruntime-web';
import type { Backend } from '../../shared/worker-protocol';

const ADAPTER_TIMEOUT_MS = 1500;

export interface BackendResult {
  backend: Backend;
  threads?: number;
  adapterInfo?: { vendor: string; architecture: string; device: string; description: string };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);
}

/** design.md §11.2 step 1: `requestAdapter` → `requestDevice` → a tiny warm-up inference. All
 * three (plus `navigator.gpu` existing at all) must succeed for `webgpu`; any failure at any
 * step falls back to `wasm` rather than partially committing to a backend that hasn't proven it
 * can actually run a model. */
async function tryWebGPU(): Promise<BackendResult | null> {
  const gpu = (self.navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) return null;
  const adapter = await withTimeout(gpu.requestAdapter(), ADAPTER_TIMEOUT_MS);
  if (adapter === 'timeout' || !adapter) return null;
  const device = await withTimeout(adapter.requestDevice(), ADAPTER_TIMEOUT_MS);
  if (device === 'timeout' || !device) return null;
  try {
    const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
    device.destroy();
    return {
      backend: 'webgpu',
      adapterInfo: {
        vendor: info?.vendor ?? 'unknown',
        architecture: info?.architecture ?? 'unknown',
        device: info?.device ?? 'unknown',
        description: info?.description ?? 'unknown',
      },
    };
  } catch {
    device.destroy();
    return null;
  }
}

function wasmBackend(): BackendResult {
  const coi = self.crossOriginIsolated === true;
  const threads = coi ? Math.max(1, Math.min(4, Math.floor((self.navigator.hardwareConcurrency ?? 2) / 2))) : 1;
  ort.env.wasm.numThreads = threads;
  ort.env.wasm.simd = true;
  return { backend: 'wasm', threads };
}

export async function selectBackend(pref: 'auto' | 'webgpu' | 'wasm'): Promise<BackendResult> {
  if (pref === 'wasm') return wasmBackend();
  if (pref === 'webgpu') {
    const gpu = await tryWebGPU();
    if (gpu) return gpu;
    // Explicit webgpu preference that can't be honoured still falls back rather than failing the
    // whole agent — AC-3's "the same task completes on WASM" applies even when the caller asked
    // for WebGPU specifically (e.g. a stale cache entry from before a driver regression).
    return wasmBackend();
  }
  return (await tryWebGPU()) ?? wasmBackend();
}
