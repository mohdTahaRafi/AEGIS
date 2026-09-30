import { describe, expect, it } from 'vitest';
import { IMAGE_BUDGET_TOKENS, TokenBucket, estimateTokens } from '../../src/host/agent/budget';

const headers = (limit: number, remaining: number) => new Headers({ 'x-ratelimit-limit-tokens': String(limit), 'x-ratelimit-remaining-tokens': String(remaining) });

describe('estimateTokens', () => {
  it('adds the screenshot and the reserved completion to the text estimate', () => {
    const text = 'x'.repeat(2300);
    expect(estimateTokens([{ content: text }], 900, 0)).toBe(1000 + 900);
    expect(estimateTokens([{ content: [{ type: 'text', text }, { type: 'image_url' }] }], 900, IMAGE_BUDGET_TOKENS)).toBe(1000 + IMAGE_BUDGET_TOKENS + 900);
  });
});

describe('TokenBucket', () => {
  it('does not wait before the API has said what the limit is', () => {
    expect(new TokenBucket().waitFor(5000, 0)).toBe(0);
  });

  it('waits for the per-minute budget to refill at limit/60 per second', () => {
    const bucket = new TokenBucket();
    bucket.update(headers(8000, 8000), 0);
    bucket.spend(6000, 0);
    // 2000 left, need 5000: 3000 tokens short at 8000/60 tokens/s.
    expect(bucket.waitFor(5000, 0)).toBeCloseTo(22.5, 1);
    expect(bucket.waitFor(5000, 22.5)).toBeCloseTo(0, 1);
  });

  it('gives back the part of max_tokens the answer did not use', () => {
    const bucket = new TokenBucket();
    bucket.update(headers(8000, 8000), 0);
    bucket.spend(6000, 0);
    bucket.refund(4000);
    expect(bucket.waitFor(5000, 0)).toBe(0);
  });

  it('trusts a 429\'s Retry-After exactly', () => {
    const bucket = new TokenBucket();
    bucket.block(5, 100);
    expect(bucket.waitFor(10, 100)).toBe(5);
    expect(bucket.waitFor(10, 103)).toBe(2);
  });

  it('leaves a request larger than the whole budget to the API (a 413)', () => {
    const bucket = new TokenBucket();
    bucket.update(headers(7000, 7000), 0);
    expect(bucket.waitFor(9000, 0)).toBe(0);
  });

  it('ignores unreadable rate-limit headers', () => {
    const bucket = new TokenBucket();
    bucket.update(new Headers({ 'x-ratelimit-limit-tokens': 'lots' }), 0);
    expect(bucket.waitFor(1e9, 0)).toBe(0);
  });
});
