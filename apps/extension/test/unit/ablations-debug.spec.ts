import { describe, expect, it } from 'vitest';
import { ABLATION_STORAGE_KEY, currentAblationArm } from '../../src/debug/ablations';

function storageWith(value: unknown) {
  return { get: async (key: string) => (key === ABLATION_STORAGE_KEY ? { [ABLATION_STORAGE_KEY]: value } : {}) };
}

describe('currentAblationArm (T-6.9)', () => {
  it('defaults to fused when nothing is stored', async () => {
    expect(await currentAblationArm(storageWith(undefined))).toBe('fused');
  });

  it('returns a recognised stored arm', async () => {
    expect(await currentAblationArm(storageWith('pixel_only'))).toBe('pixel_only');
    expect(await currentAblationArm(storageWith('dom_only'))).toBe('dom_only');
    expect(await currentAblationArm(storageWith('blackbox'))).toBe('blackbox');
    expect(await currentAblationArm(storageWith('fused'))).toBe('fused');
  });

  it('falls back to fused for a typo\'d or stale value — never silently disables protection', async () => {
    expect(await currentAblationArm(storageWith('pixel-only'))).toBe('fused');
    expect(await currentAblationArm(storageWith(123))).toBe('fused');
    expect(await currentAblationArm(storageWith(null))).toBe('fused');
  });
});
