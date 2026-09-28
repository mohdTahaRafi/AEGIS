// Chrome's `activeTab` grant — the only thing that permits `captureVisibleTab` for this extension
// (a runtime-granted "On all sites" does not: measured in Chrome 144.0.7559.96 and Chromium 153,
// where `permissions.getAll()` lists `<all_urls>` yet capture still fails) — is given to ONE tab
// when the user invokes the toolbar action there, and Chrome silently withdraws it the moment that
// tab commits a navigation to a different origin. Measured on real sites in Chrome 144: invoking on
// www.practo.com then following its login link to accounts.practo.com, or on
// www.passportindia.gov.in then to services2.passportindia.gov.in, leaves capture failing with the
// same "Either the '<all_urls>' or 'activeTab' permission is required" as a tab never invoked at
// all; same-origin navigations, SPA route changes, reloads and tab switches keep it.
//
// Chrome exposes no query for that grant, so the background mirrors it here — tab id, the origin
// it was granted on, and whether the tab has since left that origin — in `storage.session`
// (memory-only, cleared with the extension). This record only ever EXPLAINS a capture failure; the
// capture result itself stays the sole source of truth for whether capture is permitted.

export interface SessionStore {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface InvocationRecord {
  /** Origin the tab was on when the user invoked AEGIS — the origin Chrome granted. */
  origin: string;
  /** `Date.now()` of the invocation. */
  at: number;
  /** Set once the tab commits a URL on another origin: Chrome has withdrawn the grant. */
  lostTo?: string;
}

export type GrantExplanation =
  | { kind: 'never-invoked' }
  | { kind: 'lost-on-navigation'; grantedOrigin: string; currentOrigin: string }
  | { kind: 'invoked'; grantedOrigin: string };

export function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

const keyFor = (tabId: number): string => `aegis.invocation.${tabId}`;

function isRecord(value: unknown): value is InvocationRecord {
  return typeof value === 'object' && value !== null && typeof (value as InvocationRecord).origin === 'string' && typeof (value as InvocationRecord).at === 'number';
}

export async function recordInvocation(store: SessionStore, tabId: number, url: string | undefined, now: number): Promise<void> {
  const origin = originOf(url);
  if (origin === null) {
    await store.remove(keyFor(tabId));
    return;
  }
  const record: InvocationRecord = { origin, at: now };
  await store.set({ [keyFor(tabId)]: record });
}

/** Called for every committed URL change of a tab. Only a change of ORIGIN matters — that is
 * exactly when Chrome clears the grant (a same-document or same-origin navigation keeps it). */
export async function noteTabUrl(store: SessionStore, tabId: number, url: string): Promise<void> {
  const record = await readInvocation(store, tabId);
  if (!record || record.lostTo !== undefined) return;
  const origin = originOf(url);
  if (origin === null || origin === record.origin) return;
  await store.set({ [keyFor(tabId)]: { ...record, lostTo: origin } satisfies InvocationRecord });
}

export async function forgetTab(store: SessionStore, tabId: number): Promise<void> {
  await store.remove(keyFor(tabId));
}

export async function readInvocation(store: SessionStore, tabId: number): Promise<InvocationRecord | null> {
  const value = (await store.get(keyFor(tabId)))[keyFor(tabId)];
  return isRecord(value) ? value : null;
}

export function explainGrant(record: InvocationRecord | null, currentOrigin: string | null): GrantExplanation {
  if (!record) return { kind: 'never-invoked' };
  if (record.lostTo !== undefined || (currentOrigin !== null && currentOrigin !== record.origin)) {
    return { kind: 'lost-on-navigation', grantedOrigin: record.origin, currentOrigin: currentOrigin ?? record.lostTo ?? '' };
  }
  return { kind: 'invoked', grantedOrigin: record.origin };
}
