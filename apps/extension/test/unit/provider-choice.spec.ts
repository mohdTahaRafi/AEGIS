// WebGPU vs WASM is decided per model by measurement, and a CPU-emulated adapter is never used.
// The timings below are the real 2026-09-28 medians recorded in provider-choice.ts's header.
import { describe, expect, it } from 'vitest';
import { chooseProvider, probeShapeFor, softwareAdapterReason } from '../../src/perception/runtime/provider-choice';

const info = (vendor: string, architecture: string, description = '') => ({ vendor, architecture, device: '', description });

describe('softwareAdapterReason', () => {
  it('refuses SwiftShader (what headless Chromium hands out)', () => {
    expect(softwareAdapterReason(info('google', 'swiftshader'))).toMatch(/swiftshader/);
  });
  it('refuses anything flagged isFallbackAdapter, whatever its name', () => {
    expect(softwareAdapterReason({ ...info('google', 'unknown'), isFallbackAdapter: true })).toMatch(/fallback/);
  });
  it.each([info('mesa', 'llvmpipe'), info('microsoft', '', 'Microsoft Basic Render Driver'), info('mesa', 'lavapipe')])('refuses %o', (i) => {
    expect(softwareAdapterReason(i)).not.toBeNull();
  });
  it('accepts a real GPU', () => {
    expect(softwareAdapterReason(info('intel', 'xe-lpg'))).toBeNull();
    expect(softwareAdapterReason(info('nvidia', 'ampere'))).toBeNull();
    expect(softwareAdapterReason(info('apple', 'metal-3'))).toBeNull();
  });
});

describe('chooseProvider — measured, per model', () => {
  it('OCR det on a real Intel GPU (35 ms vs 132 ms WASM) → webgpu', () => {
    expect(chooseProvider(132, 35)).toBe('webgpu');
  });
  it('int8 CLIP on the same GPU (442 ms vs 92 ms WASM) → wasm', () => {
    expect(chooseProvider(92, 442)).toBe('wasm');
  });
  it('YuNet (54 ms vs 31 ms WASM) → wasm', () => {
    expect(chooseProvider(31, 54)).toBe('wasm');
  });
  it('a marginal WebGPU win is not enough (100 vs 90) → wasm', () => {
    expect(chooseProvider(100, 90)).toBe('wasm');
  });
  it('a provider that failed to create or run loses', () => {
    expect(chooseProvider(50, null)).toBe('wasm');
    expect(chooseProvider(null, 50)).toBe('webgpu');
    expect(chooseProvider(null, null)).toBe('wasm');
  });
});

describe('probeShapeFor', () => {
  it('probes fixed-input models at their real input size', () => {
    expect(probeShapeFor('face')).toEqual([1, 3, 640, 640]);
    expect(probeShapeFor('vit')).toEqual([1, 3, 224, 224]);
  });
  it('does not probe dynamic-shape OCR (stays WASM): its fixed-shape probe was contradicted in the real pipeline', () => {
    expect(probeShapeFor('ocr-det')).toBeNull();
    expect(probeShapeFor('ocr-rec')).toBeNull();
    expect(probeShapeFor('ner')).toBeNull();
  });
});
