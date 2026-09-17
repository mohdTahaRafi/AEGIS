import type { PermissionRevokedMessage } from '../src/shared/messages';

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
    browser.sidePanel
      ?.setPanelBehavior({ openPanelOnActionClick: true })
      .catch((err: unknown) => console.error('[aegis] sidePanel behavior', err));
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
