export default defineBackground(() => {
  // The background is deliberately trivial (architecture §5.6): it opens the panel and relays
  // permission events. No inference, no pixels, no vault — so its termination never affects a task.
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
