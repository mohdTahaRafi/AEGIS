// phase_2_spine.md §8 (T-2.25) — the `GuardedPayload` brand exists from day one so the egress
// client's contract is already "only guard output," and Phase 3 swaps the guard implementation
// without introducing the concept then. Belt and suspenders, per the AC: a TypeScript brand (a
// unique symbol property, erased at runtime — a plain object could be `as`-cast to satisfy the
// compiler) *and* a runtime `WeakSet` membership check that no cast can fake.

import type { SanitizedContext } from '@aegis/protocol';

declare const GUARDED: unique symbol;
export type GuardedPayload = SanitizedContext & { readonly [GUARDED]: true };

const brandedPayloads = new WeakSet<object>();

export function brand(payload: SanitizedContext): GuardedPayload {
  brandedPayloads.add(payload);
  return payload as GuardedPayload;
}

export function isBranded(payload: object): payload is GuardedPayload {
  return brandedPayloads.has(payload);
}
