// design.md §5.5, T-6.7 — the two rate-based signals `classify.ts`/`epochs.ts` deliberately left
// out (see HISTORY.md's T-2.13 entry: "the mutation-rate/'volatile' counters... has no consumer
// yet, and isn't part of T-2.13's actual acceptance criteria"). Both are windowed mutation-rate
// counters, not classification — they run alongside `classifyMutation`/`EpochTracker`, not instead
// of them.
//
// `VolatilityTracker` — per-element: "a node that mutates more than 3 times per second (initial)
// is marked volatile." Deliberately counts EVERY mutation record regardless of class, not just
// semantic/privacy-relevant ones: design.md's own primary example ("volatile text such as clocks
// and counters") is itself classified `cosmetic` by `classify.ts` — a clock's `characterData`
// update never bumps an epoch, but it is exactly the case this tracker exists to catch.
//
// `HostileDynamicTracker` — global: "more than ~20 semantic changes per second sustained for 2s."
// [A] "semantic changes" is read here as non-cosmetic (semantic OR privacy-relevant) — both
// classes already mean "the epoch tracker considered this worth bumping an epoch for," and
// design.md's own three-way split has no fourth category to fall back on if privacy-relevant
// mutations were excluded. A single 2000ms sliding window whose count exceeds 40 (20/s × 2s) is
// used as "sustained," rather than a continuous rate state machine — mathematically equivalent to
// "the average rate over the trailing 2s exceeds 20/s," and far simpler to reason about and test.

const VOLATILE_WINDOW_MS = 1000;
const VOLATILE_THRESHOLD_PER_WINDOW = 3;

const HOSTILE_WINDOW_MS = 2000;
const HOSTILE_THRESHOLD_PER_WINDOW = 20 * (HOSTILE_WINDOW_MS / 1000);

function pruneOld(timestamps: number[], now: number, windowMs: number): void {
  const cutoff = now - windowMs;
  let i = 0;
  while (i < timestamps.length && timestamps[i]! < cutoff) i++;
  if (i > 0) timestamps.splice(0, i);
}

/** Keyed by the live element via a `WeakMap` — the same per-element-history pattern
 * `ContainerResolver`'s own `WeakMap<Element, string>` already uses (`identity.ts`), so an
 * element that's removed from the DOM is naturally forgotten rather than leaking. */
export class VolatilityTracker {
  private readonly history = new WeakMap<Element, number[]>();

  record(el: Element, now: number): void {
    const list = this.history.get(el) ?? [];
    list.push(now);
    pruneOld(list, now, VOLATILE_WINDOW_MS);
    this.history.set(el, list);
  }

  /** True if `el` has mutated more than the threshold within the trailing window, as of `now`.
   * Read-only — does not itself prune/mutate stored history (a query must not have side effects
   * that change what a later query sees for the exact same `now`). */
  isVolatile(el: Element, now: number): boolean {
    const list = this.history.get(el);
    if (!list || list.length === 0) return false;
    const cutoff = now - VOLATILE_WINDOW_MS;
    let count = 0;
    for (let i = list.length - 1; i >= 0 && list[i]! >= cutoff; i--) count++;
    return count > VOLATILE_THRESHOLD_PER_WINDOW;
  }
}

/** Global (page-wide), not per-element — design.md's hostile-dynamic mode is about the page as a
 * whole overwhelming the observation/perception pipeline, not any one node. */
export class HostileDynamicTracker {
  private readonly timestamps: number[] = [];

  record(now: number): void {
    this.timestamps.push(now);
    pruneOld(this.timestamps, now, HOSTILE_WINDOW_MS);
  }

  isHostileDynamic(now: number): boolean {
    const cutoff = now - HOSTILE_WINDOW_MS;
    let count = 0;
    for (let i = this.timestamps.length - 1; i >= 0 && this.timestamps[i]! >= cutoff; i--) count++;
    return count > HOSTILE_THRESHOLD_PER_WINDOW;
  }
}
