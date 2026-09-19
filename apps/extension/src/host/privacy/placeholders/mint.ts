// design.md §7.3's `mint` step, adapted to also decide presence-only vs. placeholder per policy
// (T-3.14).

import type { Policy } from '@aegis/policy';
import { isPresenceOnly } from '@aegis/policy';
import type { Vault } from '../vault';
import type { SensitiveRegion } from '../types';

export type MintedValue =
  | { kind: 'presence'; entity: SensitiveRegion['entity']; len: number }
  | { kind: 'placeholder'; ref: string; entity: SensitiveRegion['entity']; len: number }
  /** T-6.12 (FR-36): this region's own ref was previously un-redacted for this session
   * (`Session.unredact()`) — sent as plain text instead of a placeholder, the one de-escalation
   * path design.md §7.1 step 9 names besides a versioned policy allow-rule. */
  | { kind: 'text'; text: string; entity: SensitiveRegion['entity'] };

/** Presence-only entities (PASSWORD/OTP/CARD_NUMBER/CARD_CVV/SECRET) never get a ref — there is
 * no value to mint (the content script never read it). Everything else mints a ref keyed by
 * (entity, normalizedValue, origin) so repeated occurrences of the same value collapse to one
 * placeholder within the session (FR-27). `unredactedRefs` is checked AFTER minting (never
 * before): `vault.mint` is deterministic per (entity, normalizedValue, originKey), so the ref a
 * previously-un-redacted value mints to today is guaranteed to be the SAME ref the user actually
 * un-redacted, without this function needing to know anything about how that ref was computed. */
export function mintForRegion(
  vault: Vault,
  policy: Policy,
  region: SensitiveRegion,
  originKey: string,
  stepId: string,
  unredactedRefs?: ReadonlySet<string>,
): MintedValue | undefined {
  if (region.presenceOnly || isPresenceOnly(policy, region.entity)) {
    return { kind: 'presence', entity: region.entity, len: region.value?.length ?? 0 };
  }
  if (region.value === undefined) return undefined; // nothing to mint (shouldn't happen for non-presence regions)
  const ref = vault.mint(region.entity, region.value, { originKey, stepId, class: region.class });
  if (unredactedRefs?.has(ref)) return { kind: 'text', text: region.value, entity: region.entity };
  return { kind: 'placeholder', ref, entity: region.entity, len: region.value.length };
}
