// The panel's perception mode label must be derived from what actually happened: model counters
// from the worker and the sources on the payload's own redactions — never from configuration.

import { describe, expect, it } from 'vitest';
import type { SanitizedContext } from '@aegis/protocol';
import { redactionsByChannel, summarizePerception } from '../../src/ui/PerceptionStatus';
import type { PerceptionStepStatus } from '../../src/host/perception-client/run-step';
import type { PerceiveDiagnostics } from '../../src/shared/worker-protocol';

type Redaction = SanitizedContext['redactions'][number];

function redaction(entity: string, sources: string[]): Redaction {
  return { ref: null, entity, class: 'HIGH', boxes: [[0, 0, 10, 10]], method: 'placeholder', confidence: 0.9, sources, unverified: false } as unknown as Redaction;
}

function diagnostics(overrides: Partial<PerceiveDiagnostics['inferences']> = {}, regions: PerceiveDiagnostics['regions'] = []): PerceiveDiagnostics {
  return {
    backend: 'wasm',
    providers: { face: 'wasm', vit: 'wasm', ocrDet: 'wasm', ocrRec: 'wasm' },
    available: { face: true, vit: true, ocr: true },
    inferences: { face: 0, vitRegion: 0, vitFullFrame: 0, ocrDet: 0, ocrRec: 0, ...overrides },
    ms: { face: 0, vit: 0, ocr: 0, screenLabel: 0, total: 0 },
    regions,
    modelErrors: [],
  };
}

const OK = (d: PerceiveDiagnostics, regionsRequested = 1): PerceptionStepStatus => ({ capture: 'ok', worker: 'ok', level: 'L0', regionsRequested, diagnostics: d });

describe('summarizePerception', () => {
  it('capture denied → DOM-only with the activeTab reason', () => {
    const s = summarizePerception({ capture: 'permission', worker: 'not-called', level: 'L0', regionsRequested: 2 }, [redaction('PASSWORD', ['dom:password'])]);
    expect(s.mode).toBe('DOM-only');
    expect(s.reason).toMatch(/activeTab not granted/);
    expect(s.modelsRan).toEqual({ clip: 0, face: 0, ocrDet: 0, ocrRec: 0 });
  });

  it('a grant lost on a cross-site navigation is reported as that, not as "activeTab not granted"', () => {
    const s = summarizePerception({ capture: 'grant-lost-navigation', worker: 'not-called', level: 'L0', regionsRequested: 1 }, []);
    expect(s.reason).toMatch(/moved to a different site/);
    expect(s.reason).not.toMatch(/activeTab not granted/);
  });

  it("host-access and unknown failures never claim activeTab, and show Chrome's own error text", () => {
    const hostAccess = summarizePerception({ capture: 'host-access', captureDetail: 'Cannot access contents of url "…".', worker: 'not-called', level: 'L0', regionsRequested: 1 }, []);
    expect(hostAccess.reason).not.toMatch(/activeTab/);
    expect(hostAccess.reason).toContain('[Chrome: Cannot access contents of url "…".]');
    const unknown = summarizePerception({ capture: 'unknown', captureDetail: 'Failed to capture tab: unknown error', worker: 'not-called', level: 'L0', regionsRequested: 1 }, []);
    expect(unknown.reason).toContain('[Chrome: Failed to capture tab: unknown error]');
  });

  it('models ran but produced no redaction → says so rather than claiming vision', () => {
    const s = summarizePerception(OK(diagnostics({ face: 1, vitRegion: 1, ocrDet: 1 })), [redaction('EMAIL', ['pattern:email'])]);
    expect(s.mode).toBe('DOM-only result (vision ran, found nothing)');
    expect(s.modelsRan.clip).toBe(1);
  });

  it('a guard-blocked step (no payload) does not read as "found nothing" when a model did find something', () => {
    // Real run, 2026-09-28: Wikipedia's Einstein article — YuNet found the portrait (0.91) but the
    // text guard blocked the step, so the panel had no payload redactions to read.
    const s = summarizePerception(
      OK(diagnostics({ face: 1, vitRegion: 1 }, [{ regionId: 'n-1', outcome: 'analysed', faces: 1, faceTopScore: 0.91, vit: { label: 'passport page', score: 0.6, accepted: true, entity: 'ID_DOCUMENT', entityScore: 0.99 } }])),
      [],
    );
    expect(s.mode).toBe('vision detected face, ID_DOCUMENT (not in a sent payload this step)');
  });

  it('each vision channel is named only when it produced a redaction', () => {
    const s = summarizePerception(OK(diagnostics({ face: 2, vitRegion: 2, ocrDet: 2, ocrRec: 3 })), [
      redaction('PASSWORD', ['dom:password']),
      redaction('AADHAAR', ['ocr:pattern:aadhaar+verhoeff']),
      redaction('FACE', ['vision:face']),
      redaction('ID_DOCUMENT', ['vision:id_document']),
    ]);
    expect(s.mode).toBe('DOM + OCR + face detection + vision/CLIP');
  });

  it('counts crops by real outcome, not by what was requested', () => {
    const s = summarizePerception(
      OK(diagnostics({ face: 1 }), 4),
      [],
    );
    expect(s.crops).toEqual({ requested: 4, analysed: 0, deadline: 0, budget: 0, noCapability: 0 });
    const s2 = summarizePerception(
      OK(diagnostics({ face: 1 }, [
        { regionId: 'n-1', outcome: 'analysed' },
        { regionId: 'n-2', outcome: 'deadline' },
        { regionId: 'n-3', outcome: 'deadline' },
        { regionId: 'n-4', outcome: 'budget' },
      ]), 4),
      [],
    );
    expect(s2.crops).toEqual({ requested: 4, analysed: 1, deadline: 2, budget: 1, noCapability: 0 });
  });

  it('a worker failure is reported even though capture succeeded', () => {
    const s = summarizePerception({ capture: 'ok', worker: 'failed', level: 'L0', regionsRequested: 1 }, []);
    expect(s.reason).toMatch(/worker failed/);
  });
});

describe('redactionsByChannel', () => {
  it('attributes by source prefix', () => {
    expect(
      redactionsByChannel([
        redaction('PASSWORD', ['dom:password']),
        redaction('EMAIL', ['pattern:email']),
        redaction('AADHAAR', ['ocr:pattern:aadhaar+verhoeff']),
        redaction('FACE', ['vision:face']),
      ]),
    ).toEqual({ dom: 1, text: 1, ocr: 1, vision: 1 });
  });
});
