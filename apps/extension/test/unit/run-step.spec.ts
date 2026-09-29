// Every exit of `runPerceptionStep` must say WHY the step did or did not get vision — the
// production regression this guards against is a `captureVisibleTab` permission failure that was
// swallowed into `null` and silently turned every real-site step into DOM-only processing.

import { describe, expect, it, vi } from 'vitest';
import { runPerceptionStep, GeometryDigestGuard, prioritiseVisionNodes } from '../../src/host/perception-client/run-step';
import type { PerceptionClient } from '../../src/host/perception-client/client';
import { WorkerTerminatedError } from '../../src/host/perception-client/client';
import { classifyCaptureError } from '../../src/host/capture/classify';
import type { WireScreenNode } from '../../src/shared/messages';
import type { FromWorker, PerceiveDiagnostics } from '../../src/shared/worker-protocol';

function node(id: string, role: string, box: [number, number, number, number]): WireScreenNode {
  return {
    id,
    frame: 'f-0',
    role,
    name: '',
    box,
    z: 0,
    state: { focused: false, disabled: false, readonly: false, required: false, hasValue: false, valueLen: 0, occluded: false, volatile: false },
    affordances: [],
    container: 'root',
    textRuns: [],
  };
}

// A page fully explained by DOM text plus one <img> (so a capture IS needed).
const TEXT = node('n-1', 'heading', [0, 0, 800, 600]);
const IMG = node('n-2', 'img', [10, 10, 200, 200]);

const DIAGNOSTICS: PerceiveDiagnostics = {
  backend: 'wasm',
  providers: { face: 'wasm', vit: 'wasm', ocrDet: 'wasm', ocrRec: 'wasm' },
  available: { face: true, vit: true, ocr: true },
  inferences: { face: 1, vitRegion: 1, vitFullFrame: 0, ocrDet: 1, ocrRec: 2 },
  ms: { face: 30, vit: 200, ocr: 90, screenLabel: 0, total: 330 },
  regions: [{ regionId: 'n-2', outcome: 'analysed', ms: 320, faces: 1, faceTopScore: 0.9, ocrLinesDetected: 2, ocrLinesRecognized: 2, ocrEntities: ['AADHAAR'], vit: { label: 'photo of a person', score: 0.6, accepted: false } }],
  modelErrors: [],
};

// Sized like the tests' 800x600 viewport, i.e. a capture at devicePixelRatio 1.
function fakeBitmap(width = 800, height = 600): ImageBitmap {
  return { close: vi.fn(), width, height } as unknown as ImageBitmap;
}

function clientReturning(perceived: Extract<FromWorker, { t: 'perceived' }> | Error): PerceptionClient {
  return {
    perceive: vi.fn(async () => {
      if (perceived instanceof Error) throw perceived;
      return perceived;
    }),
  } as unknown as PerceptionClient;
}

function deps(capture: () => Promise<Awaited<ReturnType<Parameters<typeof runPerceptionStep>[1]['capture']>>>, client: PerceptionClient) {
  return {
    client,
    capture: vi.fn(capture),
    digestGuard: new GeometryDigestGuard(),
    reobserveGeometry: async () => [TEXT, IMG],
    viewport: { w: 800, h: 600 },
  };
}

describe('runPerceptionStep — capture outcomes are reported, never swallowed', () => {
  it('captures and runs full-frame vision every step, even on a page the DOM text fully explains', async () => {
    const client = clientReturning({ t: 'perceived', jobId: 'j', candidates: [], timings: {}, timedOut: [], diagnostics: DIAGNOSTICS } as unknown as Extract<FromWorker, { t: 'perceived' }>);
    const d = { ...deps(async () => ({ ok: true, bitmap: fakeBitmap() }), client), reobserveGeometry: async () => [TEXT] };
    const result = await runPerceptionStep([TEXT], d);
    expect(d.capture).toHaveBeenCalledTimes(1);
    expect(client.perceive).toHaveBeenCalledWith(expect.anything(), [{ id: 'full-frame', box: [0, 0, 800, 600], kind: 'full' }], expect.any(Number), true, expect.any(Array));
    expect(result.captured).toBe(true);
    expect(result.status).toMatchObject({ capture: 'ok', worker: 'ok', level: 'L1', regionsRequested: 0 });
  });

  it("reports the real Chromium permission error as 'permission' and sends no image", async () => {
    const chromiumError = new Error("Either the '<all_urls>' or 'activeTab' permission is required.");
    const client = clientReturning(new Error('unused'));
    const d = deps(async () => ({ ok: false, reason: classifyCaptureError(chromiumError) }), client);
    const result = await runPerceptionStep([TEXT, IMG], d);
    expect(result.captured).toBe(false);
    expect(result.visionCandidates).toEqual([]);
    expect(result.status).toMatchObject({ capture: 'permission', worker: 'not-called', level: 'L0', regionsRequested: 1 });
    expect(client.perceive).not.toHaveBeenCalled();
  });

  it("reports geometry-changed when the page moved during capture", async () => {
    const bitmap = fakeBitmap();
    const d = { ...deps(async () => ({ ok: true as const, bitmap }), clientReturning(new Error('unused'))), reobserveGeometry: async () => [TEXT, node('n-2', 'img', [300, 300, 200, 200])] };
    const result = await runPerceptionStep([TEXT, IMG], d);
    expect(result.status.capture).toBe('geometry-changed');
    expect(bitmap.close).toHaveBeenCalled();
  });

  it('a HiDPI capture that cannot be resized to CSS pixels yields no image (fails closed)', async () => {
    const bitmap = fakeBitmap(1600, 1200);
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('no')));
    const d = deps(async () => ({ ok: true, bitmap }), clientReturning(new Error('unused')));
    const result = await runPerceptionStep([TEXT, node('n-2', 'img', [300, 300, 200, 200])], d);
    vi.unstubAllGlobals();
    expect(result.captured).toBe(false);
    expect(result.status.capture).toBe('decode');
    expect(bitmap.close).toHaveBeenCalled();
  });

  it('a HiDPI capture is resized to the CSS viewport before any box is applied', async () => {
    const resized = fakeBitmap(800, 600);
    const resize = vi.fn().mockResolvedValue(resized);
    vi.stubGlobal('createImageBitmap', resize);
    const client = clientReturning(new Error('stop after resize'));
    const d = deps(async () => ({ ok: true, bitmap: fakeBitmap(1600, 1200) }), client);
    await runPerceptionStep([TEXT, node('n-2', 'img', [300, 300, 200, 200])], d);
    vi.unstubAllGlobals();
    expect(resize).toHaveBeenCalledWith(expect.anything(), { resizeWidth: 800, resizeHeight: 600, resizeQuality: 'high' });
  });

  it('a worker failure mid-perceive yields no image and worker: failed instead of throwing out of the step', async () => {
    const d = deps(async () => ({ ok: true, bitmap: fakeBitmap() }), clientReturning(new WorkerTerminatedError()));
    const result = await runPerceptionStep([TEXT, IMG], d);
    expect(result.captured).toBe(false);
    expect(result.visionCandidates).toEqual([]);
    expect(result.status).toMatchObject({ capture: 'ok', worker: 'failed' });
  });

  it("passes the worker's real diagnostics through and tags OCR candidates with an ocr: source", async () => {
    const perceived: Extract<FromWorker, { t: 'perceived' }> = {
      t: 'perceived',
      jobId: 'j-1',
      candidates: [
        { entity: 'FACE', box: [20, 20, 50, 50], score: 0.9, regionId: 'n-2', channel: 'vision' },
        { entity: 'AADHAAR', box: [20, 100, 150, 20], score: 0.95, regionId: 'n-2', channel: 'text-ocr', source: 'pattern:aadhaar+verhoeff', value: '2345 6789 0124' },
      ],
      timings: {},
      timedOut: [],
      diagnostics: DIAGNOSTICS,
    };
    const d = deps(async () => ({ ok: true, bitmap: fakeBitmap() }), clientReturning(perceived));
    const result = await runPerceptionStep([TEXT, IMG], d);
    expect(result.captured).toBe(true);
    expect(result.status).toMatchObject({ capture: 'ok', worker: 'ok', regionsRequested: 1 });
    expect(result.status.diagnostics).toEqual(DIAGNOSTICS);
    expect(result.visionCandidates.map((c) => c.source)).toEqual(['vision:face', 'ocr:pattern:aadhaar+verhoeff']);
    // A picture-level finding belongs to its picture; text read from pixels is keyed by its own
    // box, so two values read in one picture stay two redactions.
    expect(result.visionCandidates[0]!.nodeId).toBe('n-2');
    expect(result.visionCandidates[1]!.nodeId).toBeUndefined();
    expect(result.visionCandidates[1]!.textRunId).toBe('ocr-full-frame:20,100,150,20');
  });
});

describe('classifyCaptureError', () => {
  it.each([
    ["Either the '<all_urls>' or 'activeTab' permission is required.", 'permission'],
    ['This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.', 'throttled'],
    ["The 'activeTab' permission is not in effect because this extension has not been in invoked.", 'permission'],
    ['Cannot access contents of url "chrome://settings/". Extension manifest must request permission to access this host.', 'restricted-page'],
    ['Cannot access a chrome:// URL', 'restricted-page'],
    ['The extensions gallery cannot be scripted.', 'restricted-page'],
    ['This page cannot be scripted due to an ExtensionsSettings policy.', 'restricted-page'],
    // Host access is not activeTab: this used to be labelled "activeTab not granted".
    ['Cannot access contents of url "https://accounts.example.test/login". Extension manifest must request permission to access this host.', 'host-access'],
    ['Cannot access contents of the page. Extension manifest must request permission to access the respective host.', 'host-access'],
    ['Failed to capture tab: view is invisible', 'not-visible'],
    ['No tab with id: 42.', 'no-tab'],
    ['No window with id: 7.', 'no-tab'],
    // Anything not matching one of Chrome's exact messages stays unknown, even if it says "permission".
    ['some other permission problem', 'unknown'],
    ['Failed to capture tab: unknown error', 'unknown'],
    ['something else entirely', 'unknown'],
  ])('%s → %s', (message, reason) => {
    expect(classifyCaptureError(new Error(message))).toBe(reason);
  });
});

describe('prioritiseVisionNodes — the deadline/budget cut from the tail, so the largest visible images go first', () => {
  const viewport = { w: 1000, h: 800 };
  it('orders by area inside the viewport, not DOM order; off-screen images go last', () => {
    const icon = { id: 'icon', box: [10, 10, 24, 24] as const };
    const photo = { id: 'photo', box: [100, 100, 400, 300] as const };
    const belowFold = { id: 'below', box: [0, 900, 800, 600] as const };
    const halfVisible = { id: 'half', box: [800, 0, 400, 400] as const }; // 200 of 400 px wide visible
    expect(prioritiseVisionNodes([icon, belowFold, halfVisible, photo], viewport).map((n) => n.id)).toEqual(['photo', 'half', 'icon', 'below']);
  });
});
