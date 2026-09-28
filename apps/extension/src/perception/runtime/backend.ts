// design.md §11.2 — backend selection. The probe logic itself is the Phase-0 spike's
// `probeWebGPU`/`probeWasm` (worker.ts), extracted here so Phase 4 can wrap it with the caching
// layer (`probe-cache.ts`) T-4.1 requires: a 1.5s adapter timeout on every task start would
// dominate the first step's latency (phase_4_vision.md §3.3).
//
// 2026-09-28: "WebGPU available" no longer means "use WebGPU". A CPU-emulated adapter is refused
// outright, and on a real one each model's provider is chosen by a load-time timing probe — see
// `provider-choice.ts` for the measurements behind both rules.

import * as ort from 'onnxruntime-web';
import type { AdapterInfo, Backend } from '../../shared/worker-protocol';
import { softwareAdapterReason } from './provider-choice';

const ADAPTER_TIMEOUT_MS = 1500;

export interface BackendResult {
  /** `'webgpu'`: a hardware adapter was accepted — each model then runs on whichever provider its
   * load-time probe measured faster (`ModelRegistry`, `provider-choice.ts`). `'wasm'`: every model
   * runs on WASM. */
  backend: Backend;
  /** `'measure'` for `auto` on a hardware adapter, `'webgpu'` when the user forced WebGPU. */
  providerPolicy: ProviderPolicy;
  threads?: number;
  adapterInfo?: AdapterInfo;
  /** Why an adapter that exists was not used (CPU-emulated/fallback), for the UI. */
  webgpuRejected?: string;
}

export type ProviderPolicy = 'wasm' | 'measure' | 'webgpu';

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);
}

/** design.md §11.2 step 1: `requestAdapter` → `requestDevice`. Both (plus `navigator.gpu` existing
 * at all) must succeed; a software/fallback adapter is reported with `rejected` set rather than
 * accepted — measured 20-65x slower than WASM on this project's models (`provider-choice.ts`), which
 * turned every perceive call into a 13-33 s stall in headless Chromium. */
async function tryWebGPU(): Promise<{ adapterInfo: AdapterInfo; rejected: string | null } | null> {
  const gpu = (self.navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) return null;
  const adapter = await withTimeout(gpu.requestAdapter({ powerPreference: 'high-performance' }), ADAPTER_TIMEOUT_MS);
  if (adapter === 'timeout' || !adapter) return null;
  const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo & { isFallbackAdapter?: boolean } }).info;
  const adapterInfo: AdapterInfo = {
    vendor: info?.vendor ?? 'unknown',
    architecture: info?.architecture ?? 'unknown',
    device: info?.device ?? 'unknown',
    description: info?.description ?? 'unknown',
  };
  const isFallbackAdapter = info?.isFallbackAdapter ?? (adapter as GPUAdapter & { isFallbackAdapter?: boolean }).isFallbackAdapter ?? false;
  const rejected = softwareAdapterReason({ ...adapterInfo, isFallbackAdapter });
  if (rejected) return { adapterInfo, rejected };
  const device = await withTimeout(adapter.requestDevice(), ADAPTER_TIMEOUT_MS);
  if (device === 'timeout' || !device) return null;
  device.destroy();
  return { adapterInfo, rejected: null };
}

/** Always configured — even when WebGPU is accepted, any model whose probe measured WASM faster
 * runs on it. */
function configureWasm(): number {
  const coi = self.crossOriginIsolated === true;
  const threads = coi ? Math.max(1, Math.min(4, Math.floor((self.navigator.hardwareConcurrency ?? 2) / 2))) : 1;
  ort.env.wasm.numThreads = threads;
  ort.env.wasm.simd = true;
  return threads;
}

export async function selectBackend(pref: 'auto' | 'webgpu' | 'wasm'): Promise<BackendResult> {
  const threads = configureWasm();
  if (pref === 'wasm') return { backend: 'wasm', providerPolicy: 'wasm', threads };
  // An explicit `webgpu` preference that can't be honoured still falls back rather than failing
  // the whole agent — AC-3's "the same task completes on WASM". A CPU-emulated adapter is refused
  // under either preference: it is never faster than WASM, only slower.
  const gpu = await tryWebGPU();
  if (!gpu) return { backend: 'wasm', providerPolicy: 'wasm', threads };
  if (gpu.rejected) return { backend: 'wasm', providerPolicy: 'wasm', threads, adapterInfo: gpu.adapterInfo, webgpuRejected: gpu.rejected };
  return { backend: 'webgpu', providerPolicy: pref === 'webgpu' ? 'webgpu' : 'measure', threads, adapterInfo: gpu.adapterInfo };
}
