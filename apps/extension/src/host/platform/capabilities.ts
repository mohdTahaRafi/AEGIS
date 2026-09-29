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

export const ALL_SITES = '<all_urls>';

export interface TaskPermissions {
  state: HostPermissionState;
  /** Chrome's `captureVisibleTab` accepts only `<all_urls>` or an activeTab grant (a click on the
   * AEGIS icon on that very tab) — a per-site host permission is NOT enough. Without all sites, a
   * tab the task moves into (one its own click opened) can be read but not captured, so vision,
   * which every step requires, stops until the user clicks the icon there. */
  allSites: boolean;
}

/**
 * At Run (a user gesture): all sites if already granted; otherwise asks for it once (the browser's
 * own prompt), and if that is declined falls back to this site only (`ensureHostPermission`).
 * Host access only lets AEGIS inject into and capture the tab a task runs in — the page is still
 * sanitized and guarded before anything leaves the device.
 */
export async function ensureTaskPermissions(permissions: PermissionsApi, origin: string): Promise<TaskPermissions> {
  if (await permissions.contains({ origins: [ALL_SITES] })) return { state: 'granted', allSites: true };
  try {
    if (await permissions.request({ origins: [ALL_SITES] })) return { state: 'requested-and-granted', allSites: true };
  } catch {
    // No user gesture left, or the browser refused to prompt: fall through to this site only.
  }
  try {
    return { state: await ensureHostPermission(permissions, origin), allSites: false };
  } catch {
    return { state: 'denied', allSites: false };
  }
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
