import { describe, expect, it } from 'vitest';
import type { Policy } from '@aegis/policy';
import {
  applyAlwaysRedact,
  defaultSettings,
  loadSettings,
  saveSettings,
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
