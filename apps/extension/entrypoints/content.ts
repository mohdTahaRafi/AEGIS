import { bootContentScript } from '../src/content/port';

export default defineContentScript({
  // Static registration for every origin; MV3 only actually injects into origins the extension
  // currently holds a (possibly optional, per-site) host permission for (phase_2_spine.md §4.3) —
  // this is what makes "granted origins only" true without any manual gating here.
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_idle',
  main() {
    // The host may also inject this file programmatically (src/host/content-connection.ts) into a
    // tab whose declared copy is missing or orphaned — and the declared copy can still arrive
    // afterwards (document_idle). Only one live instance may answer the port, or every host
    // request gets two replies. An orphaned instance from a reloaded extension does not count:
    // its `runtime.id` reads undefined once its extension context is gone.
    const scope = globalThis as { __aegisContentLive?: () => boolean };
    if (scope.__aegisContentLive?.()) return;
    scope.__aegisContentLive = () => {
      try {
        return browser.runtime?.id !== undefined;
      } catch {
        return false;
      }
    };
    bootContentScript({
      isTopFrame: window === window.top,
      onConnect: (listener) => browser.runtime.onConnect.addListener(listener),
      extensionId: browser.runtime.id,
    });
  },
});
