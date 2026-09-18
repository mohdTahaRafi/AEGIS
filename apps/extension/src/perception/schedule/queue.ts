// phase_4_vision.md §6.2 / T-4.10 — the FIFO scheduler with priorities. "One inference at a time,
// strict FIFO with priorities: faces > ViT screening > OCR > NER." FIFO within a priority band,
// not a max-heap by arbitrary score — the ordering is a fixed, closed list (design.md §11.4), so a
// simple bucketed queue is both correct and trivially auditable.

export type JobKind = 'face' | 'vit' | 'ocr' | 'ner';

const PRIORITY_ORDER: readonly JobKind[] = ['face', 'vit', 'ocr', 'ner'];

export interface ScheduledJob<T = unknown> {
  id: string;
  kind: JobKind;
  payload: T;
}

/** A single-consumer priority queue: `dequeue()` always returns the highest-priority job among
 * those currently enqueued, FIFO among equal priority. "One inference at a time" is enforced by
 * the caller only ever having one in-flight job and not calling `dequeue` again until it resolves
 * — this class only orders, it doesn't limit concurrency itself. */
export class PriorityQueue<T = unknown> {
  private readonly buckets: Map<JobKind, ScheduledJob<T>[]> = new Map(PRIORITY_ORDER.map((k) => [k, []]));

  enqueue(job: ScheduledJob<T>): void {
    this.buckets.get(job.kind)!.push(job);
  }

  dequeue(): ScheduledJob<T> | null {
    for (const kind of PRIORITY_ORDER) {
      const bucket = this.buckets.get(kind)!;
      if (bucket.length > 0) return bucket.shift()!;
    }
    return null;
  }

  /** Drops every job of `kind` still waiting — used when the degradation ladder sheds a whole
   * capability (e.g. "skip OCR on low-priority regions"). Returns the dropped jobs so the caller
   * can report them as `timedOut`, never silently as cleared. */
  dropAll(kind: JobKind): ScheduledJob<T>[] {
    const bucket = this.buckets.get(kind)!;
    const dropped = [...bucket];
    bucket.length = 0;
    return dropped;
  }

  get size(): number {
    let total = 0;
    for (const bucket of this.buckets.values()) total += bucket.length;
    return total;
  }

  isEmpty(): boolean {
    return this.size === 0;
  }
}
