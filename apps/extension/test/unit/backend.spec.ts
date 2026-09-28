// @vitest-environment jsdom
// T-6.1/T-6.2 — Firefox has no cross-origin-isolation headers (wxt.config.ts only sets COEP/COOP
// for `browser === 'chrome'`), so `self.crossOriginIsolated` is false there at runtime and
// `wasmBackend()` must fall back to a single WASM thread — this was implemented but, until now,
// never actually asserted by a test. This is the runtime half of "single-thread WASM" (design §14);
// wxt.config.ts's manifest-level half (no COEP/COOP for firefox) is asserted by manifest.spec.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('wasmBackend — single-thread fallback (T-6.1)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('uses exactly 1 thread when crossOriginIsolated is false (Firefox — no COEP/COOP)', async () => {
    vi.stubGlobal('crossOriginIsolated', false);
    vi.stubGlobal('navigator', { ...globalThis.navigator, hardwareConcurrency: 8 });
    const { selectBackend } = await import('../../src/perception/runtime/backend');
    const result = await selectBackend('wasm');
    expect(result.backend).toBe('wasm');
    expect(result.threads).toBe(1);
  });

  it('uses more than 1 thread when crossOriginIsolated is true (Chrome — COEP/COOP set)', async () => {
    vi.stubGlobal('crossOriginIsolated', true);
    vi.stubGlobal('navigator', { ...globalThis.navigator, hardwareConcurrency: 8 });
    const { selectBackend } = await import('../../src/perception/runtime/backend');
    const result = await selectBackend('wasm');
    expect(result.backend).toBe('wasm');
    expect(result.threads).toBeGreaterThan(1);
  });
});

describe('selectBackend — WebGPU adapter screening', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  function stubAdapter(info: Record<string, unknown>) {
    const destroy = vi.fn();
    const adapter = { info, requestDevice: vi.fn(async () => ({ destroy })) };
    vi.stubGlobal('navigator', { ...globalThis.navigator, hardwareConcurrency: 8, gpu: { requestAdapter: vi.fn(async () => adapter) } });
    return adapter;
  }

  it('refuses a CPU-emulated adapter under auto and under an explicit webgpu preference', async () => {
    stubAdapter({ vendor: 'google', architecture: 'swiftshader', device: '', description: '', isFallbackAdapter: true });
    const { selectBackend } = await import('../../src/perception/runtime/backend');
    for (const pref of ['auto', 'webgpu'] as const) {
      const r = await selectBackend(pref);
      expect(r.backend).toBe('wasm');
      expect(r.providerPolicy).toBe('wasm');
      expect(r.webgpuRejected).toMatch(/fallback|swiftshader/);
    }
  });

  it('accepts a hardware adapter under auto with per-model measurement, not blanket WebGPU', async () => {
    stubAdapter({ vendor: 'intel', architecture: 'xe-lpg', device: '', description: '' });
    const { selectBackend } = await import('../../src/perception/runtime/backend');
    const r = await selectBackend('auto');
    expect(r.backend).toBe('webgpu');
    expect(r.providerPolicy).toBe('measure');
    expect(r.threads).toBeGreaterThanOrEqual(1);
  });

  it('an explicit webgpu preference on a hardware adapter forces WebGPU for every model', async () => {
    stubAdapter({ vendor: 'intel', architecture: 'xe-lpg', device: '', description: '' });
    const { selectBackend } = await import('../../src/perception/runtime/backend');
    expect((await selectBackend('webgpu')).providerPolicy).toBe('webgpu');
  });
});
