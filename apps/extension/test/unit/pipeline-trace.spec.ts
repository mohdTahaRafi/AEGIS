// The run-order trace lists the stages in the order the code runs them and attributes each
// redaction to the stage whose source produced it — from the step's own diagnostics and payload.

import { describe, expect, it } from 'vitest';
import type { SanitizedContext } from '@aegis/protocol';
import { buildPipelineTrace, describeSource } from '../../src/ui/PipelineTrace';
import type { PerceptionStepStatus } from '../../src/host/perception-client/run-step';
import type { PerceiveDiagnostics } from '../../src/shared/worker-protocol';

type Redaction = SanitizedContext['redactions'][number];

function redaction(entity: string, ref: string | null, sources: string[]): Redaction {
  return { ref, entity, class: 'HIGH', boxes: [[0, 0, 10, 10]], method: 'placeholder', confidence: 0.9, sources, unverified: false } as unknown as Redaction;
}

const diagnostics: PerceiveDiagnostics = {
  backend: 'wasm',
  providers: { face: 'wasm', vit: 'wasm', ocrDet: 'wasm', ocrRec: 'wasm' },
  available: { face: true, vit: true, ocr: true },
  inferences: { face: 2, vitRegion: 2, vitFullFrame: 1, ocrDet: 2, ocrRec: 3 },
  cachedRegions: 1,
  ms: { face: 12, vit: 380, ocr: 56, screenLabel: 70, total: 540 },
  regions: [
    { regionId: 'n-photo', outcome: 'analysed', faces: 1, faceTopScore: 0.91, ocrLinesDetected: 0, ocrEntities: [], vit: { label: 'portrait photo', score: 0.8, accepted: false } },
    { regionId: 'n-card', outcome: 'analysed', faces: 0, ocrLinesDetected: 3, ocrEntities: ['AADHAAR'], vit: { label: 'Aadhaar card', score: 0.56, accepted: true, entity: 'ID_DOCUMENT', entityScore: 0.98 } },
    { regionId: 'n-sign', outcome: 'analysed', cached: true, vit: { label: 'handwritten signature', score: 0.32, accepted: false, entity: 'SIGNATURE', entityScore: 0.32 } },
    { regionId: 'n-late', outcome: 'deadline' },
  ],
  modelErrors: [],
};

const status: PerceptionStepStatus = { capture: 'ok', worker: 'ok', level: 'L1', regionsRequested: 4, diagnostics };

function payload(redactions: Redaction[]): SanitizedContext {
  return { step_id: 's-1', nodes: [{}, {}, {}], text: [{}], redactions, coverage: { cleared: 0.16, redacted: 0.57, unanalysed: 0.27 }, image: { format: 'image/webp' } } as unknown as SanitizedContext;
}

const sent = payload([
  redaction('FACE', null, ['vision:face']),
  redaction('AADHAAR', '⟪AADHAAR#4⟫', ['ocr:aadhaar']),
  redaction('ID_DOCUMENT', null, ['vision:id_document']),
  redaction('EMAIL', '⟪EMAIL#2⟫', ['dom:email', 'pattern:email']),
  redaction('PASSWORD', null, ['dom:password']),
]);

describe('buildPipelineTrace', () => {
  it('lists the stages in execution order', () => {
    const stages = buildPipelineTrace({ status, payload: sent, protectedFields: [], guardBlock: null });
    expect(stages.map((s) => s.title.split(':')[0])).toEqual([
      'DOM read (content script)',
      'Screenshot',
      'Face detection',
      'Text in pictures',
      'Picture classification',
      'Whole-screen label',
      'Text recognisers + merge (sanitize)',
      'Screenshot redaction (compositor)',
      'Guard',
      'Sent to the model',
    ]);
  });

  it('attributes each redaction to the stage that produced it, with the models own findings', () => {
    const [dom, shot, face, ocr, clip, , text, compositor] = buildPipelineTrace({
      status,
      payload: sent,
      protectedFields: [
        { entity: 'EMAIL', label: 'Email ID *', sent: 'placeholder', ref: '⟪EMAIL#2⟫' },
        { entity: 'PASSWORD', label: 'Password *', sent: 'presence' },
      ],
      timings: { observe: 3, perceive: 600, sanitize: 81, guard: 426, server: 1900, validate: 1, act: 0 },
      guardBlock: null,
    });
    expect(dom!.lines).toContain('  EMAIL "Email ID *" → ⟪EMAIL#2⟫');
    expect(dom!.lines).toContain('  PASSWORD "Password *" → value never read');
    expect(shot!.lines.join('\n')).toMatch(/1 unchanged since an earlier step/);
    expect(shot!.lines.join('\n')).toMatch(/1 not analysed \(deadline\): left grey/);
    expect(face!.lines).toContain('n-photo: 1 face(s), top score 0.91');
    expect(face!.lines[0]).toBe('ran on 2 crop(s), 1 reused from an earlier step');
    expect(face!.lines).toContain('redacted: FACE (image region) ← YuNet face');
    expect(ocr!.lines).toContain('n-card: AADHAAR');
    expect(ocr!.lines).toContain('redacted: AADHAAR ⟪AADHAAR#4⟫ ← OCR text');
    expect(clip!.lines).toContain('n-card: looks like "Aadhaar card" (0.56) → ID_DOCUMENT 0.98 ✓ redacted');
    expect(clip!.lines).toContain('n-photo: looks like "portrait photo" (0.80) → nothing sensitive');
    expect(clip!.lines).toContain('n-sign: (reused) "handwritten signature"');
    expect(text!.lines).toContain('redacted: EMAIL ⟪EMAIL#2⟫ ← field label + email pattern');
    expect(text!.lines).toContain('redacted: PASSWORD (masked, no value read) ← field label');
    expect(text!.lines.at(-1)).toBe('after merging all stages: 5 redaction(s) (FACE 1 · AADHAAR 1 · ID_DOCUMENT 1 · EMAIL 1 · PASSWORD 1)');
    expect(shot!.lines).toContain('capture + all vision models below: 600 ms');
    expect(compositor!.lines).toEqual(['cleared 16% · redacted 57% · grey (unanalysed) 27%']);
  });

  it('a guard block ends the trace there, and says nothing was sent', () => {
    const stages = buildPipelineTrace({ status, payload: null, protectedFields: [], guardBlock: { rule: 'VAULT_LEAK' } });
    const last = stages.at(-1)!;
    expect(last.title).toBe('Guard');
    expect(last.status).toBe('blocked');
    expect(last.lines).toEqual(['BLOCKED: VAULT_LEAK. Nothing was sent']);
  });

  it('without a screenshot the vision stages are shown as skipped, with the reason', () => {
    const stages = buildPipelineTrace({ status: { capture: 'not-needed', worker: 'not-called', level: 'L0', regionsRequested: 0 }, payload: sent, protectedFields: [], guardBlock: null });
    expect(stages[1]).toMatchObject({ title: 'Screenshot', status: 'skipped', lines: ['not taken: not-needed'] });
    expect(stages[2]).toMatchObject({ status: 'skipped', lines: ['not run this step (no screenshot)'] });
  });

  it('stages still to come are pending, not reported as done', () => {
    const stages = buildPipelineTrace({ status, payload: null, protectedFields: [], guardBlock: null });
    expect(stages.at(-1)).toMatchObject({ title: 'Sent to the model', status: 'pending' });
    expect(stages[0]!.status).toBe('pending');
  });

  it('names each source by the stage that produces it', () => {
    expect(['dom:email', 'pattern:phone', 'label:person_name', 'ocr:pan', 'vision:face', 'vision:id_document', 'ner:per'].map(describeSource)).toEqual([
      'field label',
      'phone pattern',
      '"Label: value" text',
      'OCR text',
      'YuNet face',
      'CLIP',
      'NER model',
    ]);
  });
});
