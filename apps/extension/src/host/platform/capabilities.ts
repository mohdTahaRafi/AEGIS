// phase_2_spine.md §4.3 (T-2.2, T-2.4) — host permissions. Architecture §5.1's verified platform
// fact: a click inside the side panel does not grant `activeTab`, so capture and content-script
// injection need an explicit optional host permission requested at task start, which the browser
// answers with a real prompt.
//
// Both `PermissionsApi` and `RuntimeMessaging` below are small structural subsets of the real
// `Browser.permissions`/`Browser.runtime` surface, injectable for testing — `wxt`'s `fakeBrowser`
// test double does not implement `permissions.*` at all (verified directly: `contains()` and
// `onRemoved.addListener()` both throw "not implemented" there), so this logic would be
// untestable if it called `browser.permissions.*` directly.

import { isPermissionRevokedMessage } from '../../shared/messages';

export interface PermissionsApi {
  contains(descriptor: { origins: string[] }): Promise<boolean>;
  request(descriptor: { origins: string[] }): Promise<boolean>;
}

export type HostPermissionState = 'granted' | 'requested-and-granted' | 'denied';

/**
 * T-2.4: checks first (no prompt if already granted from a prior task), then requests (a real
 * browser prompt) only if needed. A denial is reported as a state the caller can render — never
 * thrown as an error, because "the user said no" is an expected, explainable outcome, not a bug.
 */
export async function ensureHostPermission(permissions: PermissionsApi, origin: string): Promise<HostPermissionState> {
  const originPattern = `${origin}/*`;
  const already = await permissions.contains({ origins: [originPattern] });
  if (already) return 'granted';
  const granted = await permissions.request({ origins: [originPattern] });
  return granted ? 'requested-and-granted' : 'denied';
}

export interface RuntimeMessaging {
  addMessageListener(cb: (message: unknown) => void): void;
}

/**
 * T-2.2's host half: background just forwards `permission-revoked` broadcasts; this decides
 * whether the revoked origin matches the currently-running task and, if so, calls `onRevoked`
 * with a reason the controller can stop on (design.md §10.1's `CANCELLED`/`ERROR` machinery).
 */
export function listenForPermissionRevocation(
  runtime: RuntimeMessaging,
  getCurrentTaskOrigin: () => string | null,
  onRevoked: (origin: string) => void,
): void {
  runtime.addMessageListener((message) => {
    if (!isPermissionRevokedMessage(message)) return;
    const current = getCurrentTaskOrigin();
    if (current === null) return;
    // permissions.onRemoved reports match patterns ("https://example.com/*"), not bare origins —
    // strip the pattern suffix for an exact comparison rather than a prefix match, which would
    // wrongly also match "https://example.com.evil.com".
    const revokedOrigin = message.origin.replace(/\/\*$/, '');
    if (revokedOrigin === current) onRevoked(message.origin);
  });
}
