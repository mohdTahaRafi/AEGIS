export default defineBackground(() => {
  // The background is deliberately trivial (architecture §5.6): it opens the panel and relays
  // permission events. No inference, no pixels, no vault — so its termination never affects a task.
  if (import.meta.env.BROWSER === 'chrome') {
    browser.sidePanel
      ?.setPanelBehavior({ openPanelOnActionClick: true })
      .catch((err: unknown) => console.error('[aegis] sidePanel behavior', err));
  } else {
    browser.action?.onClicked.addListener(() => {
      browser.sidebarAction?.toggle();
    });
  }
});
