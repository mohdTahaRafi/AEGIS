// phase_4_vision.md §6.2 / T-4.10 — the per-frame deadline (design value 120 ms; the host now
// passes 1500 ms — see `PERCEPTION_DEADLINE_MS` in host/perception-client/run-step.ts for why). "Work that misses it is
// abandoned and its regions stay grey — fail-closed, not fail-slow." This runs each queued job
// against a shared deadline and returns which regions were actually analysed vs. abandoned, so the
// caller can report the latter as `timedOut` (never silently as cleared — the whole point of the
// additive compositor, phase_4_vision.md §7.1).

import type { PriorityQueue, ScheduledJob } from './queue';

export interface DeadlineResult<T, R> {
  completed: { job: ScheduledJob<T>; result: R }[];
  timedOut: ScheduledJob<T>[];
}

/** Drains `queue` one job at a time (the scheduler's "one inference at a time" rule), running
 * `run` on each, until either the queue empties or `deadlineMs` elapses. A job already in flight
 * when the deadline hits is allowed to finish (aborting a live ONNX Runtime call mid-inference
 * isn't a real cancellation point) but no further job is started — everything still queued is
 * `timedOut`. `now` is injectable for deterministic tests. */
export async function runWithDeadline<T, R>(
  queue: PriorityQueue<T>,
  run: (job: ScheduledJob<T>) => Promise<R>,
  deadlineMs: number,
  now: () => number = () => performance.now(),
): Promise<DeadlineResult<T, R>> {
  const started = now();
  const completed: DeadlineResult<T, R>['completed'] = [];

  while (now() - started < deadlineMs) {
    const job = queue.dequeue();
    if (!job) break;
    const result = await run(job);
    completed.push({ job, result });
  }

  const timedOut: ScheduledJob<T>[] = [];
  let next = queue.dequeue();
  while (next) {
    timedOut.push(next);
    next = queue.dequeue();
  }

  return { completed, timedOut };
}
