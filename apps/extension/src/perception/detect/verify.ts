// Structural pixel checks that confirm (or veto) CLIP's zero-shot "this image is a QR code /
// barcode / signature" before anything is redacted. CLIP scores whole-image semantics; on real
// pages it put a product photo of a charger on "QR code" and a blurry banner on "ID document".
// These checks look for the structure that makes each thing what it is — a QR code's three finder
// patterns, a barcode's parallel bars, a signature's few long ink strokes on a light ground — which
// a photo or an illustration does not have. Pure functions over RGBA pixels: testable without a
// browser or a model.

export interface GrayImage {
  width: number;
  height: number;
  /** Luma 0..255, row-major. */
  data: Uint8Array;
}

const MAX_SIDE = 480;

/** Luma image, downscaled so the long side is at most `maxSide` (structure survives, cost does not). */
export function toGray(canvas: OffscreenCanvas, maxSide = MAX_SIDE): GrayImage {
  const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  const width = Math.max(1, Math.round(canvas.width * scale));
  const height = Math.max(1, Math.round(canvas.height * scale));
  let source = canvas;
  if (scale < 1) {
    source = new OffscreenCanvas(width, height);
    source.getContext('2d')!.drawImage(canvas, 0, 0, width, height);
  }
  const rgba = source.getContext('2d')!.getImageData(0, 0, width, height).data;
  return grayFromRgba(rgba, width, height);
}

export function grayFromRgba(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): GrayImage {
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.round(0.299 * rgba[i * 4]! + 0.587 * rgba[i * 4 + 1]! + 0.114 * rgba[i * 4 + 2]!);
  }
  return { width, height, data };
}

/** Otsu's split over the luma histogram, returned as the midpoint between the two classes' means
 * (so `v < threshold` is "dark" even for a pure black/white image, where the split itself is 0). */
export function otsuThreshold(img: GrayImage): number {
  const hist = new Array<number>(256).fill(0);
  for (const v of img.data) hist[v]! += 1;
  const total = img.data.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i]!;
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      threshold = (mB + mF) / 2;
    }
  }
  return threshold;
}

/** Fraction of pixels far (≥ 48 levels) from the threshold: near 1 for printed black-on-white
 * codes, low for photographs. */
function bimodality(img: GrayImage, threshold: number): number {
  let far = 0;
  for (const v of img.data) if (Math.abs(v - threshold) >= 48) far++;
  return far / img.data.length;
}

function runLengths(line: ArrayLike<number>, threshold: number): { dark: boolean; start: number; len: number }[] {
  const runs: { dark: boolean; start: number; len: number }[] = [];
  for (let i = 0; i < line.length; i++) {
    const dark = line[i]! < threshold;
    const last = runs[runs.length - 1];
    if (last && last.dark === dark) last.len += 1;
    else runs.push({ dark, start: i, len: 1 });
  }
  return runs;
}

/** dark-light-dark-light-dark in 1:1:3:1:1 — a QR finder pattern's cross-section. */
function isFinderRatio(r: readonly { len: number }[]): boolean {
  const total = r.reduce((a, x) => a + x.len, 0);
  if (total < 7) return false;
  const m = total / 7;
  const tol = m * 0.6;
  return Math.abs(r[0]!.len - m) < tol && Math.abs(r[1]!.len - m) < tol && Math.abs(r[2]!.len - 3 * m) < tol * 2.5 && Math.abs(r[3]!.len - m) < tol && Math.abs(r[4]!.len - m) < tol;
}

function column(img: GrayImage, x: number): Uint8Array {
  const out = new Uint8Array(img.height);
  for (let y = 0; y < img.height; y++) out[y] = img.data[y * img.width + x]!;
  return out;
}

/** Finder-pattern centres confirmed both horizontally and vertically, clustered. */
export function findQrFinderPatterns(img: GrayImage, threshold = otsuThreshold(img)): { x: number; y: number; size: number }[] {
  const hits: { x: number; y: number; size: number }[] = [];
  const colCache = new Map<number, ReturnType<typeof runLengths>>();
  for (let y = 0; y < img.height; y++) {
    const runs = runLengths(img.data.subarray(y * img.width, (y + 1) * img.width), threshold);
    for (let i = 0; i + 4 < runs.length; i++) {
      const window = runs.slice(i, i + 5);
      if (!window[0]!.dark || !isFinderRatio(window)) continue;
      const cx = Math.round(window[2]!.start + window[2]!.len / 2);
      const total = window.reduce((a, r) => a + r.len, 0);
      let colRuns = colCache.get(cx);
      if (!colRuns) {
        colRuns = runLengths(column(img, cx), threshold);
        colCache.set(cx, colRuns);
      }
      const k = colRuns.findIndex((r) => r.start <= y && y < r.start + r.len);
      if (k < 2 || k + 2 >= colRuns.length) continue;
      const vwin = colRuns.slice(k - 2, k + 3);
      if (!vwin[0]!.dark || !isFinderRatio(vwin)) continue;
      const vtotal = vwin.reduce((a, r) => a + r.len, 0);
      if (Math.abs(vtotal - total) > total * 0.5) continue;
      hits.push({ x: cx, y: Math.round(vwin[2]!.start + vwin[2]!.len / 2), size: total });
    }
  }
  const clusters: { x: number; y: number; size: number; n: number }[] = [];
  for (const h of hits) {
    const c = clusters.find((c) => Math.abs(c.x - h.x) < h.size && Math.abs(c.y - h.y) < h.size);
    if (c) {
      c.x = (c.x * c.n + h.x) / (c.n + 1);
      c.y = (c.y * c.n + h.y) / (c.n + 1);
      c.n += 1;
    } else clusters.push({ ...h, n: 1 });
  }
  return clusters.filter((c) => c.n >= 2).map(({ x, y, size }) => ({ x, y, size }));
}

/** Three finder patterns of similar size at the corners of a right angle. */
export function looksLikeQrCode(img: GrayImage): boolean {
  const threshold = otsuThreshold(img);
  if (bimodality(img, threshold) < 0.55) return false;
  const finders = findQrFinderPatterns(img, threshold);
  for (let a = 0; a < finders.length; a++) {
    for (let b = a + 1; b < finders.length; b++) {
      for (let c = b + 1; c < finders.length; c++) {
        const pts = [finders[a]!, finders[b]!, finders[c]!];
        const sizes = pts.map((p) => p.size);
        if (Math.max(...sizes) > Math.min(...sizes) * 1.6) continue;
        // Right angle at one of the three: the two legs roughly equal and perpendicular.
        for (let k = 0; k < 3; k++) {
          const o = pts[k]!;
          const p = pts[(k + 1) % 3]!;
          const q = pts[(k + 2) % 3]!;
          const v1 = [p.x - o.x, p.y - o.y];
          const v2 = [q.x - o.x, q.y - o.y];
          const l1 = Math.hypot(v1[0]!, v1[1]!);
          const l2 = Math.hypot(v2[0]!, v2[1]!);
          if (l1 < o.size * 1.5 || l2 < o.size * 1.5) continue;
          const cos = (v1[0]! * v2[0]! + v1[1]! * v2[1]!) / (l1 * l2);
          if (Math.abs(cos) < 0.2 && Math.max(l1, l2) < Math.min(l1, l2) * 1.3) return true;
        }
      }
    }
  }
  return false;
}

/** Many high-contrast parallel bars that repeat on rows across the image's middle band. */
export function looksLikeBarcode(img: GrayImage): boolean {
  const threshold = otsuThreshold(img);
  if (bimodality(img, threshold) < 0.55) return false;
  const check = (lines: Uint8Array[]): boolean => {
    const patterns = lines.map((l) => runLengths(l, threshold));
    if (patterns.some((p) => p.length < 24)) return false;
    // Same bars on every sampled line: binarized lines agree almost everywhere.
    const base = lines[0]!;
    for (const other of lines.slice(1)) {
      let agree = 0;
      for (let i = 0; i < base.length; i++) if (base[i]! < threshold === other[i]! < threshold) agree++;
      if (agree / base.length < 0.85) return false;
    }
    return true;
  };
  const rows = [0.35, 0.5, 0.65].map((f) => {
    const y = Math.min(img.height - 1, Math.round(img.height * f));
    return img.data.subarray(y * img.width, (y + 1) * img.width);
  });
  if (img.width >= 48 && check(rows)) return true;
  const cols = [0.35, 0.5, 0.65].map((f) => column(img, Math.min(img.width - 1, Math.round(img.width * f))));
  return img.height >= 48 && check(cols);
}

/** Dark ink strokes on a light, unsaturated ground, forming a FEW long connected strokes — printed
 * text on the same ground forms many small letter-sized components instead. */
export function looksLikeSignature(img: GrayImage): boolean {
  const sorted = Uint8Array.from(img.data).sort();
  const background = sorted[Math.floor(sorted.length * 0.6)]!;
  if (background < 170) return false;
  const inkLevel = background - 70;
  const ink = new Uint8Array(img.data.length);
  let inkCount = 0;
  for (let i = 0; i < img.data.length; i++) {
    if (img.data[i]! < inkLevel) {
      ink[i] = 1;
      inkCount++;
    }
  }
  const ratio = inkCount / img.data.length;
  if (ratio < 0.004 || ratio > 0.2) return false;
  const components = componentExtents(ink, img.width, img.height).filter((c) => c.pixels >= 4);
  if (components.length === 0 || components.length > 30) return false;
  const widest = Math.max(...components.map((c) => c.x1 - c.x0 + 1));
  return widest >= img.width * 0.25;
}

function componentExtents(mask: Uint8Array, width: number, height: number): { x0: number; x1: number; pixels: number }[] {
  const seen = new Uint8Array(mask.length);
  const out: { x0: number; x1: number; pixels: number }[] = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let x0 = start % width;
    let x1 = x0;
    let pixels = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const idx = stack.pop()!;
      pixels++;
      const x = idx % width;
      const y = (idx - x) / width;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      // 8-connected: handwriting strokes touch diagonally.
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width || (dx === 0 && dy === 0)) continue;
          const n = ny * width + nx;
          if (mask[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    out.push({ x0, x1, pixels });
  }
  return out;
}

/** Near-uniform pixels (a blank placeholder, a solid banner): nothing a model could find there. */
export function isNearUniform(img: GrayImage): boolean {
  let sum = 0;
  let sumSq = 0;
  for (const v of img.data) {
    sum += v;
    sumSq += v * v;
  }
  const n = img.data.length;
  const variance = sumSq / n - (sum / n) ** 2;
  return variance < 36;
}

// Words an identity document carries and a product photo, a banner or a portrait does not.
const ID_KEYWORDS = [
  'government of india', 'govt of india', 'aadhaar', 'aadhar', 'uidai', 'unique identification', 'income tax', 'permanent account number',
  'passport', 'republic of india', 'date of birth', 'dob', 'year of birth', 'driving licence', 'driving license', 'licence no', 'license no',
  'identity card', 'id card', 'election commission', 'voter', 'epic', 'nationality', 'place of birth', 'date of issue', 'date of expiry',
  'valid till', 'blood group', 's/o', 'd/o', 'w/o', 'father', 'gender', 'male', 'female', 'enrolment', 'vid',
];

/** Text read inside the image that says it is an identity document: a keyword, or a value only an
 * ID carries (an Aadhaar/PAN/passport number, a machine-readable zone). */
export function idDocumentTextEvidence(lines: readonly string[], idEntitiesFound: number): boolean {
  const text = lines.join(' ').toLowerCase();
  if (/<{3,}/.test(text)) return true;
  let hits = 0;
  for (const k of ID_KEYWORDS) if (new RegExp(`(^|[^a-z])${k.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}([^a-z]|$)`).test(text)) hits++;
  // An ID number alone does not make the whole picture a document (a dashboard canvas showing a
  // PAN: the number already gets its own box) — only together with the document's own wording.
  if (idEntitiesFound > 0) return hits >= 1;
  return hits >= 2 || (hits >= 1 && lines.length >= 3);
}
