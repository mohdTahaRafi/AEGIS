// design.md §18.3, T-6.9 — swapped in for `ablations.ts` on a real production build by
// `wxt.config.ts`'s `resolve.alias` (that file's own comment has the full reasoning). A dynamic
// `import()` of a literal specifier still gets its own chunk in the built output regardless of
// which module backs it — dead-code elimination does not retroactively un-create that chunk —
// so simply gating the CALL with `import.meta.env.DEV` is not enough to keep the real switch's
// storage key out of a release build; this file exists so the chunk that inevitably gets built
// contains no trace of it. Always resolves `'fused'`, unconditionally, and touches no storage.

import type { AblationArm } from '../shared/ablation';

export async function currentAblationArm(_storage: unknown): Promise<AblationArm> {
  return 'fused';
}
