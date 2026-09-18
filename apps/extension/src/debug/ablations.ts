// design.md §18.3, T-6.9 — "Config switches in a debug build only, never exposed in the normal
// UI." This file is the switch itself: it is the ONE thing that must be absent from a release
// build (asserted by `test/unit/ablation-build.spec.ts`'s real build-output check) — everything
// downstream that HANDLES a given `AblationArm` (`host/session.ts`, `host/privacy/context/
// builder.ts`, `host/perception-client/run-step.ts`) is ordinary, always-compiled-in
// parameterized code that just receives a plain `AblationArm` value; a release build's
// entrypoint never calls `currentAblationArm()`, so that value is always `undefined` there,
// regardless of what this file can do. See `shared/ablation.ts`'s doc comment for the full
// reasoning on why the boundary sits here rather than at every call site.
//
// The switch itself lives in `storage.local` (a real WebExtension API, already used elsewhere
// for non-secret client state — `host/perception-client/probe-cache.ts`) rather than a UI
// control or a build-time constant: one debug build serves all four arms, and the eval harness
// (or a developer, via the browser's own extension-storage inspector) selects an arm before
// calling `window.__aegisRunTask`, with no new UI surface and no rebuild per arm.

import type { AblationArm } from '../shared/ablation';

export const ABLATION_STORAGE_KEY = 'aegis_debug_ablation_arm';

const KNOWN_ARMS: readonly AblationArm[] = ['fused', 'dom_only', 'pixel_only', 'blackbox'];

// Same minimal shape `host/perception-client/probe-cache.ts`'s `StorageArea` already uses —
// callers pass `browser.storage.local` itself, not the whole `browser.storage` namespace.
export interface AblationStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
}

/** Defaults to `'fused'` (the real default pipeline) for anything unset or unrecognised — a
 * typo'd or stale stored value must never silently disable privacy protections by accident. */
export async function currentAblationArm(storage: AblationStorageArea): Promise<AblationArm> {
  const stored = await storage.get(ABLATION_STORAGE_KEY);
  const value = stored[ABLATION_STORAGE_KEY];
  return (KNOWN_ARMS as readonly unknown[]).includes(value) ? (value as AblationArm) : 'fused';
}
