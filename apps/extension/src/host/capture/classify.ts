// Maps a `tabs.captureVisibleTab` / bitmap-decode failure to a stable reason code, so a failed
// capture is reported instead of silently degrading the step to DOM-only. Matching is on
// Chromium's own error strings, each one exact: an error that matches none of them is `unknown`
// (and its text is shown), never guessed into a more specific reason. In particular only Chrome's
// two activeTab messages mean `permission` — a looser /permission/ used to also swallow host-access
// errors and label them "activeTab not granted".

/** `not-visible`: the task's tab was not the front tab of its window at capture time (see
 * capture-tab.ts), or Chrome reported its view invisible — the frame is never taken or is
 * discarded, never attributed to the task.
 * `permission`: Chrome reports no activeTab grant on the tab (never invoked there, or the grant was
 * withdrawn by a cross-origin navigation — the panel tells those apart, see shared/invocation.ts).
 * `grant-lost-navigation`: `permission`, where the invocation record shows the tab was invoked on
 * one origin and has since navigated to another.
 * `host-access`: Chrome reports no access to the page's host (distinct from activeTab).
 * `origin-changed`: the task's tab is on a different origin than the task started on. */
export type CaptureFailureReason =
  | 'permission'
  | 'grant-lost-navigation'
  | 'host-access'
  | 'restricted-page'
  | 'throttled'
  | 'no-tab'
  | 'not-visible'
  | 'origin-changed'
  | 'decode'
  | 'unknown';

export type CaptureResult = { ok: true; bitmap: ImageBitmap } | { ok: false; reason: CaptureFailureReason; detail?: string };

const RULES: ReadonlyArray<{ re: RegExp; reason: CaptureFailureReason }> = [
  { re: /Either the '<all_urls>' or 'activeTab' permission is required|'activeTab' permission is not in effect/i, reason: 'permission' },
  { re: /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/, reason: 'throttled' },
  { re: /cannot be scripted|Cannot access a chrome|"(chrome|chrome-extension|chrome-untrusted|chrome-search|devtools|edge):|extensions gallery|web store|ExtensionsSettings policy/i, reason: 'restricted-page' },
  { re: /Cannot access contents of (the page|url)|must request permission to access/i, reason: 'host-access' },
  { re: /view is invisible/i, reason: 'not-visible' },
  { re: /No tab with id|No window with id|No current window|no active tab/i, reason: 'no-tab' },
];

export function classifyCaptureError(err: unknown): CaptureFailureReason {
  const message = err instanceof Error ? err.message : String(err);
  for (const { re, reason } of RULES) if (re.test(message)) return reason;
  return 'unknown';
}
