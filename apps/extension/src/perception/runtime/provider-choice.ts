// Per-model execution-provider choice (WebGPU vs WASM), decided by measurement rather than by
// "WebGPU exists". Pure — no onnxruntime import — so the rules are unit-testable.
//
// Measured 2026-09-28 (docs/HISTORY.md), same onnxruntime-web 1.30 + bundled models, median of 5
// warm runs, 4 WASM threads:
//
//                     WASM    WebGPU Intel Xe-LPG (real)   WebGPU SwiftShader (CPU-emulated)
//   YuNet 640²         31 ms    54 ms                      2538 ms
//   CLIP int8 224²     92 ms   442 ms                       874 ms
//   OCR det 480×320   132 ms    35 ms                      2319 ms
//   OCR rec 48×320     32 ms    18 ms                      1116 ms
//
// So neither backend wins across the board: a real GPU is ~5x slower for the int8 CLIP encoder
// (its quantized MatMul ops have no WebGPU kernel and bounce through the CPU) and slower for YuNet,
// and a software adapter is 20-65x slower than WASM for everything. The OCR rows are isolated,
// fixed-shape numbers that did NOT hold in the real pipeline — see `probeShapeFor`.

import type { AdapterInfo, Backend } from '../../shared/worker-protocol';

/** Names Chromium/Dawn/Mesa give adapters that rasterize on the CPU. `isFallbackAdapter` is the
 * spec'd signal, but it is not exposed by every Chrome version, so the name check is kept too. */
const SOFTWARE_ADAPTER = /swiftshader|llvmpipe|lavapipe|softpipe|software|basic render|\bwarp\b/i;

export function softwareAdapterReason(info: AdapterInfo & { isFallbackAdapter?: boolean }): string | null {
  if (info.isFallbackAdapter) return `fallback adapter (${info.vendor} ${info.architecture})`.trim();
  const text = [info.vendor, info.architecture, info.device, info.description].join(' ');
  const match = SOFTWARE_ADAPTER.exec(text);
  return match ? `CPU-emulated adapter (${match[0].toLowerCase()})` : null;
}

/** WebGPU must be at least this much faster to be chosen: the timed probe runs on a warm session
 * with synthetic input, while real crops add CPU-side preprocessing and GPU readback per call, so a
 * marginal win in the probe is not a win in the pipeline. */
export const WEBGPU_MIN_SPEEDUP = 1.25;

export function chooseProvider(wasmMs: number | null, webgpuMs: number | null): Backend {
  if (webgpuMs === null) return 'wasm';
  if (wasmMs === null) return 'webgpu';
  return webgpuMs * WEBGPU_MIN_SPEEDUP <= wasmMs ? 'webgpu' : 'wasm';
}

/** Probe input per model role — only for fixed-input models, where the probe's shape IS every
 * real call's shape. `null` means "not probed, WASM". The OCR models take a different input size
 * for every crop/text line, and WebGPU compiles kernels per new shape: their fixed-shape probe said
 * WebGPU was ~4x faster (above), yet in the real pipeline (same Intel Xe-LPG, Chromium 153) OCR
 * took 292 ms on WebGPU vs 127 ms on WASM for the same crop, and 191 vs 102 ms on another. */
export function probeShapeFor(role: string): number[] | null {
  switch (role) {
    case 'face':
      return [1, 3, 640, 640];
    case 'vit':
      return [1, 3, 224, 224];
    default:
      return null;
  }
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}
