// phase_4_vision.md §6.2 / T-4.12 — a difference hash for the crop cache: "a page with the same
// logo in 8 places runs the encoder once." dHash is a standard, cheap perceptual hash (9×8
// greyscale downsample, compare adjacent pixels) — robust to the minor resampling differences a
// second extraction of the "same" logo picks up, unlike a byte-exact hash of the crop.

/** 64-bit dHash, returned as a hex string so it is a plain, cacheable `Map` key. */
export function dHash(source: OffscreenCanvas | ImageBitmap): string {
  const w = 9;
  const h = 8;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
  ctx.drawImage(source, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  const grey = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    grey[i] = 0.299 * data[i * 4]! + 0.587 * data[i * 4 + 1]! + 0.114 * data[i * 4 + 2]!;
  }

  let bits = 0n;
  let bitIndex = 0n;
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w - 1; col++) {
      const left = grey[row * w + col]!;
      const right = grey[row * w + col + 1]!;
      if (left > right) bits |= 1n << bitIndex;
      bitIndex += 1n;
    }
  }
  return bits.toString(16).padStart(16, '0');
}

/** Hamming distance between two dHash hex strings — 0 means identical downsampled appearance. */
export function hammingDistance(a: string, b: string): number {
  const x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  let v = x;
  while (v > 0n) {
    count += Number(v & 1n);
    v >>= 1n;
  }
  return count;
}

/** LRU cache keyed by dHash within a Hamming-distance tolerance — T-4.12's "8 places, once." */
export class DHashCache<T> {
  private readonly entries: { hash: string; value: T }[] = [];

  constructor(private readonly capacity: number, private readonly tolerance = 2) {}

  get(hash: string): T | undefined {
    const idx = this.entries.findIndex((e) => hammingDistance(e.hash, hash) <= this.tolerance);
    if (idx === -1) return undefined;
    const [hit] = this.entries.splice(idx, 1);
    this.entries.push(hit!);
    return hit!.value;
  }

  set(hash: string, value: T): void {
    if (this.entries.length >= this.capacity) this.entries.shift();
    this.entries.push({ hash, value });
  }

  clear(): void {
    this.entries.length = 0;
  }

  get size(): number {
    return this.entries.length;
  }
}
