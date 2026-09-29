// The panel lists every field the local classifier protected by its LABEL, including empty ones
// (which have nothing to redact yet, so never appear in `redactions`).

import { describe, expect, it } from 'vitest';
import { protectedFieldsOf } from '../../src/host/session';
import type { WireScreenNode } from '../../src/shared/messages';

function field(id: string, entity: string, valueRead: boolean, value?: string): WireScreenNode {
  return {
    id,
    frame: 'f-0',
    role: 'textbox',
    name: 'raw label',
    box: [0, 0, 10, 10],
    z: 0,
    state: { focused: false, disabled: false, readonly: false, required: false, hasValue: !!value, valueLen: value?.length ?? 0, occluded: false, volatile: false },
    affordances: ['type'],
    container: 'root',
    textRuns: [],
    field: { inputType: 'text', maskedCss: false, valueRead, ...(valueRead ? { value: value ?? '' } : {}) },
    domSignal: { entity: entity as never, score: 0.9, valueRead },
  } as WireScreenNode;
}

describe('protectedFieldsOf', () => {
  it('reports empty, sealed and never-read fields with their SENT names', () => {
    const page = [field('n-1', 'PERSON_NAME', true), field('n-2', 'EMAIL', true, 'not-an-email'), field('n-3', 'PASSWORD', false)];
    const sent = [
      { id: 'n-1', name: 'Full Name *', value: { kind: 'text' as const, text: '' } },
      { id: 'n-2', name: 'Email ID *', value: { kind: 'placeholder' as const, ref: '⟪EMAIL#1⟫' } },
      { id: 'n-3', name: 'Password *', value: { kind: 'presence' as const } },
    ];
    expect(protectedFieldsOf(page, sent)).toEqual([
      { entity: 'PERSON_NAME', label: 'Full Name *', sent: 'empty' },
      { entity: 'EMAIL', label: 'Email ID *', sent: 'placeholder', ref: '⟪EMAIL#1⟫' },
      { entity: 'PASSWORD', label: 'Password *', sent: 'presence' },
    ]);
  });

  it('flags a labelled field whose value went out as plain text', () => {
    const out = protectedFieldsOf([field('n-1', 'USERNAME', true, 'abc')], [{ id: 'n-1', name: 'Login ID', value: { kind: 'text', text: 'abc' } }]);
    expect(out[0]!.sent).toBe('text');
  });
});

describe('labelProtectedFieldsWithoutRedaction', () => {
  it('masks empty or unsealed label-sensitive fields, not ones already redacted, never non-sensitive ones', async () => {
    const { labelProtectedFieldsWithoutRedaction } = await import('../../src/host/session');
    const plain = { ...field('n-4', 'EMAIL', true), domSignal: undefined } as WireScreenNode;
    const page = [field('n-1', 'PERSON_NAME', true), field('n-2', 'EMAIL', true, 'x'), field('n-3', 'PASSWORD', false), plain];
    const sent = [
      { id: 'n-1', box: [0, 0, 10, 10], value: { kind: 'text' as const, text: '' } },
      { id: 'n-2', box: [0, 20, 10, 10], value: { kind: 'placeholder' as const, ref: '⟪EMAIL#1⟫' } },
      { id: 'n-3', box: [0, 40, 10, 10], value: { kind: 'presence' as const } },
      { id: 'n-4', box: [0, 60, 10, 10], value: { kind: 'text' as const, text: '' } },
    ];
    expect(labelProtectedFieldsWithoutRedaction(page, sent)).toEqual([{ entity: 'PERSON_NAME', box: [0, 0, 10, 10] }]);
  });
});
