import { describe, expect, it } from 'vitest';
import { adapterKeyOf, browserVersionOf, readProbeCache, writeProbeCache, type StorageArea } from '../../src/host/perception-client/probe-cache';

function fakeStorage(): StorageArea {
  const store = new Map<string, unknown>();
  return {
    get: async (key) => (store.has(key) ? { [key]: store.get(key) } : {}),
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    },
  };
}

describe('browserVersionOf', () => {
  it('extracts a Chrome version token', () => {
    expect(browserVersionOf('Mozilla/5.0 Chrome/128.0.0.0 Safari/537.36')).toBe('Chrome/128.0.0.0');
  });

  it('falls back to unknown for an unrecognized UA', () => {
    expect(browserVersionOf('SomeWeirdBrowser/1.0')).toBe('unknown');
  });
});

describe('adapterKeyOf', () => {
  it('is "none" when there is no adapter info (wasm backend)', () => {
    expect(adapterKeyOf(undefined)).toBe('none');
  });

  it('combines vendor/architecture/device', () => {
    expect(adapterKeyOf({ vendor: 'v', architecture: 'a', device: 'd', description: 'x' })).toBe('v|a|d');
  });
});

describe('readProbeCache / writeProbeCache (T-4.1)', () => {
  it('returns null when nothing is cached', async () => {
    expect(await readProbeCache(fakeStorage(), 'Chrome/128.0.0.0')).toBeNull();
  });

  it('round-trips a written entry', async () => {
    const storage = fakeStorage();
    await writeProbeCache(storage, { browserVersion: 'Chrome/128.0.0.0', adapterKey: 'v|a|d', backend: 'webgpu', cachedAt: 1000 });
    const entry = await readProbeCache(storage, 'Chrome/128.0.0.0');
    expect(entry?.backend).toBe('webgpu');
  });

  it('invalidates the cache across a browser version change', async () => {
    const storage = fakeStorage();
    await writeProbeCache(storage, { browserVersion: 'Chrome/128.0.0.0', adapterKey: 'none', backend: 'wasm', cachedAt: 1000 });
    expect(await readProbeCache(storage, 'Chrome/129.0.0.0')).toBeNull();
  });
});
