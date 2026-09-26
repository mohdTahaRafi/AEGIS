import { describe, expect, it } from 'vitest';
import { chunkForNer, classifyProfileL, classifyProfileS, PROFILE_L_LABEL_MAP, type TokenClassificationPipeline } from '../../src/perception/models/pii-ner';

function fakePipeline(groups: { entity_group: string; score: number; word: string }[]): TokenClassificationPipeline {
  return async () => groups;
}

describe('classifyProfileS — no real model, disclosed', () => {
  it('always returns no findings', async () => {
    expect(await classifyProfileS('My name is Sarah Connor')).toEqual([]);
  });
});

describe('classifyProfileL — real transformers.js output shape, T-6.8', () => {
  it('maps a mapped label and recovers the exact character span from the grouped word', async () => {
    const text = 'Hi, my name is Sarah Connor and I live in Berlin.';
    const pipeline = fakePipeline([{ entity_group: 'private_person', score: 0.999, word: ' Sarah Connor' }]);
    const matches = await classifyProfileL(pipeline, text);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ entity: 'PERSON_NAME', score: 0.999, source: 'ner:private_person', valid: true });
    expect(text.slice(matches[0]!.start, matches[0]!.end)).toBe('Sarah Connor');
    expect(matches[0]!.matchedText).toBe('Sarah Connor');
  });

  it('drops a label with no honest entity mapping (private_url) rather than inventing one', async () => {
    const text = 'See https://example.com/profile for details.';
    const pipeline = fakePipeline([{ entity_group: 'private_url', score: 0.99, word: ' https://example.com/profile' }]);
    expect(await classifyProfileL(pipeline, text)).toEqual([]);
  });

  it('drops a span whose decoded word cannot be located in the text at all, rather than guessing a range', async () => {
    const text = 'plain text with nothing sensitive';
    const pipeline = fakePipeline([{ entity_group: 'private_person', score: 0.9, word: ' Nonexistent Name' }]);
    expect(await classifyProfileL(pipeline, text)).toEqual([]);
  });

  it('advances its search cursor so two occurrences of the same name resolve to their own position, in order', async () => {
    const text = 'Sam called Sam back about the account.';
    const pipeline = fakePipeline([
      { entity_group: 'private_person', score: 0.9, word: 'Sam' },
      { entity_group: 'private_person', score: 0.9, word: 'Sam' },
    ]);
    const matches = await classifyProfileL(pipeline, text);
    expect(matches).toHaveLength(2);
    expect(matches[0]!.start).toBe(0);
    expect(matches[1]!.start).toBe(text.indexOf('Sam', 3));
    expect(matches[1]!.start).toBeGreaterThan(matches[0]!.start);
  });

  it('covers every id2label tag the real openai/privacy-filter config publishes except the deliberately-dropped private_url', () => {
    const realModelTags = ['account_number', 'private_address', 'private_date', 'private_email', 'private_person', 'private_phone', 'private_url', 'secret'];
    for (const tag of realModelTags) {
      if (tag === 'private_url') {
        expect(PROFILE_L_LABEL_MAP[tag]).toBeUndefined();
      } else {
        expect(PROFILE_L_LABEL_MAP[tag]).toBeDefined();
      }
    }
  });
});

describe('chunkForNer — design.md §6.3 call shape (kept for spec fidelity, unused by classifyProfileL)', () => {
  it('returns the whole text as one chunk under the token limit', () => {
    expect(chunkForNer('a b c')).toEqual(['a b c']);
  });

  it('splits with overlap once over the token limit', () => {
    const text = Array.from({ length: 300 }, (_, i) => `w${i}`).join(' ');
    const chunks = chunkForNer(text, 256, 32);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.split(' ')).toHaveLength(256);
  });
});
