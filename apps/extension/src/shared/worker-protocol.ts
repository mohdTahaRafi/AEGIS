// design.md §11.1 — the real perception-worker message interface, replacing the Phase-0 spike
// protocol (`perception/spike-protocol.ts`, kept only for the probe/bench types the percentile
// math test still mirrors). Every message is a plain, structured-clone-safe object; the one
// exception is `perceive`'s `bitmap`, which is transferred (see `perception/worker.ts`'s doc
// comment on the pixel-ownership rule, architecture §5.3).
//
// Lives in `src/shared/`, not `src/perception/`: host and perception cannot import each other
// (architecture §15.2/§15.3, ESLint-enforced) and talk only by message, so the message *types*
// need a neutral home both sides may import — the same reasoning `shared/messages.ts` follows for
// the content↔host boundary.

import type { EntityType } from '@aegis/recognizers';

// Duplicated from `host/privacy/types.ts`'s `Box` rather than imported: perception must not
// import host (architecture §15.3, ESLint-enforced) — the worker and the host only communicate
// through this typed message interface, never through shared module state.
export type Box = [x: number, y: number, w: number, h: number];

export type Backend = 'webgpu' | 'wasm';

export interface ModelSpec {
  id: string;
  role: 'face' | 'vit' | 'masked-glyph' | 'ner';
  url: string;
  sha256: string;
  resident: boolean;
}

export interface ModelInfo {
  id: string;
  role: ModelSpec['role'];
  loadMs: number;
  bytes: number;
}

export interface RegionJob {
  id: string;
  box: Box;
  /** `'full'` regions are screened at low resolution for the screen-state label only; `'crop'`
   * regions get the full face+ViT pipeline. */
  kind: 'crop' | 'full';
}

export interface Candidate {
  entity: EntityType;
  box: Box;
  score: number;
  regionId?: string;
}

export interface Coverage {
  cleared: number;
  redacted: number;
  unanalysed: number;
}

export type ToWorker =
  | { t: 'init'; backendPref: 'auto' | 'webgpu' | 'wasm'; models: ModelSpec[]; profile: 'S' | 'L' }
  | { t: 'perceive'; jobId: string; bitmap: ImageBitmap; regions: RegionJob[]; deadlineMs: number; fullFrame: boolean }
  | { t: 'ner'; jobId: string; chunks: { id: string; text: string }[] }
  // No bitmap/width/height here: `compose` operates on the capture already held by the worker
  // from the matching `perceive` call for this step (phase_4_vision.md §3.2 — "the worker holds
  // one capture at a time"), never a second transfer. `entity` is a plain string, not
  // `EntityType`, on purpose: the compositor only ever uses it to look up a non-resolvable
  // entity's display label (`FACE`, `ID_DOCUMENT`, ...) and never validates it against the
  // recognizer vocabulary — keeping it a bare string avoids `packages/recognizers` becoming a
  // type-only dependency of the message contract two execution contexts both have to agree on.
  | { t: 'compose'; jobId: string; regions: { entity: string; boxes: Box[]; placeholder: string | null }[]; cleared: Box[]; scale: number }
  // `image`/`redactionBoxes` are the just-composed output and the boxes that produced it — the
  // worker needs the actual pixels to re-run face detection over the composed result
  // (phase_4_vision.md §8); `halos` narrows where the (Phase 6) OCR half will look.
  | { t: 'rescan'; jobId: string; image: ArrayBuffer; redactionBoxes: Box[]; halos: Box[] }
  | { t: 'evict'; model: string }
  | { t: 'stats' };

export interface AdapterInfo {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
}

export type FromWorker =
  // `adapterInfo` is set only when the resolved backend is 'webgpu' — it is the cache key
  // ingredient `probe-cache.ts` needs (design.md §11.2's "keyed by browser version and GPU
  // adapter info"), which only the worker can observe (only a Worker/window context can call
  // `navigator.gpu.requestAdapter()`, and the design keeps the probe itself worker-side per
  // T-4.1's spike heritage).
  | { t: 'ready'; backend: Backend; loaded: ModelInfo[]; adapterInfo?: AdapterInfo }
  | { t: 'perceived'; jobId: string; candidates: Candidate[]; screenLabel?: { label: string; score: number }; timings: Record<string, number>; timedOut: Box[] }
  | { t: 'nerResult'; jobId: string; spans: { id: string; start: number; end: number; entity: EntityType; score: number }[] }
  | { t: 'composed'; jobId: string; webp: ArrayBuffer; coverage: Coverage }
  | { t: 'rescanned'; jobId: string; hits: Candidate[] }
  | { t: 'stats'; memoryEstimateMB: number; sessions: ModelInfo[] }
  | { t: 'error'; jobId?: string; code: string; detail?: string };
