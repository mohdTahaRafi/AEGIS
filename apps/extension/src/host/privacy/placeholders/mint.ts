// design.md §7.3's `mint` step, adapted to also decide presence-only vs. placeholder per policy
// (T-3.14).

import type { Policy } from '@aegis/policy';
import { isPresenceOnly } from '@aegis/policy';
import type { Vault } from '../vault';
import type { SensitiveRegion } from '../types';

export type MintedValue =
  | { kind: 'presence'; entity: SensitiveRegion['entity']; len: number }
  | { kind: 'placeholder'; ref: string; entity: SensitiveRegion['entity']; len: number };

/** Presence-only entities (PASSWORD/OTP/CARD_NUMBER/CARD_CVV/SECRET) never get a ref — there is
 * no value to mint (the content script never read it). Everything else mints a ref keyed by
 * (entity, normalizedValue, origin) so repeated occurrences of the same value collapse to one
 * placeholder within the session (FR-27). */
export function mintForRegion(vault: Vault, policy: Policy, region: SensitiveRegion, originKey: string, stepId: string): MintedValue | undefined {
  if (region.presenceOnly || isPresenceOnly(policy, region.entity)) {
    return { kind: 'presence', entity: region.entity, len: region.value?.length ?? 0 };
  }
  if (region.value === undefined) return undefined; // nothing to mint (shouldn't happen for non-presence regions)
  const ref = vault.mint(region.entity, region.value, { originKey, stepId, class: region.class });
  return { kind: 'placeholder', ref, entity: region.entity, len: region.value.length };
}
