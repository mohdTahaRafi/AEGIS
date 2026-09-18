// architecture §6.5 / phase_4_vision.md §5.1 — event-driven capture, never a fixed frame rate.
// "On a static page with high coverage the steady-state capture rate is zero" — the single
// biggest metric-4 lever in the phase (an agent that screenshots at 5fps while the user reads a
// page has already lost the resource metric). This class only decides *when* a capture is worth
// taking; the actual `captureVisibleTab` call, `createImageBitmap` decode and digest computation
// are injected so the decision logic is testable without a real tab.

import { CaptureRateLimiter } from './rate-limit';

export type CaptureTrigger = 'navigation' | 'mutation-quiet' | 'scrollend' | 'focus-change' | 'step-boundary' | 'server-request';

const MUTATION_QUIET_MS = 400;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface CaptureServiceDeps {
  rateLimiter?: CaptureRateLimiter;
  onCapture: (trigger: CaptureTrigger) => void;
  setTimeout?: (callback: () => void, ms: number) => TimerHandle;
  clearTimeout?: (handle: TimerHandle) => void;
}

/** Coalesces a burst of DOM-mutation notifications into one capture after a quiet period, and
 * gates every trigger (including the debounced one) through the shared rate limiter — so a
 * `scrollend` arriving 50ms after a mutation-quiet fire still only produces one real capture, not
 * two, if that would exceed 2/s. */
export class CaptureService {
  private readonly rateLimiter: CaptureRateLimiter;
  private readonly setTimeoutFn: (callback: () => void, ms: number) => TimerHandle;
  private readonly clearTimeoutFn: (handle: TimerHandle) => void;
  private mutationTimer: TimerHandle | null = null;

  constructor(private readonly deps: CaptureServiceDeps) {
    this.rateLimiter = deps.rateLimiter ?? new CaptureRateLimiter();
    // Wrapped, not passed directly — Web IDL timer methods require `this === window`/`self`, the
    // same "Illegal invocation" trap Phase 3's vault hit storing `setTimeout`/`clearTimeout` as
    // bound class fields (docs/HISTORY.md).
    this.setTimeoutFn = deps.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimeoutFn = deps.clearTimeout ?? ((handle) => clearTimeout(handle));
  }

  /** Immediate triggers — navigation, scrollend, focus change, a step boundary, or an explicit
   * server `request_observation` — fire (subject to the rate limit) without debouncing. */
  notify(trigger: Exclude<CaptureTrigger, 'mutation-quiet'>): void {
    this.fireIfAllowed(trigger);
  }

  /** A DOM mutation burst: restarts the quiet-period timer rather than firing immediately, so N
   * mutations in quick succession produce at most one capture. */
  notifyMutation(): void {
    if (this.mutationTimer !== null) this.clearTimeoutFn(this.mutationTimer);
    this.mutationTimer = this.setTimeoutFn(() => {
      this.mutationTimer = null;
      this.fireIfAllowed('mutation-quiet');
    }, MUTATION_QUIET_MS);
  }

  private fireIfAllowed(trigger: CaptureTrigger): void {
    if (!this.rateLimiter.canCaptureNow()) return;
    this.rateLimiter.recordCapture();
    this.deps.onCapture(trigger);
  }

  dispose(): void {
    if (this.mutationTimer !== null) this.clearTimeoutFn(this.mutationTimer);
    this.mutationTimer = null;
  }
}
