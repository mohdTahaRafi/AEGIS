import { describe, expect, it } from 'vitest';
import type { Policy } from '@aegis/policy';
import {
  applyAlwaysRedact,
  defaultSettings,
  loadSettings,
  saveSettings,
  cleanApiKey,
  looksLikeApiKey,
  resolveModelConfig,
  type Settings,
  type SettingsStorageArea,
} from '../../src/host/settings/store';

function fakeStorage(initial: Record<string, unknown> = {}): SettingsStorageArea & { data: Record<string, unknown> } {
  const data = { ...initial };
  return {
    data,
    get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
    set: async (items: Record<string, unknown>) => {
      Object.assign(data, items);
    },
  };
}

describe('defaultSettings (T-6.11, design.md §13.5)', () => {
  it('uses the build-time server URL/token and every documented default', () => {
    const d = defaultSettings('https://gw.example', 'tok-123');
    expect(d).toEqual({
      apiKey: '',
      modelUrl: 'https://api.groq.com/openai/v1',
      modelName: 'qwen/qwen3.8-27b',
      serverUrl: 'https://gw.example',
      accessToken: 'tok-123',
      backend: 'auto',
      nerProfile: 'S',
      policyId: 'default',
      debugOverlay: false,
      showRawPayload: true,
      alwaysRedact: {},
    });
  });
});

describe('loadSettings', () => {
  it('returns the given defaults when nothing is stored', async () => {
    const defaults = defaultSettings('https://gw.example', 'tok');
    expect(await loadSettings(fakeStorage(), defaults)).toEqual(defaults);
  });

  it('returns the given defaults when the stored value is malformed', async () => {
    const defaults = defaultSettings('https://gw.example', 'tok');
    expect(await loadSettings(fakeStorage({ aegis_settings: 'not-an-object' }), defaults)).toEqual(defaults);
    expect(await loadSettings(fakeStorage({ aegis_settings: null }), defaults)).toEqual(defaults);
  });

  it('round-trips a full settings object through save/load', async () => {
    const storage = fakeStorage();
    const defaults = defaultSettings('https://gw.example', 'tok');
    const saved: Settings = { ...defaults, backend: 'webgpu', nerProfile: 'L', debugOverlay: true, alwaysRedact: { EMAIL: true } };
    await saveSettings(storage, saved);
    expect(await loadSettings(storage, defaults)).toEqual(saved);
  });

  it('fills a missing field from defaults, not undefined — an older saved blob stays usable after a new field is added', async () => {
    const defaults = defaultSettings('https://gw.example', 'tok');
    const storage = fakeStorage({ aegis_settings: { serverUrl: 'https://custom', backend: 'wasm' } });
    const loaded = await loadSettings(storage, defaults);
    expect(loaded.serverUrl).toBe('https://custom');
    expect(loaded.backend).toBe('wasm');
    expect(loaded.nerProfile).toBe('S');
    expect(loaded.alwaysRedact).toEqual({});
  });
});

const BASE_POLICY: Policy = {
  id: 'default',
  version: '1',
  classes: {
    CRITICAL: { threshold: 0, operator: 'placeholder', rehydrate: 'confirm' },
    HIGH: { threshold: 0, operator: 'placeholder', rehydrate: 'confirm' },
    MEDIUM: { threshold: 0, operator: 'placeholder_or_fill', rehydrate: 'n/a' },
    LOW: { threshold: 0, operator: 'pass', rehydrate: 'n/a' },
  },
  entityClass: { CITY: 'LOW', EMAIL: 'HIGH' },
  presenceOnly: [],
  partialDisclosure: {},
  crossOriginRehydration: 'deny',
  allowRules: [],
  riskRules: { confirm: [] },
};

describe('applyAlwaysRedact (T-6.11 Tier-2 per-type override)', () => {
  it('returns the same policy reference when there is nothing to override', () => {
    expect(applyAlwaysRedact(BASE_POLICY, {})).toBe(BASE_POLICY);
  });

  it('forces an overridden entity to CRITICAL, leaving every other entity and field untouched', () => {
    const result = applyAlwaysRedact(BASE_POLICY, { CITY: true });
    expect(result.entityClass.CITY).toBe('CRITICAL');
    expect(result.entityClass.EMAIL).toBe('HIGH');
    expect(result).not.toBe(BASE_POLICY);
    expect(result.classes).toBe(BASE_POLICY.classes);
  });

  it('ignores an entity explicitly set to false — "follow policy"', () => {
    const result = applyAlwaysRedact(BASE_POLICY, { CITY: false });
    expect(result).toBe(BASE_POLICY);
  });
});

describe('bring your own key', () => {
  it('starts with no key, and a saved key survives a reload of the settings', async () => {
    const storage = fakeStorage();
    const defaults = defaultSettings('', '');
    expect((await loadSettings(storage, defaults)).apiKey).toBe('');
    await saveSettings(storage, { ...defaults, apiKey: 'gsk_abcdefghijklmnopqrstuvwxyz' });
    expect((await loadSettings(storage, defaults)).apiKey).toBe('gsk_abcdefghijklmnopqrstuvwxyz');
  });

  it('a settings blob saved before keys existed still loads, with no key', async () => {
    const storage = fakeStorage({ aegis_settings: { serverUrl: 'http://x', backend: 'wasm' } });
    const loaded = await loadSettings(storage, defaultSettings('', ''));
    expect(loaded.apiKey).toBe('');
    expect(loaded.backend).toBe('wasm');
  });

  it('cleans copy-paste noise off a key', () => {
    expect(cleanApiKey('  "gsk_abc123"  ')).toBe('gsk_abc123');
    expect(cleanApiKey("Bearer gsk_abc123\n")).toBe('gsk_abc123');
  });

  it('checks the shape of a key only loosely (Test key is what proves it)', () => {
    expect(looksLikeApiKey('gsk_' + 'a'.repeat(48))).toBe(true);
    expect(looksLikeApiKey('short')).toBe(false);
    expect(looksLikeApiKey('has space in the key of some length')).toBe(false);
  });

  it('a release build always talks to Groq, whatever endpoint is stored; a development build honours it', () => {
    const settings: Settings = { ...defaultSettings('', ''), apiKey: 'gsk_k', modelUrl: 'http://evil.example/v1', modelName: 'other' };
    expect(resolveModelConfig(settings, true)).toEqual({ apiKey: 'gsk_k', baseUrl: 'https://api.groq.com/openai/v1', model: 'qwen/qwen3.8-27b' });
    expect(resolveModelConfig(settings, false)).toEqual({ apiKey: 'gsk_k', baseUrl: 'http://evil.example/v1', model: 'other' });
  });
});
