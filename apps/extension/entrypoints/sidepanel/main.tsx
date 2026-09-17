import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { BackendProbe, BenchResult, FromWorker, SpikeEnvironment, ToWorker } from '../../src/shared/spike';

const MODEL_URL = '/models/face_detection_yunet_2023mar.onnx';
const MODEL_NAME = 'face-yunet-2023mar';
const RUNS = 30;

function send(worker: Worker, msg: ToWorker) {
  worker.postMessage(msg);
}

function App() {
  const [env, setEnv] = useState<SpikeEnvironment | null>(null);
  const [probes, setProbes] = useState<BackendProbe[] | null>(null);
  const [results, setResults] = useState<BenchResult[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [worker, setWorker] = useState<Worker | null>(null);

  useEffect(() => {
    const w = new Worker(new URL('../../src/perception/worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (event: MessageEvent<FromWorker>) => {
      const msg = event.data;
      if (msg.t === 'env') setEnv(msg.env);
      else if (msg.t === 'probed') setProbes(msg.probes);
      else if (msg.t === 'benched') {
        setResults((prev) => [...prev, msg.result]);
        setRunning(null);
      } else if (msg.t === 'error') {
        setError(`${msg.code}: ${msg.detail}`);
        setRunning(null);
      }
    };
    setWorker(w);
    send(w, { t: 'probe' });
    return () => w.terminate();
  }, []);

  function runBench(backend: 'webgpu' | 'wasm') {
    if (!worker) return;
    setError(null);
    setRunning(backend);
    send(worker, { t: 'bench', backend, modelUrl: MODEL_URL, model: MODEL_NAME, runs: RUNS });
  }

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', fontSize: 13, padding: 12, maxWidth: 480 }}>
      <h2 style={{ margin: '0 0 4px' }}>AEGIS — Phase 0 spike</h2>
      <p style={{ color: '#666', marginTop: 0 }}>
        Go/no-go: ONNX Runtime Web inference inside the side-panel worker, WebGPU vs WASM.
        See docs/PLAN.md Phase 0 and docs/TASKS.md T-0.6…T-0.13.
      </p>

      <section>
        <h3>Environment</h3>
        {env ? (
          <ul>
            <li>hardwareConcurrency: {env.hardwareConcurrency}</li>
            <li>deviceMemory: {env.deviceMemoryGB ?? 'unreported'} GB</li>
            <li>crossOriginIsolated: {String(env.crossOriginIsolated)}</li>
            <li>SharedArrayBuffer: {String(env.sharedArrayBuffer)}</li>
            <li>OffscreenCanvas: {String(env.offscreenCanvas)}</li>
          </ul>
        ) : (
          <p>probing…</p>
        )}
      </section>

      <section>
        <h3>Backend availability</h3>
        {probes ? (
          <ul>
            {probes.map((p) => (
              <li key={p.backend}>
                <strong>{p.backend}</strong>: {p.available ? 'available' : `unavailable (${p.reason})`}
                {p.backend === 'wasm' && p.available ? ` — threads=${p.threads}, coi=${p.crossOriginIsolated}` : ''}
                {p.adapter ? ` — ${p.adapter.vendor} ${p.adapter.architecture}` : ''}
                {' '}
                ({p.probeMs.toFixed(1)} ms)
              </li>
            ))}
          </ul>
        ) : (
          <p>probing…</p>
        )}
      </section>

      <section>
        <h3>Face-detector latency ({MODEL_NAME}, MIT, 227 KB, {RUNS} runs)</h3>
        <button disabled={running !== null} onClick={() => runBench('webgpu')}>
          {running === 'webgpu' ? 'Running…' : 'Bench WebGPU'}
        </button>{' '}
        <button disabled={running !== null} onClick={() => runBench('wasm')}>
          {running === 'wasm' ? 'Running…' : 'Bench WASM'}
        </button>
        {error && <p style={{ color: '#b00' }}>{error}</p>}
        <table style={{ marginTop: 8, borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              {['backend', 'load ms', 'warmup ms', 'p50 ms', 'p95 ms', 'min', 'max'].map((h) => (
                <th key={h} style={{ textAlign: 'left', borderBottom: '1px solid #ccc', padding: 4 }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {results.map((r, i) => (
              <tr key={i}>
                <td style={{ padding: 4 }}>{r.backend}</td>
                <td style={{ padding: 4 }}>{r.loadMs.toFixed(1)}</td>
                <td style={{ padding: 4 }}>{r.warmupMs.toFixed(1)}</td>
                <td style={{ padding: 4 }}>{r.p50Ms.toFixed(1)}</td>
                <td style={{ padding: 4 }}>{r.p95Ms.toFixed(1)}</td>
                <td style={{ padding: 4 }}>{r.minMs.toFixed(1)}</td>
                <td style={{ padding: 4 }}>{r.maxMs.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ color: '#666' }}>
          Copy these numbers into docs/HISTORY.md and docs/DECISIONS.md (OQ-16) once run on the
          chosen reference laptop, on Chrome and on Firefox.
        </p>
      </section>
    </div>
  );
}

render(<App />, document.getElementById('root')!);
