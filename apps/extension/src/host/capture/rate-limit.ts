// architecture §5.1 / phase_4_vision.md §5.1 — Chrome caps `captureVisibleTab` at 2/s; the
// capture service enforces it rather than discovering it via a rejected call.

export class CaptureRateLimiter {
  private lastCaptureAt = -Infinity;

  constructor(private readonly minIntervalMs = 500, private readonly now: () => number = () => Date.now()) {}

  canCaptureNow(): boolean {
    return this.now() - this.lastCaptureAt >= this.minIntervalMs;
  }

  recordCapture(): void {
    this.lastCaptureAt = this.now();
  }
}
