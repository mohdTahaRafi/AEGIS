// phase_4_vision.md §6.2 / T-4.11 — crop budget per frame: 16 (WebGPU) / 8 (WASM). Caps how many
// region jobs are even enqueued for a frame, independent of the deadline (a budget is a count
// limit decided up front; the deadline is a time limit discovered during the run).

import type { Backend } from '../../shared/worker-protocol';

// Raised from 16/8 once pictures became a CLIP pass only (faces and text are whole-frame now):
// ~75 ms per picture on WASM, measured on amazon.in 2026-09-29, where 8 left six banners grey.
export function cropBudgetFor(backend: Backend): number {
  return backend === 'webgpu' ? 24 : 12;
}

/** Applies the budget, returning the regions that fit and the rest as dropped (reported as
 * `timedOut` by the caller — never silently as cleared, same rule as the deadline). Priority
 * order (faces first) must already be reflected in `regions`' ordering by the caller. */
export function applyCropBudget<T>(regions: readonly T[], backend: Backend): { admitted: T[]; dropped: T[] } {
  const budget = cropBudgetFor(backend);
  return { admitted: regions.slice(0, budget), dropped: regions.slice(budget) };
}
