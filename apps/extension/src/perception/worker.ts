/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web';
import type {
  Backend,
  BackendProbe,
  BenchResult,
  FromWorker,
  SpikeEnvironment,
  ToWorker,
} from './spike-protocol';

// Left unset deliberately: Vite bundles onnxruntime-web's own WASM binaries as build assets
// resolved from this module's URL, so they are already extension-local. Nothing is fetched from
// a CDN or the Hugging Face Hub at runtime (FR-13) — verified in the Phase-0 build output.
ort.env.allowLocalModels = true;

const ADAPTER_TIMEOUT_MS = 1500;

function post(msg: FromWorker) {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);
}

function environment(): SpikeEnvironment {
  const nav = self.navigator as Navigator & { deviceMemory?: number };
  return {
    userAgent: nav.userAgent,
    hardwareConcurrency: nav.hardwareConcurrency ?? 0,
    deviceMemoryGB: nav.deviceMemory ?? null,
    crossOriginIsolated: self.crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    workerContext: typeof WorkerGlobalScope !== 'undefined',
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);
}

async function probeWebGPU(): Promise<BackendProbe> {
  const started = performance.now();
  const gpu = (self.navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) {
    return { backend: 'webgpu', available: false, reason: 'no_navigator_gpu', probeMs: 0 };
  }
  const adapter = await withTimeout(gpu.requestAdapter(), ADAPTER_TIMEOUT_MS);
  if (adapter === 'timeout') {
    return { backend: 'webgpu', available: false, reason: 'timeout', probeMs: performance.now() - started };
  }
  if (!adapter) {
    return { backend: 'webgpu', available: false, reason: 'no_adapter', probeMs: performance.now() - started };
  }
  const device = await withTimeout(adapter.requestDevice(), ADAPTER_TIMEOUT_MS);
  if (device === 'timeout' || !device) {
    return { backend: 'webgpu', available: false, reason: 'no_device', probeMs: performance.now() - started };
  }
  const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
  device.destroy();
  return {
    backend: 'webgpu',
    available: true,
    adapter: {
      vendor: info?.vendor ?? 'unknown',
      architecture: info?.architecture ?? 'unknown',
      device: info?.device ?? 'unknown',
      description: info?.description ?? 'unknown',
    },
    probeMs: performance.now() - started,
  };
}

function probeWasm(): BackendProbe {
  const started = performance.now();
  const coi = self.crossOriginIsolated === true;
  // ORT only uses threads when SharedArrayBuffer is available, which requires cross-origin
  // isolation. Firefox extension pages never get it (architecture §5.1).
  const threads = coi ? Math.max(1, Math.min(4, Math.floor((self.navigator.hardwareConcurrency ?? 2) / 2))) : 1;
  ort.env.wasm.numThreads = threads;
  return {
    backend: 'wasm',
    available: true,
    simd: true,
    threads,
    crossOriginIsolated: coi,
    probeMs: performance.now() - started,
  };
}

function at(sorted: readonly number[], idx: number): number {
  const v = sorted[idx];
  if (v === undefined) throw new Error('percentile index out of range on an empty sample');
  return v;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return at(sorted, Math.max(0, idx));
}

async function bench(backend: Backend, modelUrl: string, model: string, runs: number): Promise<BenchResult> {
  const loadStart = performance.now();
  const session = await ort.InferenceSession.create(modelUrl, {
    executionProviders: [backend],
    graphOptimizationLevel: 'all',
  });
  const loadMs = performance.now() - loadStart;

  const inputName = session.inputNames[0];
  if (!inputName) throw new Error('model exposes no input names');
  const meta = session.inputMetadata?.[0] as { dimensions?: readonly (number | string)[] } | undefined;
  // Unknown or symbolic dimensions fall back to the model's documented input size.
  const shape = (meta?.dimensions ?? [1, 3, 320, 320]).map((d) =>
    typeof d === 'number' && d > 0 ? d : 1,
  ) as number[];
  const resolved = shape.length === 4 && shape[2] === 1 ? [1, 3, 320, 320] : shape;

  const elements = resolved.reduce((a, b) => a * b, 1);
  const data = new Float32Array(elements);
  for (let i = 0; i < elements; i++) data[i] = Math.random();
  const feeds = { [inputName]: new ort.Tensor('float32', data, resolved) };

  const warmStart = performance.now();
  await session.run(feeds);
  const warmupMs = performance.now() - warmStart;

  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await session.run(feeds);
    times.push(performance.now() - t0);
  }
  await session.release();

  const sorted = [...times].sort((a, b) => a - b);
  return {
    backend,
    model,
    n: runs,
    warmupMs,
    loadMs,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    minMs: at(sorted, 0),
    maxMs: at(sorted, sorted.length - 1),
    inputShape: resolved,
  };
}

self.addEventListener('message', async (event: MessageEvent<ToWorker>) => {
  const msg = event.data;
  try {
    if (msg.t === 'probe') {
      post({ t: 'env', env: environment() });
      post({ t: 'probed', probes: [await probeWebGPU(), probeWasm()] });
      return;
    }
    if (msg.t === 'bench') {
      post({ t: 'benched', result: await bench(msg.backend, msg.modelUrl, msg.model, msg.runs) });
    }
  } catch (err) {
    post({ t: 'error', code: 'WORKER_FAILED', detail: err instanceof Error ? err.message : String(err) });
  }
});

post({ t: 'env', env: environment() });
