import { describe, expect, it } from 'vitest';
import { buildCtcVocabulary, ctcGreedyDecode } from '../../src/perception/models/ocr-rec';

describe('buildCtcVocabulary — the real PaddleOCR CTC vocabulary shape (T-6.3)', () => {
  it('places blank at index 0 and a trailing space after the dict characters', () => {
    const vocab = buildCtcVocabulary(['A', 'B', 'C']);
    expect(vocab).toEqual(['', 'A', 'B', 'C', ' ']);
  });

  it('matches the real bundled English model dimension: 1 + 436 + 1 = 438', () => {
    const dict = Array.from({ length: 436 }, (_, i) => String(i));
    expect(buildCtcVocabulary(dict)).toHaveLength(438);
  });
});

describe('ctcGreedyDecode — pure CTC arithmetic, transcribed from PaddleOCR CTCLabelDecode (T-6.3)', () => {
  const vocab = buildCtcVocabulary(['A', 'B', 'C']); // ['', 'A', 'B', 'C', ' '], vocabSize=5

  function oneHotTimestep(index: number, vocabSize: number): number[] {
    const row = new Array(vocabSize).fill(0.01);
    row[index] = 0.9;
    return row;
  }

  it('collapses consecutive duplicate indices into one character', () => {
    // A, A, B, B, B, C -> "ABC"
    const seq = [1, 1, 2, 2, 2, 3];
    const logits = new Float32Array(seq.flatMap((i) => oneHotTimestep(i, 5)));
    const result = ctcGreedyDecode(logits, seq.length, 5, vocab);
    expect(result.text).toBe('ABC');
  });

  it('drops blank timesteps but does NOT merge across a blank (blank resets duplicate tracking)', () => {
    // A, blank, A -> "AA" (the blank separates two real A's, both kept)
    const seq = [1, 0, 1];
    const logits = new Float32Array(seq.flatMap((i) => oneHotTimestep(i, 5)));
    const result = ctcGreedyDecode(logits, seq.length, 5, vocab);
    expect(result.text).toBe('AA');
  });

  it('decodes the trailing space character correctly', () => {
    const seq = [1, 4, 2]; // A, space, B
    const logits = new Float32Array(seq.flatMap((i) => oneHotTimestep(i, 5)));
    const result = ctcGreedyDecode(logits, seq.length, 5, vocab);
    expect(result.text).toBe('A B');
  });

  it('throws if the vocabulary size does not match the model output width — a dict/model mismatch must fail loudly, not silently decode garbage', () => {
    const logits = new Float32Array(3 * 6);
    expect(() => ctcGreedyDecode(logits, 3, 6, vocab)).toThrow(/does not match/);
  });

  it('returns empty text and zero confidence for an all-blank sequence', () => {
    const seq = [0, 0, 0];
    const logits = new Float32Array(seq.flatMap((i) => oneHotTimestep(i, 5)));
    const result = ctcGreedyDecode(logits, seq.length, 5, vocab);
    expect(result.text).toBe('');
    expect(result.confidence).toBe(0);
  });
});
