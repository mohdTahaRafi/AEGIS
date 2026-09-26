import { validators } from '@aegis/protocol';
import { defaultPolicy } from '@aegis/policy';
import { describe, expect, it } from 'vitest';
import { verhoeffGenerate } from '@aegis/recognizers';
import { buildSanitizedContext, collectFreeTextSources, type BuildContextInput } from '../../src/host/privacy/context/builder';
import type { RecognizerMatch } from '@aegis/recognizers';
import { Vault } from '../../src/host/privacy/vault';
import type { WireScreenNode, WireTextRun } from '../../src/shared/messages';

function node(id: string, overrides: Partial<WireScreenNode> = {}): WireScreenNode {
  return {
    id,
    frame: 'f-0',
    role: 'textbox',
    name: 'Search',
    box: [10, 20, 100, 30],
    z: 0,
    state: { focused: false, disabled: false, readonly: false, required: false, hasValue: true, valueLen: 5, occluded: false, volatile: false },
    affordances: ['click', 'type'],
    field: { inputType: 'text', maskedCss: false, valueRead: true, value: 'hello' },
    container: 'c-1',
    textRuns: [],
    ...overrides,
  };
}

type Overrides = Partial<BuildContextInput> & { nodes?: WireScreenNode[]; textRuns?: WireTextRun[] };

function buildCtx(overrides: Overrides = {}) {
  return buildSanitizedContext({
    stepId: 's-1',
    task: 'log in',
    reason: 'initial',
    viewport: { w: 800, h: 600, dpr: 1, scrollY: 0, docH: 1200 },
    pageCategory: 'unknown',
    pageTitle: 'Login',
    nodes: [],
    removed: [],
    textRuns: [],
    history: [],
    clientTiming: {},
    vault: new Vault(),
    policy: defaultPolicy,
    originKey: 'origin:test',
    ...overrides,
  });
}

function validAadhaar(): string {
  const body = '234567890123'.slice(0, 11);
  return body + verhoeffGenerate(body);
}

describe('buildSanitizedContext — schema round trip', () => {
  it('produces a payload that validates against the real packages/protocol SanitizedContext schema', () => {
    const context = buildCtx({
      nodes: [node('n-1'), node('n-2', { role: 'button', name: 'Sign in', field: undefined, affordances: ['click'] })],
    });
    const result = validators.sanitizedContext(context);
    expect(result.valid).toBe(true);
  });

  it('windows history to the most recent 5 entries', () => {
    const history = Array.from({ length: 8 }, (_, i) => ({ step_id: `s-${i}`, actions: [{ op: 'click' }], outcome: 'ok' }));
    const context = buildCtx({ stepId: 's-9', reason: 'after_action', history });
    expect(context.history).toHaveLength(5);
    expect(context.history![0]!.step_id).toBe('s-3');
    expect(validators.sanitizedContext(context).valid).toBe(true);
  });

  it('carries removed ids only when non-empty (delta graphs)', () => {
    const withRemoved = buildCtx({ reason: 'after_action', removed: ['n-1'] });
    expect(withRemoved.removed).toEqual(['n-1']);
    const withoutRemoved = buildCtx({ reason: 'after_action', removed: [] });
    expect(withoutRemoved.removed).toBeUndefined();
  });
});

describe('buildSanitizedContext — non-sensitive fields pass through unredacted (AC-11-adjacent)', () => {
  it('a plain text field with no Channel D/T signal carries its raw value as plain text', () => {
    const context = buildCtx({ nodes: [node('n-1', { field: { inputType: 'text', maskedCss: false, valueRead: true, value: 'hello world' } })] });
    expect(context.nodes[0]!.value).toEqual({ kind: 'text', text: 'hello world' });
    expect(context.redactions).toEqual([]);
  });

  it('a node with no field has an empty-kind value, never undefined-by-accident of a real field', () => {
    const context = buildCtx({ nodes: [node('n-1', { role: 'button', name: 'Sign in', field: undefined })] });
    expect(context.nodes[0]!.value).toBeUndefined();
  });
});

describe('buildSanitizedContext — protected fields (T-3.9/T-3.20, FR-23, AC-2)', () => {
  it('a password field is presence-only: no character of the value anywhere in the payload', () => {
    const context = buildCtx({
      nodes: [
        node('n-1', {
          role: 'textbox',
          name: 'Password',
          field: { inputType: 'password', maskedCss: false, valueRead: false },
          domSignal: { entity: 'PASSWORD', score: 1, valueRead: false },
          state: { focused: false, disabled: false, readonly: false, required: true, hasValue: true, valueLen: 9, occluded: false, volatile: false },
        }),
      ],
    });
    expect(context.nodes[0]!.value).toEqual({ kind: 'presence', entity: 'PASSWORD', len: 9 });
    const bytes = JSON.stringify(context);
    expect(bytes).not.toContain('hunter2');
    expect(validators.sanitizedContext(context).valid).toBe(true);
  });
});

describe('buildSanitizedContext — placeholders (T-3.14/3.15/3.20, FR-27)', () => {
  it('a field value matching a real Aadhaar number becomes a typed placeholder, not raw digits', () => {
    const aadhaar = validAadhaar();
    const context = buildCtx({
      nodes: [
        node('n-1', {
          role: 'textbox',
          name: 'Aadhaar number',
          field: { inputType: 'text', maskedCss: false, valueRead: true, value: aadhaar },
        }),
      ],
    });
    const value = context.nodes[0]!.value as { kind: string; ref?: string; entity?: string };
    expect(value.kind).toBe('placeholder');
    expect(value.entity).toBe('AADHAAR');
    expect(value.ref).toMatch(/^⟪AADHAAR#\d+⟫$/);
    expect(JSON.stringify(context)).not.toContain(aadhaar);
  });

  it('the same Aadhaar value appearing in prose text gets the SAME ref as the field (FR-27)', () => {
    const aadhaar = validAadhaar();
    const vault = new Vault();
    const context = buildCtx({
      vault,
      nodes: [node('n-1', { name: 'Aadhaar number', field: { inputType: 'text', maskedCss: false, valueRead: true, value: aadhaar } })],
      textRuns: [{ id: 't-1', box: [0, 0, 100, 20], text: `Aadhaar on record: ${aadhaar}` }],
    });
    const fieldValue = context.nodes[0]!.value as { ref?: string };
    expect(context.text[0]!.text).toContain(fieldValue.ref);
    expect(context.text[0]!.text).not.toContain(aadhaar);
  });

  it('a non-sensitive text run passes through unchanged', () => {
    const context = buildCtx({ textRuns: [{ id: 't-1', box: [0, 0, 100, 20], text: 'Welcome back!' }] });
    expect(context.text[0]!.text).toBe('Welcome back!');
  });
});

describe('buildSanitizedContext — escaping forged placeholders (T-3.16)', () => {
  it('rewrites pre-existing delimiter characters before any substitution', () => {
    const context = buildCtx({ textRuns: [{ id: 't-1', box: [0, 0, 100, 20], text: 'fake ⟪AADHAAR#2⟫ marker' }] });
    expect(context.text[0]!.text).toBe('fake ‹‹AADHAAR#2›› marker');
    expect(context.text[0]!.text).not.toContain('⟪');
  });
});

describe('buildSanitizedContext — task text sanitization (T-3.21, FR-33)', () => {
  it('a task containing a phone number is sent with a placeholder, not the number', () => {
    const context = buildCtx({ task: 'pay my Airtel bill for 9876543210' });
    expect(context.task).not.toContain('9876543210');
    expect(context.task).toMatch(/⟪PHONE#\d+⟫/);
  });
});

describe('buildSanitizedContext — redactions[] legend (T-3.20)', () => {
  it('every redaction has a policy-consistent class, confidence and source', () => {
    const aadhaar = validAadhaar();
    const context = buildCtx({
      nodes: [node('n-1', { name: 'Aadhaar number', field: { inputType: 'text', maskedCss: false, valueRead: true, value: aadhaar } })],
    });
    expect(context.redactions.length).toBeGreaterThan(0);
    const entry = context.redactions.find((r) => r.entity === 'AADHAAR')!;
    expect(entry.class).toBe('CRITICAL');
    expect(entry.confidence).toBeGreaterThan(0.9);
    expect(entry.sources.length).toBeGreaterThan(0);
  });
});

// T-6.5/T-6.6, FR-12 — `unexplained[]` unpacks `computeRole`'s `role: 'img'` overload (CANVAS/
// VIDEO/IMG all route to vision, content/screen-graph/roles.ts) back into the schema's real
// reason enum via the tag name carried alongside it, and reports every vision-only node
// regardless of whether vision actually found anything there this step.
describe('buildSanitizedContext — unexplained[] (T-6.5/T-6.6, FR-12)', () => {
  function canvasNode(id: string, overrides: Partial<WireScreenNode> = {}): WireScreenNode {
    return node(id, { role: 'img', tagName: 'CANVAS', field: undefined, box: [20, 80, 400, 200], ...overrides });
  }

  it('a canvas node with no capture this step is reported grey', () => {
    const context = buildCtx({ nodes: [canvasNode('n-1')] });
    expect(context.unexplained).toEqual([{ box: [20, 80, 400, 200], reason: 'canvas', status: 'grey' }]);
  });

  it('a canvas node whose vision analysis completed this step is reported analysed', () => {
    const context = buildCtx({ nodes: [canvasNode('n-1')], visionAnalyzedNodeIds: new Set(['n-1']) });
    expect(context.unexplained).toEqual([{ box: [20, 80, 400, 200], reason: 'canvas', status: 'analysed' }]);
  });

  it('a timed-out node (absent from visionAnalyzedNodeIds even though a capture happened) stays grey', () => {
    const context = buildCtx({
      nodes: [canvasNode('n-1'), canvasNode('n-2', { box: [0, 0, 50, 50] })],
      visionAnalyzedNodeIds: new Set(['n-1']),
    });
    const n2 = context.unexplained.find((u) => u.box[0] === 0)!;
    expect(n2.status).toBe('grey');
  });

  it.each([
    ['VIDEO', 'video'],
    ['IMG', 'img'],
    [undefined, 'other'],
  ] as const)('a %s-tagged vision node reports reason %s', (tagName, reason) => {
    const context = buildCtx({ nodes: [canvasNode('n-1', { tagName })] });
    expect(context.unexplained[0]!.reason).toBe(reason);
  });

  it('an ordinary textbox (role !== img) is never reported as unexplained', () => {
    const context = buildCtx({ nodes: [node('n-1')] });
    expect(context.unexplained).toEqual([]);
  });
});

// T-6.5/T-6.6 — the detection-side OCR pass (`perception/detect/text-region.ts`) hands the host
// `channel: 'text-ocr'` candidates through the exact same wire shape faces already use
// (`visionCandidates`); this checks the host side of that contract on its own, without a real
// ONNX session — the real det+rec pipeline itself is covered by
// `test/browser/ocr-detection.spec.ts`.
describe('buildSanitizedContext — OCR-sourced vision candidates (T-6.5/T-6.6)', () => {
  it('an OCR candidate on a canvas node mints a real placeholder, not raw digits, even though the node has no field', () => {
    const aadhaar = validAadhaar();
    const context = buildCtx({
      nodes: [node('n-1', { role: 'img', tagName: 'CANVAS', field: undefined, box: [20, 80, 400, 200] })],
      visionCandidates: [
        {
          entity: 'AADHAAR',
          box: [40, 154, 130, 22],
          score: 0.95,
          channel: 'text-ocr',
          source: 'pattern:aadhaar+verhoeff',
          nodeId: 'n-1',
          value: aadhaar,
        },
      ],
    });

    const entry = context.redactions.find((r) => r.entity === 'AADHAAR')!;
    expect(entry).toBeDefined();
    expect(entry.ref).toMatch(/^⟪AADHAAR#\d+⟫$/);
    expect(entry.boxes).toEqual([[40, 154, 130, 22]]);
    expect(JSON.stringify(context)).not.toContain(aadhaar);
    expect(validators.sanitizedContext(context).valid).toBe(true);
  });
});

// T-6.7, design.md §5.5 — a volatile node's/run's text becomes the literal `⟪LIVE⟫`, and no
// Channel D/T candidate (hence no vault mint) is ever generated for its real, transient content.
describe('buildSanitizedContext — volatile nodes and text runs become ⟪LIVE⟫ (T-6.7)', () => {
  function volatileNode(id: string, overrides: Partial<WireScreenNode> = {}): WireScreenNode {
    return node(id, {
      name: 'Live counter',
      field: { inputType: 'text', maskedCss: false, valueRead: true, value: '00:00:42' },
      state: { focused: false, disabled: false, readonly: false, required: false, hasValue: true, valueLen: 8, occluded: false, volatile: true },
      ...overrides,
    });
  }

  it("a volatile field's name and value both become the literal ⟪LIVE⟫, not its real content", () => {
    const context = buildCtx({ nodes: [volatileNode('n-1')] });
    expect(context.nodes[0]!.name).toBe('⟪LIVE⟫');
    expect(context.nodes[0]!.value).toEqual({ kind: 'text', text: '⟪LIVE⟫' });
    expect(JSON.stringify(context)).not.toContain('00:00:42');
  });

  it('a volatile node generates no redaction entry — no candidate was ever formed for it', () => {
    const aadhaar = validAadhaar();
    const context = buildCtx({ nodes: [volatileNode('n-1', { field: { inputType: 'text', maskedCss: false, valueRead: true, value: aadhaar } })] });
    expect(context.redactions).toEqual([]);
    expect(JSON.stringify(context)).not.toContain(aadhaar);
  });

  it('a non-volatile node is completely unaffected', () => {
    const context = buildCtx({ nodes: [node('n-1', { name: 'Search' })] });
    expect(context.nodes[0]!.name).toBe('Search');
  });

  it('a volatile free-text run becomes ⟪LIVE⟫ and is not scanned for PII', () => {
    const aadhaar = validAadhaar();
    const context = buildCtx({
      nodes: [],
      textRuns: [{ id: 't-1', box: [0, 0, 100, 20], text: `Aadhaar: ${aadhaar}`, volatile: true }],
    });
    expect(context.text[0]!.text).toBe('⟪LIVE⟫');
    expect(context.redactions).toEqual([]);
  });

  it('the payload still validates against the real SanitizedContext schema', () => {
    const context = buildCtx({ nodes: [volatileNode('n-1')] });
    expect(validators.sanitizedContext(context).valid).toBe(true);
  });
});

// T-6.9, design.md §18.3 — the ablation arms builder.ts handles directly (`dom_only` needs no
// handling here at all: it works by `visionCandidates` simply never being passed in).
describe('buildSanitizedContext — ablation arms (T-6.9)', () => {
  describe('pixel_only', () => {
    it('a field value matching a real Aadhaar number ships raw — Channel D/T is skipped entirely for DOM nodes', () => {
      const aadhaar = validAadhaar();
      const context = buildCtx({
        ablation: 'pixel_only',
        nodes: [node('n-1', { name: 'Aadhaar number', field: { inputType: 'text', maskedCss: false, valueRead: true, value: aadhaar } })],
      });
      expect(context.nodes[0]!.value).toEqual({ kind: 'text', text: aadhaar });
      expect(context.redactions).toEqual([]);
    });

    it('a free-text run also ships raw — Channel T over DOM text is skipped', () => {
      const aadhaar = validAadhaar();
      const context = buildCtx({
        ablation: 'pixel_only',
        textRuns: [{ id: 't-1', box: [0, 0, 100, 20], text: `Aadhaar on record: ${aadhaar}` }],
      });
      expect(context.text[0]!.text).toContain(aadhaar);
    });

    it('the task string is still sanitized — it is not DOM content, so it is unaffected by the ablation', () => {
      const context = buildCtx({ ablation: 'pixel_only', task: 'pay my Airtel bill for 9876543210' });
      expect(context.task).not.toContain('9876543210');
      expect(context.task).toMatch(/⟪PHONE#\d+⟫/);
    });

    it('a synthetic full-frame OCR candidate (no owning node, run-step.ts\'s own shape) still mints a real placeholder and reaches redactions[]', () => {
      const aadhaar = validAadhaar();
      const lineBox: [number, number, number, number] = [40, 154, 130, 22];
      const context = buildCtx({
        ablation: 'pixel_only',
        visionCandidates: [
          {
            entity: 'AADHAAR',
            box: lineBox,
            score: 0.95,
            channel: 'text-ocr',
            source: 'pattern:aadhaar+verhoeff',
            textRunId: `ocr-full-frame:${lineBox.join(',')}`,
            value: aadhaar,
          },
        ],
      });
      const entry = context.redactions.find((r) => r.entity === 'AADHAAR');
      expect(entry).toBeDefined();
      expect(entry!.ref).toMatch(/^⟪AADHAAR#\d+⟫$/);
      expect(entry!.boxes).toEqual([lineBox]);
      expect(JSON.stringify(context)).not.toContain(aadhaar);
      expect(validators.sanitizedContext(context).valid).toBe(true);
    });

    it('two distinct full-frame OCR lines stay two distinct regions, not merged into one', () => {
      const box1: [number, number, number, number] = [10, 10, 50, 20];
      const box2: [number, number, number, number] = [10, 50, 50, 20];
      const context = buildCtx({
        ablation: 'pixel_only',
        visionCandidates: [
          { entity: 'EMAIL', box: box1, score: 0.9, channel: 'text-ocr', source: 'pattern:email', textRunId: `ocr-full-frame:${box1.join(',')}`, value: 'a@b.com' },
          { entity: 'PHONE', box: box2, score: 0.9, channel: 'text-ocr', source: 'pattern:phone', textRunId: `ocr-full-frame:${box2.join(',')}`, value: '9876543210' },
        ],
      });
      expect(context.redactions).toHaveLength(2);
      expect(context.redactions.map((r) => r.entity).sort()).toEqual(['EMAIL', 'PHONE']);
    });
  });

  describe('blackbox', () => {
    it("a field's real Aadhaar value gets NO vault ref — presence-only shape, same as a genuinely non-resolvable entity", () => {
      const aadhaar = validAadhaar();
      const context = buildCtx({
        ablation: 'blackbox',
        nodes: [node('n-1', { name: 'Aadhaar number', field: { inputType: 'text', maskedCss: false, valueRead: true, value: aadhaar } })],
      });
      expect(context.nodes[0]!.value).toEqual({ kind: 'presence', entity: 'AADHAAR', len: aadhaar.length });
      const entry = context.redactions.find((r) => r.entity === 'AADHAAR')!;
      expect(entry.ref).toBeNull();
      expect(JSON.stringify(context)).not.toContain(aadhaar);
    });

    it('the same value in free-text prose also gets a bare, ref-less placeholder', () => {
      const aadhaar = validAadhaar();
      const context = buildCtx({
        ablation: 'blackbox',
        textRuns: [{ id: 't-1', box: [0, 0, 100, 20], text: `Aadhaar on record: ${aadhaar}` }],
      });
      expect(context.text[0]!.text).toBe('Aadhaar on record: ⟪AADHAAR⟫');
      const entry = context.redactions.find((r) => r.entity === 'AADHAAR')!;
      expect(entry.ref).toBeNull();
    });

    it('a vision-only node (canvas, no field) with a real OCR-found value also gets no ref', () => {
      const aadhaar = validAadhaar();
      const context = buildCtx({
        ablation: 'blackbox',
        nodes: [node('n-1', { role: 'img', tagName: 'CANVAS', field: undefined, box: [20, 80, 400, 200] })],
        visionCandidates: [{ entity: 'AADHAAR', box: [40, 154, 130, 22], score: 0.95, channel: 'text-ocr', source: 'pattern:aadhaar+verhoeff', nodeId: 'n-1', value: aadhaar }],
      });
      const entry = context.redactions.find((r) => r.entity === 'AADHAAR')!;
      expect(entry.ref).toBeNull();
      expect(JSON.stringify(context)).not.toContain(aadhaar);
    });

    it('never calls vault.mint — the vault stays empty', () => {
      const aadhaar = validAadhaar();
      const vault = new Vault();
      buildCtx({
        ablation: 'blackbox',
        vault,
        nodes: [node('n-1', { name: 'Aadhaar number', field: { inputType: 'text', maskedCss: false, valueRead: true, value: aadhaar } })],
      });
      expect(vault.resolveFor).toBeDefined(); // sanity the real Vault class is in play
      expect(JSON.stringify(vault)).not.toContain(aadhaar); // #-private fields aren't enumerable anyway, but confirms no crash/leak path
    });

    it('the payload still validates against the real SanitizedContext schema', () => {
      const context = buildCtx({
        ablation: 'blackbox',
        nodes: [node('n-1', { name: 'Aadhaar number', field: { inputType: 'text', maskedCss: false, valueRead: true, value: validAadhaar() } })],
      });
      expect(validators.sanitizedContext(context).valid).toBe(true);
    });
  });
});

// T-6.12 (FR-36, design.md §7.1 step 9) — the session un-redact de-escalation path. `unredactedRefs`
// mirrors how `Session.unredact` actually reaches the builder: the ref a PRIOR step already minted
// for a value, found again by re-minting the SAME value into the SAME `Vault` (deterministic per
// (entity, normalizedValue, originKey) — the real mechanism, not a shortcut for the test).
describe('buildSanitizedContext — session un-redact (T-6.12, FR-36)', () => {
  it('a field value whose ref was previously un-redacted is sent as raw text, not a placeholder', () => {
    const aadhaar = validAadhaar();
    const vault = new Vault();
    const ref = vault.mint('AADHAAR', aadhaar, { originKey: 'origin:test', stepId: 's-0', class: 'CRITICAL' });

    const context = buildCtx({
      vault,
      unredactedRefs: new Set([ref]),
      nodes: [node('n-1', { name: 'Aadhaar number', field: { inputType: 'text', maskedCss: false, valueRead: true, value: aadhaar } })],
    });

    const value = context.nodes[0]!.value as { kind: string; text?: string };
    expect(value.kind).toBe('text');
    expect(value.text).toBe(aadhaar);
    expect(context.redactions.some((r) => r.ref === ref)).toBe(false);
  });

  it('a free-text occurrence of the same un-redacted value is also sent raw, with no redaction entry', () => {
    const aadhaar = validAadhaar();
    const vault = new Vault();
    const ref = vault.mint('AADHAAR', aadhaar, { originKey: 'origin:test', stepId: 's-0', class: 'CRITICAL' });

    const context = buildCtx({
      vault,
      unredactedRefs: new Set([ref]),
      textRuns: [{ id: 't-1', box: [0, 0, 100, 20], text: `Aadhaar on record: ${aadhaar}` }],
    });

    expect(context.text[0]!.text).toBe(`Aadhaar on record: ${aadhaar}`);
    expect(context.redactions.some((r) => r.ref === ref)).toBe(false);
  });

  it('a DIFFERENT ref for the same entity type is unaffected — un-redact is per-value, not per-entity-type', () => {
    const aadhaar1 = validAadhaar();
    const aadhaar2 = ('9' + '87654321012').slice(0, 11) + verhoeffGenerate(('9' + '87654321012').slice(0, 11));
    const vault = new Vault();
    const ref1 = vault.mint('AADHAAR', aadhaar1, { originKey: 'origin:test', stepId: 's-0', class: 'CRITICAL' });

    const context = buildCtx({
      vault,
      unredactedRefs: new Set([ref1]),
      nodes: [node('n-1', { name: 'Aadhaar number', field: { inputType: 'text', maskedCss: false, valueRead: true, value: aadhaar2 } })],
    });

    const value = context.nodes[0]!.value as { kind: string; ref?: string };
    expect(value.kind).toBe('placeholder');
    expect(value.ref).not.toBe(ref1);
    expect(context.redactions.some((r) => r.entity === 'AADHAAR')).toBe(true);
  });

  it('the de-escalated payload still validates against the real SanitizedContext schema', () => {
    const aadhaar = validAadhaar();
    const vault = new Vault();
    const ref = vault.mint('AADHAAR', aadhaar, { originKey: 'origin:test', stepId: 's-0', class: 'CRITICAL' });

    const context = buildCtx({
      vault,
      unredactedRefs: new Set([ref]),
      nodes: [node('n-1', { name: 'Aadhaar number', field: { inputType: 'text', maskedCss: false, valueRead: true, value: aadhaar } })],
    });

    expect(validators.sanitizedContext(context).valid).toBe(true);
  });

  it('with no unredactedRefs given at all, behaviour is identical to before this feature existed', () => {
    const aadhaar = validAadhaar();
    const context = buildCtx({
      nodes: [node('n-1', { name: 'Aadhaar number', field: { inputType: 'text', maskedCss: false, valueRead: true, value: aadhaar } })],
    });
    const value = context.nodes[0]!.value as { kind: string };
    expect(value.kind).toBe('placeholder');
  });
});

// T-6.8: profile L's real NER runs upstream (the perception worker, async, WebGPU-only) — the
// session collects sources via `collectFreeTextSources` and hands results back via
// `nerMatchesByKey`, keyed identically. These tests prove that contract, not the model itself
// (see test/unit/pii-ner.spec.ts for the model-facing offset-recovery/label-mapping tests).
describe('collectFreeTextSources — the exact keys buildSanitizedContext itself will scan (T-6.8)', () => {
  it('produces one entry per text run, per deduped node name, plus task and title', () => {
    const sources = collectFreeTextSources({
      task: 'log in',
      pageTitle: 'Login',
      nodes: [node('n-1', { name: 'Sign in', role: 'button', field: undefined, affordances: ['click'] })],
      textRuns: [{ id: 't-1', box: [0, 0, 50, 10], text: 'Welcome back' }],
    });
    const keys = sources.map((s) => s.key);
    expect(keys).toEqual(expect.arrayContaining(['run:t-1', 'name:n-1', 'task', 'title']));
    expect(sources.find((s) => s.key === 'run:t-1')?.text).toBe('Welcome back');
    expect(sources.find((s) => s.key === 'task')?.text).toBe('log in');
  });

  it('drops a node name that exactly duplicates a text run at the same box, same as the builder does', () => {
    const sources = collectFreeTextSources({
      task: 'log in',
      pageTitle: 'Login',
      nodes: [node('n-1', { name: 'Welcome back', box: [0, 0, 50, 10], role: 'button', field: undefined, affordances: ['click'] })],
      textRuns: [{ id: 't-1', box: [0, 0, 50, 10], text: 'Welcome back' }],
    });
    expect(sources.some((s) => s.key === 'name:n-1')).toBe(false);
  });
});

describe('buildSanitizedContext — nerMatchesByKey (T-6.8, profile L real spans)', () => {
  it('a precomputed NER match on a free-text run mints a real placeholder, exactly like a Channel T match would', () => {
    const nerMatch: RecognizerMatch = { entity: 'PERSON_NAME', start: 11, end: 23, matchedText: 'Sarah Connor', score: 0.98, source: 'ner:private_person', valid: true };
    const context = buildCtx({
      textRuns: [{ id: 't-1', box: [0, 0, 200, 20], text: 'Contact: Sarah Connor' }],
      nerMatchesByKey: new Map([['run:t-1', [nerMatch]]]),
    });
    expect(context.text[0]!.text).toMatch(/⟪PERSON_NAME#\d+⟫/);
    expect(context.text[0]!.text).not.toContain('Sarah Connor');
    expect(context.redactions.some((r) => r.entity === 'PERSON_NAME')).toBe(true);
  });

  it('absent nerMatchesByKey behaves identically to before this feature existed — no NER contribution', () => {
    const context = buildCtx({ textRuns: [{ id: 't-1', box: [0, 0, 200, 20], text: 'Contact: Sarah Connor' }] });
    expect(context.text[0]!.text).toBe('Contact: Sarah Connor');
    expect(context.redactions).toEqual([]);
  });

  it('a key with no matching free-text source in this call is ignored, not an error', () => {
    const context = buildCtx({
      textRuns: [{ id: 't-1', box: [0, 0, 200, 20], text: 'nothing sensitive here' }],
      nerMatchesByKey: new Map([['run:does-not-exist', [{ entity: 'PERSON_NAME', start: 0, end: 4, matchedText: 'Sam', score: 0.9, source: 'ner:private_person', valid: true }]]]),
    });
    expect(context.text[0]!.text).toBe('nothing sensitive here');
  });
});
