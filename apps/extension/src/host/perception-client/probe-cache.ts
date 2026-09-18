// design.md §11.2 step 3 / phase_4_vision.md T-4.1 — caches the resolved backend in
// `storage.local`, keyed by browser version + GPU adapter info, so a 1.5s WebGPU adapter timeout
// doesn't repeat on every task start. Lives host-side, not in the worker: `chrome.storage` /
// `browser.storage` is an extension-page API, unavailable inside a plain DedicatedWorkerGlobalScope
// (the same category of platform fact as "extension messaging cannot transfer an ImageBitmap" —
// architecture §1.3 C-8(b)). Directory named `perception-client`, not `perception`, so this stays
// outside the ESLint boundary rule that blocks `src/host/**` from importing `**/perception/**`
// (eslint.config.js) — this module only ever imports the neutral `shared/worker-protocol` types.

import type { AdapterInfo, Backend } from '../../shared/worker-protocol';

const STORAGE_KEY = 'aegis:perception:backendProbeCache';

export interface ProbeCacheEntry {
  browserVersion: string;
  adapterKey: string;
  backend: Backend;
  cachedAt: number;
}

export interface StorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export function adapterKeyOf(info: AdapterInfo | undefined): string {
  if (!info) return 'none';
  return `${info.vendor}|${info.architecture}|${info.device}`;
}

/** Reads the userAgent's browser version token (e.g. "Chrome/128.0.0.0") — coarse but sufficient
 * to invalidate the cache across a browser upgrade, per design.md §11.2's requirement. */
export function browserVersionOf(userAgent: string): string {
  const match = /(Chrome|Firefox)\/([\d.]+)/.exec(userAgent);
  return match ? `${match[1]}/${match[2]}` : 'unknown';
}

export async function readProbeCache(storage: StorageArea, browserVersion: string): Promise<ProbeCacheEntry | null> {
  const stored = await storage.get(STORAGE_KEY);
  const entry = stored[STORAGE_KEY] as ProbeCacheEntry | undefined;
  if (!entry) return null;
  if (entry.browserVersion !== browserVersion) return null; // version change invalidates
  return entry;
}

export async function writeProbeCache(storage: StorageArea, entry: ProbeCacheEntry): Promise<void> {
  await storage.set({ [STORAGE_KEY]: entry });
}
