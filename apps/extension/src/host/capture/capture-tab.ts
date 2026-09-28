// architecture §5.3 — capture is pinned to the task's own tab. `captureVisibleTab` can only grab
// "whatever tab is in front of window W", so capturing without checking that the task's tab IS
// that tab would hand the pipeline another tab's pixels. The geometry-digest guard cannot catch
// that (the task tab's DOM geometry does not change when the user switches away), and the additive
// compositor would then clear regions of the wrong page by the task page's own DOM boxes — pixels
// from a tab the user never pointed AEGIS at, sent to the server. Checked before AND after the
// capture: a switch in between discards the frame (fail closed, step stays DOM-only). The same
// holds for the task's ORIGIN: a tab that has moved to another site is no longer the page the task
// (and its guard origin) is about, so it is not captured either.

import { classifyCaptureError, type CaptureFailureReason } from './classify';
import { originOf } from '../../shared/invocation';

export interface TabsCaptureApi {
  get(tabId: number): Promise<{ active: boolean; windowId: number; url?: string; status?: string; discarded?: boolean }>;
  captureVisibleTab(windowId: number, options: { format: 'jpeg'; quality: number }): Promise<string>;
}

/** What the task was started on — fixed at Run, never re-derived from "the current tab". */
export interface CaptureTarget {
  tabId: number;
  origin: string;
}

/** Tab state at the failing capture, for the panel's console only (never the ledger or network).
 * Origins only — never a path or query, which can carry tokens. */
export interface CaptureDiagnostics {
  tabId: number;
  windowId?: number;
  active?: boolean;
  status?: string;
  discarded?: boolean;
  origin: string | null;
  taskOrigin: string;
}

export type TabCaptureResult =
  | { ok: true; dataUrl: string }
  | { ok: false; reason: CaptureFailureReason; detail?: string; diag: CaptureDiagnostics };

type TabState = Awaited<ReturnType<TabsCaptureApi['get']>>;

async function readTab(tabs: TabsCaptureApi, tabId: number): Promise<TabState | null> {
  try {
    return await tabs.get(tabId);
  } catch {
    return null;
  }
}

function diagnose(target: CaptureTarget, tab: TabState | null): CaptureDiagnostics {
  return {
    tabId: target.tabId,
    windowId: tab?.windowId,
    active: tab?.active,
    status: tab?.status,
    discarded: tab?.discarded,
    origin: originOf(tab?.url),
    taskOrigin: target.origin,
  };
}

/** Why the tab cannot be captured as the task's page right now, or null if it can. A tab whose URL
 * is unreadable counts as off-origin: fail closed. */
function blocker(target: CaptureTarget, tab: TabState | null): CaptureFailureReason | null {
  if (!tab) return 'no-tab';
  if (!tab.active) return 'not-visible';
  if (originOf(tab.url) !== target.origin) return 'origin-changed';
  return null;
}

/** `detail` is Chromium's own error text with any quoted URL removed — for the panel only (never
 * the ledger or the network), so a failure is diagnosable rather than collapsed into a code. */
export async function captureTargetTab(tabs: TabsCaptureApi, target: CaptureTarget): Promise<TabCaptureResult> {
  const before = await readTab(tabs, target.tabId);
  const notCapturable = blocker(target, before);
  if (notCapturable || !before) return { ok: false, reason: notCapturable ?? 'no-tab', diag: diagnose(target, before) };

  let dataUrl: string;
  try {
    dataUrl = await tabs.captureVisibleTab(before.windowId, { format: 'jpeg', quality: 80 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: classifyCaptureError(err), detail: message.replace(/"[^"]*"/g, '"…"'), diag: diagnose(target, before) };
  }

  const after = await readTab(tabs, target.tabId);
  const changed = blocker(target, after) ?? (after && after.windowId !== before.windowId ? 'not-visible' : null);
  if (changed) return { ok: false, reason: changed === 'no-tab' ? 'not-visible' : changed, diag: diagnose(target, after) };
  return { ok: true, dataUrl };
}
