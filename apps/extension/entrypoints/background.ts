import type { ActionInvokedMessage, PermissionRevokedMessage } from '../src/shared/messages';
import { forgetTab, noteTabUrl, recordInvocation } from '../src/shared/invocation';

export default defineBackground(() => {
  // The background is deliberately trivial (architecture §5.6): it opens the panel and relays
  // permission events. No inference, no pixels, no vault — so its termination never affects a task.

  // T-2.2: pure forwarding, no decision-making — the host (src/host/platform/capabilities.ts)
  // decides whether a revoked origin matters to the running task.
  browser.permissions.onRemoved.addListener((permissions) => {
    for (const origin of permissions.origins ?? []) {
      const message: PermissionRevokedMessage = { type: 'permission-revoked', origin };
      browser.runtime.sendMessage(message).catch(() => {});
    }
  });

  if (import.meta.env.BROWSER === 'chrome') {
    // Site access is a required permission (wxt.config.ts), which is what lets `captureVisibleTab`
    // work on any site the task moves to. A user can still restrict it in Chrome ("On click"); then
    // the toolbar click is what grants `activeTab` for that tab. `openPanelOnActionClick: true`
    // opens the panel but does NOT grant `activeTab` (measured in Chromium 153 via
    // `Extensions.triggerAction`), while the same click routed through `action.onClicked` does.
    // An optional `<all_urls>`, even switched to "On all sites", never satisfies
    // `captureVisibleTab` (re-measured 2026-10-10, Chromium 153).
    // `sidePanel.open` must run synchronously inside the listener to keep the user gesture, and it
    // never toggles the panel closed, so clicking the icon on a new tab while the panel is open just
    // grants that tab.
    browser.sidePanel
      ?.setPanelBehavior({ openPanelOnActionClick: false })
      .catch((err: unknown) => console.error('[aegis] sidePanel behavior', err));
    //
    // The click also grants `activeTab` on this tab for its current origin only; Chrome withdraws
    // it when the tab navigates cross-origin. That lifecycle is mirrored into `storage.session`
    // (shared/invocation.ts) so the panel can say WHY a capture was refused, and the click is
    // broadcast so a panel paused waiting for the grant can resume.
    browser.action.onClicked.addListener((tab) => {
      if (tab.windowId === undefined) return;
      browser.sidePanel.open({ windowId: tab.windowId }).catch((err: unknown) => console.error('[aegis] sidePanel open', err));
      const tabId = tab.id;
      if (tabId === undefined) return;
      void recordInvocation(browser.storage.session, tabId, tab.url, Date.now())
        .catch((err: unknown) => console.error('[aegis] invocation record', err))
        .then(() => {
          const message: ActionInvokedMessage = { type: 'action-invoked', tabId };
          // Rejects when no panel is open yet to receive it — nothing is waiting then.
          return browser.runtime.sendMessage(message).catch(() => {});
        });
    });
    browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (changeInfo.url === undefined) return;
      noteTabUrl(browser.storage.session, tabId, changeInfo.url).catch((err: unknown) => console.error('[aegis] invocation record', err));
    });
    browser.tabs.onRemoved.addListener((tabId) => {
      forgetTab(browser.storage.session, tabId).catch(() => {});
    });
  } else {
    // sidebarAction is Firefox-only and not part of WXT's cross-browser type surface.
    const firefoxBrowser = browser as unknown as {
      action?: { onClicked: { addListener(cb: () => void): void } };
      sidebarAction?: { toggle(): void };
    };
    firefoxBrowser.action?.onClicked.addListener(() => {
      firefoxBrowser.sidebarAction?.toggle();
    });
  }
});
