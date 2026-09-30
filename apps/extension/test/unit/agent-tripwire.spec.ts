import { verhoeffGenerate } from '@aegis/recognizers';
import { describe, expect, it } from 'vitest';
import { findUnsanitized } from '../../src/host/agent/tripwire';
import { fakeNode, fakeStep } from './agent-fixtures';

const aadhaar = (() => {
  const body = '23456789012';
  return body + verhoeffGenerate(body);
})();

describe('findUnsanitized (last check before anything is sent)', () => {
  it('finds a checksum-valid Aadhaar, an email, a phone, a PAN and a card number in page text', () => {
    const step = fakeStep({
      nodes: [fakeNode('n-1', { name: `ID ${aadhaar}` })],
      text: [
        { id: 't1', box: [0, 0, 1, 1], text: 'write to asha.rao@example.in' },
        { id: 't2', box: [0, 0, 1, 1], text: 'call 98765 43210' },
        { id: 't3', box: [0, 0, 1, 1], text: 'PAN ABCPE1234F' },
        { id: 't4', box: [0, 0, 1, 1], text: 'card 4111 1111 1111 1111' },
      ],
    });
    expect(findUnsanitized(step)).toEqual(['AADHAAR', 'CARD_NUMBER', 'EMAIL', 'PAN', 'PHONE']);
  });

  it('is quiet about placeholders, ordinary numbers and the image bytes', () => {
    const step = fakeStep({
      task: 'enter ⟪AADHAAR#1⟫ and order 123456789012 items',
      nodes: [fakeNode('n-1', { name: 'Total 1,234.50' })],
      text: [{ id: 't1', box: [0, 0, 1, 1], text: 'Ref ⟪EMAIL#2⟫ 20260930' }],
    });
    expect(findUnsanitized(step)).toEqual([]);
  });

  it('reports entity names, never the matched text', () => {
    expect(JSON.stringify(findUnsanitized(fakeStep({ task: `id ${aadhaar}` })))).not.toContain(aadhaar);
  });
});
