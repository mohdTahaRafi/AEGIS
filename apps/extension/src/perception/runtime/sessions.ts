// design.md §11.3 / phase_4_vision.md T-4.2, T-4.11 — the model registry. Verifies sha256 BEFORE
// creating an ONNX Runtime session (the load-side half of the supply-chain control; Phase 0 built
// the fetch-side half in `scripts/fetch-models.ts`), and tracks residency so the scheduler's
// eviction policy (T-4.11: "Face detector and ViT encoder stay resident... evict large sessions
// after idle") has something to act on.
//
// This file is the ONE named, disclosed exception in `scripts/check-no-network.ts`'s no-network
// scan (CLAUDE.md's "fetch/XHR/WebSocket exist only in src/host/egress/"): computing a runtime
// sha256 requires the actual bytes, and a same-origin `fetch` of a bundled model file is the only
// way to get them inside a Worker. See that script's comment and `docs/DECISIONS.md` for why this
// is judged not to be the class of network call the invariant guards against — it never sends
// anything, and the target is never a remote host.

import * as ort from 'onnxruntime-web';
import type { Backend, ModelInfo, ModelSpec } from '../../shared/worker-protocol';

export class ModelLoadError extends Error {
  readonly code = 'MODEL_LOAD_FAILED';
  constructor(readonly modelId: string, reason: string) {
    super(`model "${modelId}" failed to load: ${reason}`);
    this.name = 'ModelLoadError';
  }
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface LoadedSession {
  spec: ModelSpec;
  session: ort.InferenceSession;
  bytes: number;
  loadMs: number;
  lastUsedAt: number;
}

/** Lazy-loading, verify-then-create, evictable session pool. One instance per worker; the worker
 * never creates an `ort.InferenceSession` directly — always through here, so verification can
 * never be accidentally skipped by a new call site (the same "structural, not conditional" shape
 * as Phase 3's protected-value rule). */
async function fetchAndVerify(modelId: string, url: string, expectedSha256: string): Promise<ArrayBuffer> {
  let bytes: ArrayBuffer;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
    bytes = await response.arrayBuffer();
  } catch (err) {
    throw new ModelLoadError(modelId, err instanceof Error ? err.message : String(err));
  }
  const actualHash = await sha256Hex(bytes);
  if (actualHash !== expectedSha256) {
    throw new ModelLoadError(modelId, `sha256 mismatch: expected ${expectedSha256}, got ${actualHash}`);
  }
  return bytes;
}

export class ModelRegistry {
  private readonly sessions = new Map<string, LoadedSession>();
  private readonly specs = new Map<string, ModelSpec>();
  private readonly dicts = new Map<string, string[]>();

  constructor(private readonly backend: Backend) {}

  register(specs: readonly ModelSpec[]): void {
    for (const spec of specs) this.specs.set(spec.id, spec);
  }

  isLoaded(modelId: string): boolean {
    return this.sessions.has(modelId);
  }

  /** Verified load-or-reuse. Throws `ModelLoadError` on a hash mismatch or a runtime create
   * failure — the caller (worker.ts) is responsible for disabling only the affected capability
   * (e.g. the image path), never the whole agent (T-4.2's AC, phase_4_vision.md §9). */
  async get(modelId: string): Promise<ort.InferenceSession> {
    const existing = this.sessions.get(modelId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing.session;
    }
    const spec = this.specs.get(modelId);
    if (!spec) throw new ModelLoadError(modelId, 'not registered');

    const started = performance.now();
    const bytes = await fetchAndVerify(modelId, spec.url, spec.sha256);

    let session: ort.InferenceSession;
    try {
      session = await ort.InferenceSession.create(bytes, {
        executionProviders: [this.backend],
        graphOptimizationLevel: 'all',
      });
    } catch (err) {
      throw new ModelLoadError(modelId, err instanceof Error ? err.message : String(err));
    }

    const loadMs = performance.now() - started;
    this.sessions.set(modelId, { spec, session, bytes: bytes.byteLength, loadMs, lastUsedAt: Date.now() });
    return session;
  }

  /** T-6.3's other half: an `ocr-rec` model is useless without its character dictionary (it can
   * run inference but not turn the output into text) — verified and cached the same way an ONNX
   * session is, through this file's one disclosed fetch exception, not a new one. Returns the
   * dict's lines with blank/trailing-newline artifacts stripped (a dict file's own literal empty
   * lines, if any, are real PaddleOCR vocabulary entries and must not be dropped here — see
   * `ocr-rec.ts`'s `buildCtcVocabulary` doc comment). */
  async getDict(modelId: string): Promise<string[]> {
    const cached = this.dicts.get(modelId);
    if (cached) return cached;

    const spec = this.specs.get(modelId);
    if (!spec) throw new ModelLoadError(modelId, 'not registered');
    if (!spec.dictUrl || !spec.dictSha256) {
      throw new ModelLoadError(modelId, 'no dict configured for this model');
    }

    const bytes = await fetchAndVerify(modelId, spec.dictUrl, spec.dictSha256);
    const lines = new TextDecoder('utf-8')
      .decode(bytes)
      .split('\n')
      .filter((line) => line.length > 0);
    this.dicts.set(modelId, lines);
    return lines;
  }

  /** T-4.11: evict a non-resident session that has been idle. Resident models (`spec.resident`)
   * are never evicted here — the caller is expected not to ask, but this stays defensive rather
   * than trusting every call site to check first. */
  evictIfIdle(modelId: string, idleMs: number, now = Date.now()): boolean {
    const entry = this.sessions.get(modelId);
    if (!entry || entry.spec.resident) return false;
    if (now - entry.lastUsedAt < idleMs) return false;
    void entry.session.release();
    this.sessions.delete(modelId);
    return true;
  }

  evict(modelId: string): void {
    const entry = this.sessions.get(modelId);
    if (!entry) return;
    void entry.session.release();
    this.sessions.delete(modelId);
  }

  loadedInfo(): ModelInfo[] {
    return [...this.sessions.values()].map((e) => ({
      id: e.spec.id,
      role: e.spec.role,
      loadMs: e.loadMs,
      bytes: e.bytes,
    }));
  }

  memoryEstimateMB(): number {
    const totalBytes = [...this.sessions.values()].reduce((sum, e) => sum + e.bytes, 0);
    return totalBytes / (1024 * 1024);
  }
}
