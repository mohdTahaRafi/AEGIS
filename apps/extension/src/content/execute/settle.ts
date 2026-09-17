// design.md §5.10 (T-2.22) — settle detection: resolve once the page has actually gone quiet, not
// merely once we assume an action worked. Uses `classifyMutation` directly rather than the full
// `startObserving` pipeline — this only needs "is anything non-cosmetic still changing", not the
// epoch/container bookkeeping that pipeline also does.

import { classifyMutation } from '../observe/classify';

export type SettleOutcome = 'settled' | 'timeout' | 'navigated';

export interface SettleOptions {
  quietMs?: number;
  maxWaitMs?: number;
}

function waitTwoAnimationFrames(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/**
 * Resolves `'settled'` once no semantic/privacy-relevant mutation has landed for `quietMs`
 * **and** two consecutive animation frames have rendered **and** the document isn't mid-load;
 * `'timeout'` at `maxWaitMs` on a page that never quiets down; `'navigated'` immediately on
 * `pagehide` — a real navigation ends the step and the host reconnects to the new document.
 */
export function waitForSettle(root: Node = document.body, options: SettleOptions = {}): Promise<SettleOutcome> {
  const quietMs = options.quietMs ?? 250;
  const maxWaitMs = options.maxWaitMs ?? 1500;

  return new Promise((resolve) => {
    let settled = false;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;

    function finish(outcome: SettleOutcome): void {
      if (settled) return;
      settled = true;
      if (quietTimer) clearTimeout(quietTimer);
      clearTimeout(maxWaitTimer);
      observer.disconnect();
      window.removeEventListener('pagehide', onNavigate);
      resolve(outcome);
    }

    function scheduleQuietCheck(): void {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        void waitTwoAnimationFrames().then(() => {
          if (settled) return;
          if (document.readyState !== 'complete') {
            scheduleQuietCheck();
            return;
          }
          finish('settled');
        });
      }, quietMs);
    }

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (classifyMutation(record) !== 'cosmetic') {
          scheduleQuietCheck();
          break;
        }
      }
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      characterData: true,
    });

    function onNavigate(): void {
      finish('navigated');
    }
    window.addEventListener('pagehide', onNavigate);

    const maxWaitTimer = setTimeout(() => finish('timeout'), maxWaitMs);
    scheduleQuietCheck();
  });
}
