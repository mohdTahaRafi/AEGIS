# R-4 — Fix the guard's image rescan (halo check) and device-pixel scaling

**Priority:** P0 · **Depends on:** R-0 · **Unblocks:** R-7, R-9, R-10
**Bugs fixed:** A2, A3, A4 · **Parent list:** [tasks.md](tasks.md)

`ext/` = `apps/extension/`. Paths are relative to `AEGIS/`.

## Goal

The composed image reaches the model unless readable sensitive content or a face is really
visible in it. The check finishes within a fixed budget, fails closed, and the panel says why an
image was withheld. Every box lines up with the pixels on any screen scale.

## Today (verified)

- **A2.** `ext/src/host/session.ts:466-470` builds
  `rescan: (bytes, boxes) => client.rescan(bytes, [...boxes], [])`. `ext/src/perception/worker.ts:411`
  then does `const halos = msg.halos.length > 0 ? msg.halos : msg.redactionBoxes;`. So OCR runs
  **inside** each redaction box, where `compose/compositor.ts:98-101` drew a white
  `⟪AADHAAR#n⟫`/`FACE` label. `rescan/halo.ts:checkHalosForText` counts any non-blank decoded text
  as a hit.
- **A3.** Boxes are CSS pixels, but the composed WebP is scaled by
  `scale = min(1, 1600 / max(viewport.w, viewport.h))` (`host/perception-client/run-step.ts:109`),
  and nothing rescales the rescan boxes.
- **A4.** `captureVisibleTab` returns device pixels. `entrypoints/sidepanel/main.tsx:captureTabAsBitmap`
  decodes at native size. `perception/preprocess/crop.ts:cropRegion`, `compose/compositor.ts:compose`
  and `models/face.ts` all index that bitmap with CSS-pixel boxes. No code multiplies by
  `devicePixelRatio`. On a dpr-2 screen, cleared regions copy pixels from the wrong place and
  redaction boxes cover the wrong area.
- `host/privacy/guard/image-rescan.ts:runImageRescan`: rescan → one recompose at +50 % → rescan →
  drop. There is no time budget.
- `guard.ts:runStep5` drops the image on `dropped` and reports nothing about why.
- OCR detection (`models/ocr-det.ts:detectText`) resizes its input to a long side ≤ 960 px
  (`preprocess/ocr-resize.ts`).
- Tests that touch the rescan shapes:
  - `test/unit/image-rescan.spec.ts`;
  - `test/browser/halo-rescan.spec.ts`;
  - `test/unit/session.spec.ts:510-547` (`perceptionWithRescanHits`).

## Decisions (fixed)

- **Pixel space.** Everything downstream of capture works in **CSS pixels**. The capture is
  resized to `viewport.w × viewport.h` once, right after capture. The compositor's `scale` stays
  the only scale factor.
- **Which boxes get ring OCR.** Every redaction whose entity is **not** one of `FACE`,
  `ID_DOCUMENT`, `QR_CODE`, `SIGNATURE`. Those four are image fills and rely on the face re-check.
  This includes presence-only text such as a bare `⟪PASSWORD⟫`, which the old plan's "placeholder
  refs only" rule would have skipped.
- **What counts as a text hit.** A recognised line is a leak only if one of these holds:
  1. `findAll(text)` has a `valid` match whose policy class is `HIGH` or `CRITICAL`;
  2. its normalised text shares a run of ≥ 4 characters with a sealed vault value of length ≥ 4.
     "Normalised" means `normalizeForMatching`, lowercase, whitespace removed, compared both as-is
     and digits-only.

  Any face found in the composed image is a hit, as today.
- **Budget.** `IMAGE_RESCAN_BUDGET_MS = 1500` covers the whole of guard step 5: both passes and the
  recompose. That matches `PERCEPTION_DEADLINE_MS`. The R-baseline guard p50 is 17.9 s; the
  target is < 500 ms (tasks.md). The 1500 ms cap exists so a slow machine drops the image rather
  than stalling. Tune it after measuring, and record any change in the Decision log.
- **Fail closed.** If the check can't finish, the image is not sent. That covers the budget
  running out, the OCR model failing to load while there are text boxes, and a worker error. This
  outcome is `incomplete`. The old path treated "no OCR model" as zero hits, which failed open.

## Implementation

### 1. Normalise the capture to CSS pixels (A4) — `ext/src/host/perception-client/run-step.ts`

Add:

```ts
/** Resizes a device-pixel capture to the page's CSS-pixel viewport, so every DOM box indexes the
 * bitmap directly. Closes the original when it resizes. */
export async function toViewportPixels(bitmap: ImageBitmap, w: number, h: number): Promise<ImageBitmap> {
  const width = Math.round(w);
  const height = Math.round(h);
  if (bitmap.width === width && bitmap.height === height) return bitmap;
  const resized = await createImageBitmap(bitmap, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
  bitmap.close();
  return resized;
}
```

Add an optional dependency so unit tests can skip the browser API:

```ts
export interface PerceptionStepDeps {
  ...
  /** Defaults to `toViewportPixels`. */
  normalizeBitmap?: (bitmap: ImageBitmap, w: number, h: number) => Promise<ImageBitmap>;
}
```

In `runPerceptionStep`, replace `const bitmap = captureResult.bitmap;` with:

```ts
  const bitmap = await (deps.normalizeBitmap ?? toViewportPixels)(captureResult.bitmap, deps.viewport.w, deps.viewport.h);
```

`PerceptionStepDeps.viewport` is already `{ w, h }` from the page (`session.ts:339`).
`test/unit/run-step.spec.ts`: wherever a fake bitmap's size differs from the fake viewport, pass
`normalizeBitmap: async (b) => b`.

### 2. Worker message contract — `ext/src/shared/worker-protocol.ts`

Replace the `rescan` member of `ToWorker`:

```ts
  // `image` is the composed WebP; every box is in CSS pixels and `scale` maps them onto the image.
  // `textBoxes` get 24 px halo-ring OCR; `maskBoxes` (every redaction box) are blacked out on a
  // working copy first, so the labels the compositor drew inside them can never be read.
  | { t: 'rescan'; jobId: string; image: ArrayBuffer; scale: number; textBoxes: Box[]; maskBoxes: Box[]; deadlineMs: number }
```

Replace the `rescanned` member of `FromWorker`:

```ts
  // `ringText` boxes are CSS pixels. `incomplete`: the deadline ran out or OCR was unavailable
  // while `textBoxes` was non-empty. The host treats that as "do not send the image".
  | { t: 'rescanned'; jobId: string; faces: Box[]; ringText: { box: Box; text: string }[]; incomplete: boolean }
```

`ringText.text` crosses from the worker to the host inside the extension. It is never logged, put
in a payload, or put in an event; only the host guard reads it.

### 3. Client — `ext/src/host/perception-client/client.ts`

```ts
  async rescan(image: ArrayBuffer, request: { scale: number; textBoxes: Box[]; maskBoxes: Box[]; deadlineMs: number }): Promise<Extract<FromWorker, { t: 'rescanned' }>> {
    const jobId = nextJobId();
    const msg = await this.request({ t: 'rescan', jobId, image, ...request });
    return msg as Extract<FromWorker, { t: 'rescanned' }>;
  }
```

Import `Box` from `../../shared/worker-protocol`.

### 4. Ring OCR — rewrite `ext/src/perception/rescan/halo.ts`

Replace the file:

```ts
// design.md §7.6 step 5 — OCR in a 24 px ring around each text redaction on the COMPOSED image.
// Every redaction box is blacked out on a working copy first, so the labels the compositor drew
// inside them are unreadable. Detection runs once over the region that holds all rings (split into
// merged clusters only when that region is larger than the detector's 960 px input, so small text
// isn't downscaled away). Only lines touching a ring are recognised. Returns the decoded text; the
// host guard decides whether it is a leak.

import type * as ort from 'onnxruntime-web';
import type { Box } from '../../shared/worker-protocol';
import { mergeUp } from '../compose/merge-up';
import { detectText } from '../models/ocr-det';
import { recognizeLine } from '../models/ocr-rec';

const HALO_PX = 24;
const DETECTOR_MAX_SIDE_PX = 960;

export interface OcrRescanModels {
  detSession: ort.InferenceSession;
  recSession: ort.InferenceSession;
  vocabulary: readonly string[];
}

export interface RingOcrInput {
  scale: number;
  textBoxes: readonly Box[];
  maskBoxes: readonly Box[];
  deadlineMs: number;
}

export interface RingOcrResult {
  lines: { box: Box; text: string }[];
  incomplete: boolean;
}

export function haloAround([x, y, w, h]: Box, px = HALO_PX): Box {
  return [x - px, y - px, w + px * 2, h + px * 2];
}

function scaled([x, y, w, h]: Box, s: number): Box {
  return [x * s, y * s, w * s, h * s];
}

function intersects([ax, ay, aw, ah]: Box, [bx, by, bw, bh]: Box): boolean {
  return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
}

function clampTo([x, y, w, h]: Box, width: number, height: number): Box | null {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(width, Math.ceil(x + w));
  const y1 = Math.min(height, Math.ceil(y + h));
  return x1 > x0 && y1 > y0 ? [x0, y0, x1 - x0, y1 - y0] : null;
}

function union(boxes: readonly Box[]): Box {
  const x0 = Math.min(...boxes.map((b) => b[0]));
  const y0 = Math.min(...boxes.map((b) => b[1]));
  const x1 = Math.max(...boxes.map((b) => b[0] + b[2]));
  const y1 = Math.max(...boxes.map((b) => b[1] + b[3]));
  return [x0, y0, x1 - x0, y1 - y0];
}

export async function ringOcr(
  ort_: typeof ort,
  models: OcrRescanModels | null,
  webpBytes: ArrayBuffer,
  input: RingOcrInput,
  now: () => number = () => performance.now(),
): Promise<RingOcrResult> {
  if (input.textBoxes.length === 0) return { lines: [], incomplete: false };
  if (!models) return { lines: [], incomplete: true };

  const started = now();
  const overBudget = () => now() - started > input.deadlineMs;
  const s = input.scale;

  const bitmap = await createImageBitmap(new Blob([webpBytes], { type: 'image/webp' }));
  try {
    const work = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = work.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    ctx.fillStyle = '#000000';
    for (const box of input.maskBoxes) {
      const [x, y, w, h] = scaled(box, s);
      ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    }

    const rings = input.textBoxes.map((b) => scaled(haloAround(b), s));
    const whole = clampTo(union(rings), work.width, work.height);
    if (!whole) return { lines: [], incomplete: false };
    const regions =
      Math.max(whole[2], whole[3]) <= DETECTOR_MAX_SIDE_PX
        ? [whole]
        : mergeUp(rings).map((r) => clampTo(r as Box, work.width, work.height)).filter((r): r is Box => r !== null);

    const lines: RingOcrResult['lines'] = [];
    for (const [rx, ry, rw, rh] of regions) {
      if (overBudget()) return { lines, incomplete: true };
      const crop = new OffscreenCanvas(rw, rh);
      crop.getContext('2d')!.drawImage(work, rx, ry, rw, rh, 0, 0, rw, rh);
      for (const detected of await detectText(models.detSession, ort_, crop)) {
        const [lx, ly, lw, lh] = detected.box;
        const inImage: Box = [rx + lx, ry + ly, lw, lh];
        if (!rings.some((ring) => intersects(inImage, ring))) continue;
        if (overBudget()) return { lines, incomplete: true };
        const lineCanvas = new OffscreenCanvas(Math.max(1, Math.round(lw)), Math.max(1, Math.round(lh)));
        lineCanvas.getContext('2d')!.drawImage(crop, lx, ly, lw, lh, 0, 0, lineCanvas.width, lineCanvas.height);
        const { text } = await recognizeLine(models.recSession, ort_, lineCanvas, models.vocabulary);
        if (text.trim().length === 0) continue;
        lines.push({ box: [inImage[0] / s, inImage[1] / s, inImage[2] / s, inImage[3] / s], text });
      }
    }
    return { lines, incomplete: false };
  } finally {
    bitmap.close();
  }
}
```

`checkHalosForText` is deleted. `OcrRescanModels` keeps its name and shape, because
`detect/text-region.ts`, `test/browser/ocr-detection.spec.ts` and
`test/browser/pdf-scanned-canvas.spec.ts` import it.

### 5. Worker handler — `ext/src/perception/worker.ts`

Replace `handleRescan` and fix its import (`checkHalosForText` → `ringOcr`):

```ts
async function handleRescan(msg: Extract<ToWorker, { t: 'rescan' }>): Promise<void> {
  const started = performance.now();
  const faceSession = faceModelId && registry ? await registry.get(faceModelId).catch(() => null) : null;
  const faces: Box[] = faceSession
    ? (await recheckFacesOnComposedImage(faceSession, ort, msg.image)).map(([x, y, w, h]) => [x / msg.scale, y / msg.scale, w / msg.scale, h / msg.scale] as Box)
    : [];
  const ocrModels = msg.textBoxes.length > 0 ? await loadOcrRescanModels() : null;
  const remaining = Math.max(0, msg.deadlineMs - (performance.now() - started));
  const ocr = await ringOcr(ort, ocrModels, msg.image, { scale: msg.scale, textBoxes: msg.textBoxes, maskBoxes: msg.maskBoxes, deadlineMs: remaining });
  post({ t: 'rescanned', jobId: msg.jobId, faces, ringText: ocr.lines, incomplete: ocr.incomplete });
}
```

Add `Box` to the type import from `../shared/worker-protocol`.

### 6. Host judgement + budget — rewrite `ext/src/host/privacy/guard/image-rescan.ts`

```ts
// design.md §7.6 step 5 — the guard's image re-scan, on the COMPOSED output. A face anywhere, or
// ring text that is a valid HIGH/CRITICAL pattern or overlaps a sealed value, is a hit: one
// recompose with +50 % boxes, then drop. Anything that can't finish within the budget is
// `incomplete`, and the image is not sent.

import { digitsOnly, findAll, normalizeForMatching } from '@aegis/recognizers';
import { entityClass, type Policy } from '@aegis/policy';
import type { Box } from '../types';
import { classAtLeast } from './sweeps';

export const IMAGE_RESCAN_BUDGET_MS = 1500;
export const VISUAL_ENTITIES: ReadonlySet<string> = new Set(['FACE', 'ID_DOCUMENT', 'QR_CODE', 'SIGNATURE']);
const MIN_SHARED_RUN = 4;

export interface RedactionRegion {
  entity: string;
  boxes: Box[];
  placeholder: string | null;
}

export interface RescanFindings {
  faces: Box[];
  ringText: { box: Box; text: string }[];
  incomplete: boolean;
}

export interface ImageRescanDeps {
  rescan: (imageBytes: ArrayBuffer, regions: readonly RedactionRegion[], deadlineMs: number) => Promise<RescanFindings>;
  recompose: (dilatedRegions: readonly RedactionRegion[]) => Promise<ArrayBuffer>;
}

export type ImageRescanOutcome =
  | { verdict: 'clean'; imageBytes: ArrayBuffer }
  | { verdict: 'recomposed'; imageBytes: ArrayBuffer }
  | { verdict: 'dropped' }
  | { verdict: 'incomplete' };

const DILATION_FACTOR = 0.5;

export function dilateForRescan([x, y, w, h]: Box, factor = DILATION_FACTOR): Box {
  const dx = (w * factor) / 2;
  const dy = (h * factor) / 2;
  return [x - dx, y - dy, w + dx * 2, h + dy * 2];
}

function sharesRun(haystack: string, needle: string, n: number): boolean {
  for (let i = 0; i + n <= needle.length; i++) {
    if (haystack.includes(needle.slice(i, i + n))) return true;
  }
  return false;
}

/** True when OCR'd ring text is sensitive: a checksum/pattern-valid HIGH+ entity, or ≥ 4
 * consecutive characters of a value the vault sealed this session. `sealed` are
 * `vault.normalizedValues()`. */
export function isLeakText(text: string, policy: Policy, sealed: readonly string[]): boolean {
  for (const match of findAll(text)) {
    if (match.valid && classAtLeast(entityClass(policy, match.entity), 'HIGH')) return true;
  }
  const flat = normalizeForMatching(text).toLowerCase().replace(/\s+/g, '');
  const digits = digitsOnly(text);
  for (const value of sealed) {
    const needle = value.replace(/\s+/g, '');
    if (needle.length < MIN_SHARED_RUN) continue;
    if (sharesRun(flat, needle, MIN_SHARED_RUN)) return true;
    if (digits.length >= MIN_SHARED_RUN && /^\d+$/.test(needle) && sharesRun(digits, needle, MIN_SHARED_RUN)) return true;
  }
  return false;
}

export interface RescanPolicy {
  isLeak: (text: string) => boolean;
  budgetMs?: number;
  now?: () => number;
}

export async function runImageRescan(imageBytes: ArrayBuffer, regions: readonly RedactionRegion[], deps: ImageRescanDeps, judge: RescanPolicy): Promise<ImageRescanOutcome> {
  const now = judge.now ?? (() => performance.now());
  const budget = judge.budgetMs ?? IMAGE_RESCAN_BUDGET_MS;
  const started = now();
  const remaining = () => budget - (now() - started);
  const hitCount = (f: RescanFindings) => f.faces.length + f.ringText.filter((line) => judge.isLeak(line.text)).length;

  if (remaining() <= 0) return { verdict: 'incomplete' };
  const first = await deps.rescan(imageBytes, regions, remaining());
  if (first.incomplete || remaining() <= 0) return { verdict: 'incomplete' };
  if (hitCount(first) === 0) return { verdict: 'clean', imageBytes };

  const dilated = regions.map((r) => ({ ...r, boxes: r.boxes.map((b) => dilateForRescan(b)) }));
  const recomposed = await deps.recompose(dilated);
  if (remaining() <= 0) return { verdict: 'incomplete' };
  const second = await deps.rescan(recomposed, dilated, remaining());
  if (second.incomplete) return { verdict: 'incomplete' };
  return hitCount(second) === 0 ? { verdict: 'recomposed', imageBytes: recomposed } : { verdict: 'dropped' };
}
```

`digitsOnly` and `normalizeForMatching` are exported by `@aegis/recognizers` (the vault already
imports both). `entityClass` and `Policy` come from `@aegis/policy`. `classAtLeast` is exported
from `./sweeps`.

### 7. Guard step 5 — `ext/src/host/privacy/guard/guard.ts`

1. Add to `GuardDeps`:

```ts
  /** Called once per guard run with what step 5 did to the image — for the ledger and panel. */
  onImageOutcome?: (outcome: ImageOutcome) => void;
  /** Overrides IMAGE_RESCAN_BUDGET_MS (tests only). */
  rescanBudgetMs?: number;
```

   and export `export type ImageOutcome = 'none' | 'clean' | 'recomposed' | 'dropped' | 'incomplete' | 'no-rescan';`.

2. Replace `runStep5`:

```ts
async function runStep5(payload: SanitizedContext, policy: Policy, vault: Vault, deps: GuardDeps): Promise<SanitizedContext> {
  if (!payload.image) {
    deps.onImageOutcome?.('none');
    return payload;
  }
  if (!deps.imageRescan) {
    deps.onImageOutcome?.('no-rescan');
    return { ...payload, image: null };
  }
  const regions = payload.redactions.map((r) => ({ entity: r.entity as string, boxes: r.boxes as Box[], placeholder: r.ref ?? null }));
  const sealed = [...vault.normalizedValues()];
  let outcome: ImageRescanOutcome;
  try {
    outcome = await runImageRescan(base64ToArrayBuffer(payload.image.data), regions, deps.imageRescan, {
      isLeak: (text) => isLeakText(text, policy, sealed),
      budgetMs: deps.rescanBudgetMs,
    });
  } catch {
    outcome = { verdict: 'incomplete' };
  }
  deps.onImageOutcome?.(outcome.verdict);
  if (outcome.verdict === 'dropped' || outcome.verdict === 'incomplete') return { ...payload, image: null };
  if (outcome.verdict === 'clean') return payload;
  return { ...payload, image: { ...payload.image, data: arrayBufferToBase64(outcome.imageBytes), sha256: await sha256Hex(outcome.imageBytes) } };
}
```

   Call it as `await runStep5(payload, policy, vault, deps)`. Import `isLeakText` and
   `ImageRescanOutcome` from `./image-rescan`. The `catch` turns a worker crash (a
   `WorkerTerminatedError` from `client.rescan`) into `incomplete`. Today such a crash throws out of
   `guard()` and the session reports `BLOCKED`/`SCHEMA`.

### 8. Session wiring — `ext/src/host/session.ts`

Replace the `imageRescanDeps = { … }` block (lines ~466–478):

```ts
        imageRescanDeps = {
          rescan: async (imageBytes, regions, deadlineMs) => {
            const textBoxes = regions.filter((r) => !VISUAL_ENTITIES.has(r.entity)).flatMap((r) => r.boxes);
            const maskBoxes = regions.flatMap((r) => r.boxes);
            const result = await client.rescan(imageBytes, { scale, textBoxes, maskBoxes, deadlineMs });
            return { faces: result.faces as Box[], ringText: result.ringText as { box: Box; text: string }[], incomplete: result.incomplete };
          },
          recompose: async (dilatedRegions) => {
            const composed = await client.compose([...dilatedRegions], [], scale, this.deps.ablation === 'blackbox');
            return composed.webp;
          },
        };
```

Capture the outcome and report it:

```ts
      let imageOutcome: ImageOutcome = 'none';
      ...
      guarded = await guard(context, this.policy, this.vault, {
        imageRescan: imageRescanDeps,
        canaries: this.deps.canaries,
        onImageOutcome: (o) => { imageOutcome = o; },
      });
```

After the guard `try/catch`, and before `if (this.isFinished()) return;`:

```ts
      if (perceptionStatus) {
        const withOutcome = { ...perceptionStatus, imageOutcome };
        this.deps.onEvent({ type: 'perception', stepId, status: withOutcome });
        const entry = this.ledger.latest();
        if (entry?.stepId === stepId && entry.perception) entry.perception = { ...entry.perception, status: withOutcome };
      }
```

`ImageOutcome` comes from `./privacy/guard/guard` and `VISUAL_ENTITIES` from
`./privacy/guard/image-rescan`.

### 9. Status type + UI

- `run-step.ts` `PerceptionStepStatus`: add `imageOutcome?: ImageOutcome;`. Import the type from
  `../privacy/guard/guard`; that host → host import is allowed.
- `ext/src/ui/PerceptionStatus.tsx`: add and export

```ts
export function describeImageOutcome(outcome: PerceptionStepStatus['imageOutcome']): { text: string; warn: boolean } | null {
  switch (outcome) {
    case 'dropped':
      return { text: 'Image withheld by the guard: sensitive text or a face was still readable after the redactions were enlarged.', warn: true };
    case 'incomplete':
      return { text: 'Image withheld by the guard: the safety re-check did not finish in time (or its OCR model was unavailable).', warn: true };
    case 'no-rescan':
      return { text: 'Image withheld: no perception worker was available to re-check it.', warn: true };
    case 'recomposed':
      return { text: 'Image sent with enlarged redaction boxes (the re-check found text at a box edge).', warn: false };
    default:
      return null;
  }
}
```

  Render it right after the `perception-reason` block:

```tsx
      {(() => {
        const note = describeImageOutcome(status.imageOutcome);
        return note ? <div data-testid="perception-image-outcome" style={{ color: note.warn ? '#b00' : '#555', margin: '2px 0' }}>{note.text}</div> : null;
      })()}
```

## Tests

### Unit — rewrite `ext/test/unit/image-rescan.spec.ts`

```ts
import { describe, expect, it, vi } from 'vitest';
import { defaultPolicy } from '@aegis/policy';
import { dilateForRescan, isLeakText, runImageRescan, type ImageRescanDeps, type RedactionRegion, type RescanFindings } from '../../src/host/privacy/guard/image-rescan';

const IMAGE = new ArrayBuffer(4);
const REGIONS: RedactionRegion[] = [{ entity: 'AADHAAR', boxes: [[10, 10, 20, 20]], placeholder: '⟪AADHAAR#1⟫' }];
const none: RescanFindings = { faces: [], ringText: [], incomplete: false };
const judge = { isLeak: (t: string) => isLeakText(t, defaultPolicy, ['234567890124']) };

describe('isLeakText', () => {
  it('ignores our own labels and ordinary field labels', () => {
    expect(isLeakText('AADHAAR#1', defaultPolicy, ['234567890124'])).toBe(false);
    expect(isLeakText('Aadhaar number', defaultPolicy, ['234567890124'])).toBe(false);
  });
  it('flags a checksum-valid Aadhaar', () => {
    expect(isLeakText('2345 6789 0124', defaultPolicy, [])).toBe(true);
  });
  it('flags a 4-character tail of a sealed value', () => {
    expect(isLeakText('..0124', defaultPolicy, ['234567890124'])).toBe(true);
    expect(isLeakText('012', defaultPolicy, ['234567890124'])).toBe(false);
  });
});

describe('runImageRescan', () => {
  it('clean when nothing is found', async () => {
    const deps: ImageRescanDeps = { rescan: vi.fn().mockResolvedValue(none), recompose: vi.fn() };
    expect(await runImageRescan(IMAGE, REGIONS, deps, judge)).toEqual({ verdict: 'clean', imageBytes: IMAGE });
    expect(deps.recompose).not.toHaveBeenCalled();
  });
  it('label text in the ring is not a hit', async () => {
    const deps: ImageRescanDeps = { rescan: vi.fn().mockResolvedValue({ ...none, ringText: [{ box: [0, 0, 5, 5], text: 'Aadhaar number' }] }), recompose: vi.fn() };
    expect((await runImageRescan(IMAGE, REGIONS, deps, judge)).verdict).toBe('clean');
  });
  it('a leaked tail recomposes once with +50% boxes, then accepts a clean pass', async () => {
    const recomposed = new ArrayBuffer(8);
    const rescan = vi.fn().mockResolvedValueOnce({ ...none, ringText: [{ box: [30, 10, 6, 20], text: '0124' }] }).mockResolvedValueOnce(none);
    const recompose = vi.fn().mockResolvedValue(recomposed);
    expect(await runImageRescan(IMAGE, REGIONS, { rescan, recompose }, judge)).toEqual({ verdict: 'recomposed', imageBytes: recomposed });
    expect((recompose.mock.calls[0]![0] as RedactionRegion[])[0]!.boxes[0]).toEqual(dilateForRescan([10, 10, 20, 20]));
  });
  it('drops after a second hit and never recomposes twice', async () => {
    const rescan = vi.fn().mockResolvedValue({ ...none, faces: [[0, 0, 10, 10]] });
    const recompose = vi.fn().mockResolvedValue(new ArrayBuffer(8));
    expect(await runImageRescan(IMAGE, REGIONS, { rescan, recompose }, judge)).toEqual({ verdict: 'dropped' });
    expect(recompose).toHaveBeenCalledTimes(1);
  });
  it('incomplete when the worker says so', async () => {
    const deps: ImageRescanDeps = { rescan: vi.fn().mockResolvedValue({ ...none, incomplete: true }), recompose: vi.fn() };
    expect(await runImageRescan(IMAGE, REGIONS, deps, judge)).toEqual({ verdict: 'incomplete' });
  });
  it('incomplete when the budget is spent before the second pass', async () => {
    let t = 0;
    const rescan = vi.fn(async () => { t += 1000; return { ...none, faces: [[0, 0, 1, 1]] as [number, number, number, number][] }; });
    const recompose = vi.fn(async () => { t += 1000; return new ArrayBuffer(1); });
    expect(await runImageRescan(IMAGE, REGIONS, { rescan, recompose }, { ...judge, budgetMs: 1500, now: () => t })).toEqual({ verdict: 'incomplete' });
  });
  it('passes the remaining budget to the worker', async () => {
    const rescan = vi.fn().mockResolvedValue(none);
    await runImageRescan(IMAGE, REGIONS, { rescan, recompose: vi.fn() }, { ...judge, budgetMs: 1500, now: () => 0 });
    expect(rescan.mock.calls[0]![2]).toBe(1500);
  });
});
```

### Unit — guard (`ext/test/unit/guard.spec.ts`, new describe)

- A payload with an image and no `imageRescan` dep → `image: null`, `onImageOutcome('no-rescan')`.
- `imageRescan.rescan` throws → `image: null`, outcome `incomplete`, and `guard()` does **not**
  throw.
- No image → outcome `none`.

### Unit — session (`ext/test/unit/session.spec.ts:510-547`)

Change `perceptionWithRescanHits(hits)` to `perceptionWithRescan(findings)`, where
`rescan: vi.fn(async () => ({ t: 'rescanned', jobId: 'j', ...findings }))`:
- "an image the rescan drops …": `findings = { faces: [], ringText: [{ box: [10, 50, 80, 12], text: '2345 6789 0124' }], incomplete: false }`.
  Everything else is unchanged.
- "a clean image is in both …": `findings = { faces: [], ringText: [], incomplete: false }`.
- New test: `findings.incomplete = true` → the sent image is `null` and the last `perception` event
  has `status.imageOutcome === 'incomplete'`.

### Unit — UI (`ext/test/unit/perception-status.spec.ts`)

`describeImageOutcome`: `dropped` and `incomplete` → `warn: true`; `recomposed` →
`warn: false`; `clean`, `none` and `undefined` → `null`.

### Unit — run-step (`ext/test/unit/run-step.spec.ts`)

New: `normalizeBitmap` is called with `(bitmap, viewport.w, viewport.h)`, and the bitmap it returns
(not the original) is the one passed to `client.perceive`.

### Browser — rewrite `ext/test/browser/halo-rescan.spec.ts` for `ringOcr`

Keep the file's `beforeAll`/`afterAll` model loading. Drawing helper: a 400×200 white canvas, text
`bold 24px sans-serif`, redaction boxes drawn black with white label text, exactly as
`compositor.ts` draws them, then `encodeWebp`. Cases:

1. **Label inside box → no ring text.** Draw `SECRET123` at (50,50), cover it fully with a black
   box `[46, 46, w+8, 32]`, and draw the white label `⟪AADHAAR#1⟫` inside. `ringOcr` with
   `textBoxes = maskBoxes = [box]`, `scale: 1` → `lines` contains no line whose text includes
   `AADHAAR`.
2. **Digit tail outside box → ring text contains it.** Draw `234567890124`. Cover all but the last
   character's measured width (reuse the file's current measuring approach). Expect at least one
   line, and `isLeakText(line.text, defaultPolicy, ['234567890124'])` true for some line.
3. **Adjacent label → recognised but not a leak.** Draw `Aadhaar number` 30 px left of a fully
   covered value box. Every returned line has `isLeakText(…) === false`.
4. **Scale 0.5.** Case 2 drawn on an 800×400 canvas, downscaled to 400×200 before encoding;
   `ringOcr` with CSS boxes and `scale: 0.5`. The tail is still found, and the returned box's x is
   within 24 px of the CSS-pixel box's right edge.
5. **No models → incomplete.** `ringOcr(ort, null, bytes, { …, textBoxes: [box] })` →
   `{ lines: [], incomplete: true }`. With `textBoxes: []` → `incomplete: false`.
6. **Deadline.** `now` stub that advances 1000 ms per call, `deadlineMs: 1` →
   `incomplete: true`.

### Browser — DPR (`ext/test/browser/`, new `dpr-capture.spec.ts`)

Build a 2560×1440 `ImageBitmap` (an `OffscreenCanvas` with a black square at device pixels
(400,400,200,200)). Call `toViewportPixels(bitmap, 1280, 720)` and assert the result is 1280×720,
and that pixel (250,250) is black and (150,150) is not. This proves boxes in CSS pixels land on
the right pixels after normalisation.

### AC-7

The existing killed-worker test must still yield no image. With step 7's `catch`, a worker killed
during rescan now yields `incomplete` → no image.

## Measurement (acceptance)

Run the dev split on the same machine as the R-baseline:

```bash
cd eval && .venv/bin/aegis-eval run --split dev
```

Compare against the R-baseline report:

| Metric | Baseline | Target |
|---|---|---|
| guard p50 / p95 (metric 5 per-stage) | 17.9 s / 26.3 s | p50 < 500 ms |
| image-dropped rate on form fixtures (steps with `imageOutcome ∈ {dropped, incomplete}` ÷ steps with an image) | measure | < 10 % |
| leak count | baseline | ≤ baseline |

The runner exports the ledger, which now carries `perception.status.imageOutcome`. Add the
dropped-rate count to `eval/src/aegis_eval/report/scoreboard.py`: count ledger entries whose
`perception.status.imageOutcome` is `dropped` or `incomplete`, divided by entries whose outcome is
not `none`. Report it as `image_dropped_rate` with n.

**Acceptance:**
- [ ] All new and updated unit and browser tests pass (`pnpm -r test`).
- [ ] The dev-split numbers are recorded in `tasks.md` §1 against the baseline; guard p50 and the
  dropped rate are within target, or the miss is recorded with its failure cases.
- [ ] Digit-tail browser test (case 2) passes: the tail is detected, so it is never shipped
  un-recomposed.
- [ ] AC-7 still passes.
