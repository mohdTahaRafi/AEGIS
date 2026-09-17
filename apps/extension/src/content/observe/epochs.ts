// design.md §5.5 — per-container epochs plus the global `privacyEpoch`. Nothing reads
// `privacyEpoch` yet (Phase 2 computes it and carries it; Phase 3 makes it force re-analysis
// before the next send — phase_2_spine.md §14 forward dependency).

import type { MutationClass } from './classify';

export class EpochTracker {
  private readonly containerEpochs = new Map<string, number>();
  private globalPrivacyEpoch = 0;

  get privacyEpoch(): number {
    return this.globalPrivacyEpoch;
  }

  containerEpoch(containerId: string): number {
    return this.containerEpochs.get(containerId) ?? 0;
  }

  /** Applies one classified mutation's effect. Cosmetic mutations change nothing. */
  apply(mutationClass: MutationClass, containerId: string): void {
    if (mutationClass === 'cosmetic') return;
    this.containerEpochs.set(containerId, this.containerEpoch(containerId) + 1);
    if (mutationClass === 'privacy-relevant') this.globalPrivacyEpoch += 1;
  }
}
