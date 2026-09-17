import { describe, expect, it } from 'vitest';
import { loadPolicy, defaultPolicy, PolicyValidationError } from '../src/loader';
import { bandFloor, entityClass, isPresenceOnly, requiresRiskConfirmation, threshold } from '../src/accessors';

// T-3.6
describe('loadPolicy', () => {
  it('validates and loads the bundled default policy without throwing', () => {
    expect(defaultPolicy.id).toBe('default');
    expect(defaultPolicy.version).toBe('2026.09.1');
  });

  it('fails loudly on a missing required field', () => {
    const broken = { ...defaultPolicy } as Record<string, unknown>;
    delete broken.classes;
    expect(() => loadPolicy(broken)).toThrow(PolicyValidationError);
  });

  it('fails loudly on a threshold outside 0..1', () => {
    const broken = JSON.parse(JSON.stringify(defaultPolicy));
    broken.classes.CRITICAL.threshold = 1.5;
    expect(() => loadPolicy(broken)).toThrow(PolicyValidationError);
  });

  it('fails loudly on an unknown entity in entityClass', () => {
    const broken = JSON.parse(JSON.stringify(defaultPolicy));
    broken.entityClass.NOT_A_REAL_ENTITY = 'HIGH';
    expect(() => loadPolicy(broken)).toThrow(PolicyValidationError);
  });

  it('fails loudly on an additional, unspecified top-level property', () => {
    const broken = { ...defaultPolicy, extra: true };
    expect(() => loadPolicy(broken)).toThrow(PolicyValidationError);
  });

  it('never silently returns a default when given something invalid', () => {
    try {
      loadPolicy({});
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PolicyValidationError);
    }
  });
});

// T-3.7 — policy engine: everything read from data
describe('policy engine reads all decisions from data', () => {
  it('entityClass/threshold reflect the bundled default policy', () => {
    expect(entityClass(defaultPolicy, 'AADHAAR')).toBe('CRITICAL');
    expect(entityClass(defaultPolicy, 'IFSC')).toBe('MEDIUM');
    expect(threshold(defaultPolicy, 'CRITICAL')).toBe(0.3);
    expect(bandFloor(defaultPolicy, 'CRITICAL')).toBeCloseTo(0.15);
  });

  it('presence-only list comes from data', () => {
    expect(isPresenceOnly(defaultPolicy, 'PASSWORD')).toBe(true);
    expect(isPresenceOnly(defaultPolicy, 'EMAIL')).toBe(false);
  });

  it('risk confirm rules come from data', () => {
    expect(requiresRiskConfirmation(defaultPolicy, 'send')).toBe(true);
    expect(requiresRiskConfirmation(defaultPolicy, 'read')).toBe(false);
  });

  it('changing a threshold in the policy object changes behaviour with no code change', () => {
    const custom = JSON.parse(JSON.stringify(defaultPolicy));
    custom.classes.HIGH.threshold = 0.99;
    const loaded = loadPolicy(custom);
    expect(threshold(loaded, 'HIGH')).toBe(0.99);
    expect(threshold(defaultPolicy, 'HIGH')).toBe(0.5); // the original is untouched
  });
});
