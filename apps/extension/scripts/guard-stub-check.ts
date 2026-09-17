/**
 * T-2.46 — two CI tripwires, both parameterized so they're testable against a scratch directory
 * rather than only ever exercised against this project's own source tree (same pattern as
 * no-network-scan.ts, T-1.9).
 */
import { existsSync, readFileSync } from 'node:fs';

// Deliberately broader than no-network-scan.ts's call-syntax-only pattern: the egress client
// takes `fetchImpl: typeof fetch = fetch` as an injected, renameable parameter (for testing with
// a fake), so the literal call site is `fetchImpl(...)`, not `fetch(...)` — a call-only pattern
// would never find it. A bare reference to the real global is exactly the evidence needed here:
// proof that *this* is where the genuine `fetch` enters the system, not a renamed pass-through.
const NETWORK_REFERENCE_PATTERN = /\b(fetch|XMLHttpRequest|WebSocket)\b/;

export interface CheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * phase_2_spine.md §8: "src/host/egress/ must exist and must be the sole caller". `scanForNetworkCalls`
 * (no-network-scan.ts) already proves nothing calls fetch/XHR/WebSocket *outside* the allowed
 * folder — but that's true vacuously if the folder is empty or missing entirely, which would mean
 * there is no egress client at all, not that it is trustworthy. This checks the positive half:
 * the folder exists, and at least one real network call actually lives there.
 */
export function checkEgressFolderRequirement(egressDirPath: string, egressFiles: string[]): CheckResult {
  if (!existsSync(egressDirPath)) {
    return { ok: false, reason: `${egressDirPath} must exist — it is the one place fetch/XHR/WebSocket may appear` };
  }
  const hasRealNetworkCall = egressFiles.some((file) => NETWORK_REFERENCE_PATTERN.test(readFileSync(file, 'utf8')));
  if (!hasRealNetworkCall) {
    return { ok: false, reason: `${egressDirPath} exists but contains no fetch/XHR/WebSocket call — nothing would actually reach the network` };
  }
  return { ok: true };
}

/**
 * phase_2_spine.md §8: "guard-stub.ts exists and must not survive" once the real guard lands.
 * `guardStubPath` and `realGuardDirPath` are passed in (not hardcoded) for the same scratch-
 * directory testability reason as above.
 */
export function checkGuardStubTripwire(guardStubPath: string, realGuardDirPath: string): CheckResult {
  const stubExists = existsSync(guardStubPath);
  const realGuardExists = existsSync(realGuardDirPath);
  if (stubExists && realGuardExists) {
    return {
      ok: false,
      reason: `${guardStubPath} must be deleted now that ${realGuardDirPath} exists (phase_2_spine.md §8 — Phase 3's T-3.26)`,
    };
  }
  return { ok: true };
}
