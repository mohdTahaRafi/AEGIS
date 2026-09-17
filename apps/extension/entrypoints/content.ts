import { bootContentScript } from '../src/content/port';

export default defineContentScript({
  // Static registration for every origin; MV3 only actually injects into origins the extension
  // currently holds a (possibly optional, per-site) host permission for (phase_2_spine.md §4.3) —
  // this is what makes "granted origins only" true without any manual gating here.
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_idle',
  main() {
    bootContentScript({
      isTopFrame: window === window.top,
      onConnect: (listener) => browser.runtime.onConnect.addListener(listener),
      extensionId: browser.runtime.id,
    });
  },
});
