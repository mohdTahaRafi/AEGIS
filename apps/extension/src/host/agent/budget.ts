// The model API's per-minute token budget, tracked here so a step waits for it instead of being
// sent into a 429. The free tier allows ~8K tokens a minute per model, and one screenshot step costs
// most of that, so the wait is routine there (a paid plan's larger limit, read from the response
// headers, makes it vanish).

/** What one screenshot costs against the per-minute budget. Measured on Groq for qwen/qwen3.8-27b
 * (2026-09-30): 1,807 prompt tokens billed for every size from 512 to 1236 px wide, and the same
 * 1,807 deducted a second time just after the response. A request is admitted only when all of it
 * fits. */
export const IMAGE_BUDGET_TOKENS = 3600;

// Measured on the same model: system prompt plus page text came to 2.36 characters per token (the
// element list is dense: ids, boxes, numbers); a little under that, so the estimate errs towards
// waiting.
const CHARS_PER_TOKEN = 2.3;

export function estimateTokens(messages: readonly { content: string | readonly { type: string; text?: string }[] }[], maxTokens: number, imageTokens: number): number {
  let chars = 0;
  let hasImage = false;
  for (const message of messages) {
    const parts = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    for (const part of parts) {
      if (part.type === 'text' && typeof part.text === 'string') chars += part.text.length;
      else if (part.type === 'image_url') hasImage = true;
    }
  }
  // The API admits a request only if the whole max_tokens fits (measured: it is deducted up front,
  // the unused part refunded after), so that is what a request needs, not what it will use.
  return Math.floor(chars / CHARS_PER_TOKEN) + (hasImage ? imageTokens : 0) + maxTokens;
}

/** A per-model tokens-per-minute budget, refilled linearly (limit/60 per second).
 *
 * Two views, the lower wins: the `x-ratelimit-*` headers of the last response, and this client's
 * own record of what it sent in the last minute (each request's estimated cost, refilling from
 * when it was sent). Groq charges part of a screenshot only after answering, so right after a
 * step its header still shows budget that is already gone; the own record does not lag. */
export class TokenBucket {
  private limit: number | null = null;
  private remaining: number | null = null;
  private observedAt = 0;
  private blockedUntil = 0;
  private sent: { at: number; tokens: number }[] = [];

  private ownAvailable(now: number): number | null {
    if (!this.limit) return null;
    const rate = this.limit / 60;
    this.sent = this.sent.filter((e) => now - e.at < 60);
    const outstanding = this.sent.reduce((sum, e) => sum + Math.max(0, e.tokens - rate * (now - e.at)), 0);
    return this.limit - outstanding;
  }

  private available(now: number): number | null {
    const own = this.ownAvailable(now);
    if (own === null || this.remaining === null || this.limit === null) return own;
    const header = Math.min(this.limit, this.remaining + (this.limit / 60) * (now - this.observedAt));
    return Math.min(header, own);
  }

  spend(tokens: number, now: number): void {
    this.sent.push({ at: now, tokens });
  }

  /** The API gives back the unused part of max_tokens after answering; so does the record (from the
   * latest request, which is the one just answered). */
  refund(tokens: number): void {
    const last = this.sent[this.sent.length - 1];
    if (last && tokens > 0) last.tokens = Math.max(0, last.tokens - tokens);
  }

  update(headers: { get(name: string): string | null }, now: number): void {
    const rawLimit = headers.get('x-ratelimit-limit-tokens');
    const rawRemaining = headers.get('x-ratelimit-remaining-tokens');
    if (rawLimit === null || rawRemaining === null) return;
    const limit = Number(rawLimit);
    const remaining = Number(rawRemaining);
    if (!Number.isFinite(limit) || !Number.isFinite(remaining)) return;
    this.limit = limit;
    this.remaining = remaining;
    this.observedAt = now;
  }

  /** A 429: the API says when to come back. Its Retry-After is trusted as given; the budget estimate
   * is left alone (zeroing it turned a 5 s Retry-After into a 50 s wait). */
  block(seconds: number, now: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, now + seconds);
  }

  /** Seconds to wait before a request costing `tokens` would be admitted. */
  waitFor(tokens: number, now: number): number {
    const wait = Math.max(0, this.blockedUntil - now);
    const available = this.available(now);
    if (available === null || !this.limit || this.limit <= 0) return wait;
    const need = Math.min(tokens, this.limit); // larger than the whole budget: the API decides (413)
    return Math.max(wait, (need - available) / (this.limit / 60));
  }
}
