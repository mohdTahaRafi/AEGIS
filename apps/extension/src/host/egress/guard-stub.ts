// phase_2_spine.md §8 (T-2.25).
//
// PHASE-2 ONLY. This is not a guard. It brands the payload so the egress client will accept it,
// and it refuses any origin that is not a local fixture. Nothing is redacted here — the payload
// still carries raw accessible names and raw page text (design.md's whole point for this phase:
// build the spine before making it private).
//
// Deleted by Phase 3's T-3.26. If this file exists after Phase 3, that is a release blocker —
// T-2.46 turns that into a CI check once `src/host/privacy/guard/` exists.

import type { SanitizedContext } from '@aegis/protocol';
import { brand, type GuardedPayload } from './brand';

const FIXTURE_ORIGIN_PREFIXES = ['http://localhost:', 'http://127.0.0.1:'];

export function stubGuard(payload: SanitizedContext, origin: string): GuardedPayload {
  if (!FIXTURE_ORIGIN_PREFIXES.some((prefix) => origin.startsWith(prefix))) {
    throw new Error('PHASE2_STUB_REFUSES_NON_FIXTURE_ORIGIN');
  }
  console.warn('[aegis] PHASE-2 STUB GUARD — payload is NOT sanitized');
  return brand(payload);
}
