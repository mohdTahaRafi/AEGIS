// "Is what the user would see actually on screen yet?" — asked before every observation and
// screenshot. The tab's `complete` status is the wrong signal both ways: on a slow connection a
// page's pictures keep arriving after it (a screenshot then shows empty boxes and the model plans
// against a half-drawn page), and a heavy page with trackers fires it many seconds after it is
// usable. This waits for the page itself: parsed, fonts in, every picture in the viewport decoded,
// no new network responses and no new content for a short quiet window — or `maxMs`, whichever
// comes first. Reads geometry and load state only, never text or values.

export interface ReadyResult {
  waitedMs: number;
  /** Pictures in the viewport still loading when the wait ended. */
  pendingImages: number;
  timedOut: boolean;
}

const POLL_MS = 100;
const NETWORK_QUIET_MS = 400;
const DOM_QUIET_MS = 350;
const MIN_WAIT_MS = 120;

function intersectsViewport(rect: DOMRect): boolean {
  return rect.width > 1 && rect.height > 1 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

/** `<img>` elements on screen that have not finished loading (a broken image counts as finished). */
export function pendingViewportImages(doc: Document = document): number {
  let pending = 0;
  for (const img of Array.from(doc.images)) {
    if (img.complete) continue;
    if (!intersectsViewport(img.getBoundingClientRect())) continue;
    const style = getComputedStyle(img);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
    pending++;
  }
  return pending;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One painted frame, or a short timeout: requestAnimationFrame never fires in a background tab. */
function afterPaint(): Promise<void> {
  return Promise.race([new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))), sleep(120)]);
}

export async function waitForVisualReady(maxMs: number): Promise<ReadyResult> {
  const start = performance.now();
  let lastNetworkAt = start;
  let lastDomAt = start;
  let perfObserver: PerformanceObserver | null = null;
  try {
    perfObserver = new PerformanceObserver(() => {
      lastNetworkAt = performance.now();
    });
    perfObserver.observe({ type: 'resource', buffered: false });
  } catch {
    perfObserver = null;
  }
  const domObserver = new MutationObserver(() => {
    lastDomAt = performance.now();
  });
  if (document.body) domObserver.observe(document.body, { childList: true, subtree: true, characterData: true });

  let pendingImages = 0;
  let timedOut = true;
  try {
    while (performance.now() - start < maxMs) {
      const now = performance.now();
      pendingImages = pendingViewportImages();
      const parsed = document.readyState !== 'loading';
      const fontsIn = !document.fonts || document.fonts.status === 'loaded';
      const networkQuiet = now - lastNetworkAt >= NETWORK_QUIET_MS;
      const domQuiet = now - lastDomAt >= DOM_QUIET_MS;
      if (now - start >= MIN_WAIT_MS && parsed && fontsIn && pendingImages === 0 && networkQuiet && domQuiet) {
        timedOut = false;
        break;
      }
      await sleep(POLL_MS);
    }
  } finally {
    perfObserver?.disconnect();
    domObserver.disconnect();
  }
  await afterPaint();
  return { waitedMs: Math.round(performance.now() - start), pendingImages, timedOut };
}
