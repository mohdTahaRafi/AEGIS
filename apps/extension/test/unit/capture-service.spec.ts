import { describe, expect, it, vi } from 'vitest';
import { CaptureService } from '../../src/host/capture/service';
import { CaptureRateLimiter } from '../../src/host/capture/rate-limit';

describe('CaptureRateLimiter (architecture §5.1 — captureVisibleTab capped at 2/s)', () => {
  it('allows the first capture immediately', () => {
    const limiter = new CaptureRateLimiter(500, () => 1000);
    expect(limiter.canCaptureNow()).toBe(true);
  });

  it('blocks a second capture inside the minimum interval', () => {
    let now = 1000;
    const limiter = new CaptureRateLimiter(500, () => now);
    limiter.recordCapture();
    now = 1200;
    expect(limiter.canCaptureNow()).toBe(false);
    now = 1600;
    expect(limiter.canCaptureNow()).toBe(true);
  });
});

describe('CaptureService (architecture §6.5 — event-driven, never a fixed frame rate)', () => {
  it('zero captures on a static page with no triggers at all (the metric-4 mechanism)', () => {
    const onCapture = vi.fn();
    const service = new CaptureService({ onCapture });
    expect(onCapture).not.toHaveBeenCalled();
    service.dispose();
  });

  it('an immediate trigger (scrollend) fires exactly once', () => {
    const onCapture = vi.fn();
    const service = new CaptureService({ onCapture });
    service.notify('scrollend');
    expect(onCapture).toHaveBeenCalledTimes(1);
    expect(onCapture).toHaveBeenCalledWith('scrollend');
  });

  it('a burst of mutation notifications produces exactly one capture after the quiet period', () => {
    vi.useFakeTimers();
    const onCapture = vi.fn();
    const service = new CaptureService({ onCapture });
    service.notifyMutation();
    vi.advanceTimersByTime(100);
    service.notifyMutation(); // restarts the quiet-period timer
    vi.advanceTimersByTime(100);
    service.notifyMutation();
    expect(onCapture).not.toHaveBeenCalled(); // still within the quiet window
    vi.advanceTimersByTime(500);
    expect(onCapture).toHaveBeenCalledTimes(1);
    expect(onCapture).toHaveBeenCalledWith('mutation-quiet');
    service.dispose();
    vi.useRealTimers();
  });

  it('respects the rate limiter across two immediate triggers', () => {
    let now = 0;
    const rateLimiter = new CaptureRateLimiter(500, () => now);
    const onCapture = vi.fn();
    const service = new CaptureService({ onCapture, rateLimiter });
    service.notify('scrollend');
    now = 100;
    service.notify('focus-change'); // too soon — rate-limited
    expect(onCapture).toHaveBeenCalledTimes(1);
    now = 600;
    service.notify('focus-change');
    expect(onCapture).toHaveBeenCalledTimes(2);
  });

  it('dispose() cancels a pending debounced capture', () => {
    vi.useFakeTimers();
    const onCapture = vi.fn();
    const service = new CaptureService({ onCapture });
    service.notifyMutation();
    service.dispose();
    vi.advanceTimersByTime(1000);
    expect(onCapture).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
