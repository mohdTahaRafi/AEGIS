import { render } from 'preact';
import { useState } from 'preact/hooks';
import { ContentPortClient, connectToTab } from '../../src/host/port';
import { ensureHostPermission } from '../../src/host/platform/capabilities';
import { createGatewayClient } from '../../src/host/egress/gateway-client';
import { Session, type SessionEvent, type StepRecord } from '../../src/host/session';
import { PerceptionClient } from '../../src/host/perception-client/client';
import { panelStateLabel, type PanelState } from '../../src/ui/PanelStates';
import { TaskInput } from '../../src/ui/TaskInput';
import { StepTimeline } from '../../src/ui/StepTimeline';
import { MetricsBar } from '../../src/ui/MetricsBar';
import { ResourceBar } from '../../src/ui/ResourceBar';
import { ReportView } from '../../src/ui/ReportView';
import { ConfirmAction } from '../../src/ui/ConfirmAction';
import { GuardBlockCard } from '../../src/ui/GuardBlockCard';
import { PayloadViewer } from '../../src/ui/PayloadViewer';
import { RedactionSummary } from '../../src/ui/RedactionSummary';
import type { SanitizedContext } from '@aegis/protocol';

// phase_2_spine.md §6.7's demo default; overridable at build time (design.md §13.5's "Server URL"
// setting — a real settings UI is not built this phase, so this is the one place it lives).
const GATEWAY_URL = (import.meta.env.VITE_GATEWAY_URL as string | undefined) ?? 'http://localhost:8787';

// Mirrors public/models/models.manifest.json's face entry (T-4.3). [A] Duplicated rather than
// imported: `public/` assets are runtime-fetched static files in WXT/Vite's model, not part of
// the module graph — importing JSON from there would require a build-time file read this
// entrypoint has no reason to also own. Kept in sync by hand; a mismatch fails loudly (sha256
// verification in `runtime/sessions.ts` rejects a stale hash) rather than silently.
const FACE_MODEL_SPEC = {
  id: 'face-yunet-2023mar',
  role: 'face' as const,
  url: '/models/face_detection_yunet_2023mar.onnx',
  sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
  resident: true,
};

/** design.md §11.1 — the host's only reference to `perception/worker.ts`, via the `new
 * Worker(url, {type:'module'})` constructor rather than an import (the ESLint boundary rule
 * blocks `src/host/**` from importing `src/perception/**` by module path; a Worker URL is not a
 * module import — it is exactly the "talk only by message" the boundary requires). */
function createPerceptionClient(): PerceptionClient {
  const worker = new Worker(new URL('../../src/perception/worker.ts', import.meta.url), { type: 'module' });
  return new PerceptionClient(worker);
}

/** `captureVisibleTab` returns a `data:` URL, not bytes — decoded here by hand (base64 → `Blob`)
 * rather than by fetching the URL, which would (correctly) trip `check-no-network.ts`'s scan: the
 * scanner can't distinguish a `data:` URL from a real one by text alone, and a second named
 * exception isn't warranted when a manual decode is this small. */
function dataUrlToBlob(dataUrl: string): Blob {
  const [header, base64] = dataUrl.split(',');
  const mime = /data:([^;]+);base64/.exec(header ?? '')?.[1] ?? 'image/jpeg';
  const binary = atob(base64 ?? '');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** architecture §5.3 — captures the visible tab and decodes it into a transferable `ImageBitmap`
 * in the host, which then hands it to the worker (the only context that touches raw pixels
 * beyond this decode step). Returns null on any failure (no active tab, permission denied,
 * `captureVisibleTab` throttled) — the step proceeds L0, never blocking on a capture. */
async function captureVisibleTabAsBitmap(): Promise<ImageBitmap | null> {
  try {
    const dataUrl = await browser.tabs.captureVisibleTab({ format: 'jpeg', quality: 80 });
    return await createImageBitmap(dataUrlToBlob(dataUrl));
  } catch {
    return null;
  }
}

function App() {
  const [panelState, setPanelState] = useState<PanelState>('idle');
  const [steps, setSteps] = useState<StepRecord[]>([]);
  const [report, setReport] = useState<{ title?: string; content: string } | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [lastPayload, setLastPayload] = useState<SanitizedContext | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<{ risk: 'low' | 'medium' | 'high'; description: string; resolve: (v: boolean) => void } | null>(null);
  const [guardBlock, setGuardBlock] = useState<{ rule: string; entity?: string } | null>(null);
  const [perceptionBackend, setPerceptionBackend] = useState<'webgpu' | 'wasm' | null>(null);
  const [modelsLoadedMB, setModelsLoadedMB] = useState(0);

  function handleSessionEvent(event: SessionEvent, activeSession: Session): void {
    if (event.type === 'step') {
      setSteps((prev) => [...prev, event.step]);
      const latest = activeSession.getLedger().latest();
      if (latest) setLastPayload(latest.payload);
    } else if (event.type === 'report') {
      setReport({ title: event.title, content: event.content });
    } else if (event.type === 'done') {
      setPanelState('done');
      if (event.summary) setReport({ content: event.summary });
    } else if (event.type === 'guard_blocked') {
      setPanelState('blocked');
      setGuardBlock({ rule: event.rule, entity: event.entity });
    } else if (event.type === 'confirmation_required') {
      setPanelState('awaiting-confirmation');
      // The Promise this creates is handed to Session via `confirm` below — see handleStart.
    } else if (event.type === 'stopped') {
      setPanelState(event.reason === 'CANCELLED' ? 'idle' : 'error');
      if (event.reason !== 'CANCELLED') setErrorMessage(event.reason);
    }
  }

  async function handleStart(task: string): Promise<void> {
    setErrorMessage(null);
    setReport(null);
    setSteps([]);
    setLastPayload(null);
    setGuardBlock(null);
    setPanelState('loading');

    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) {
      setPanelState('error');
      setErrorMessage('NO_ACTIVE_TAB');
      return;
    }

    const origin = new URL(tab.url).origin;
    const permissionState = await ensureHostPermission(browser.permissions, origin);
    if (permissionState === 'denied') {
      setPanelState('no-permission');
      return;
    }

    const gateway = createGatewayClient(GATEWAY_URL, import.meta.env.BROWSER === 'firefox' ? 'firefox' : 'chrome');
    let created;
    try {
      created = await gateway.openSession();
    } catch {
      setPanelState('error');
      setErrorMessage('GATEWAY_UNREACHABLE');
      return;
    }

    const port = connectToTab(browser.tabs, tab.id);
    // Forward reference: ContentPortClient needs its handlers now, Session needs the constructed
    // ContentPortClient — see test/unit/session.spec.ts's buildSession() for the same pattern.
    // eslint-disable-next-line prefer-const
    let newSession!: Session;
    const contentPort = new ContentPortClient(port, {
      onGraph: (m) => newSession.onGraph(m),
      onActionResult: (m) => newSession.onActionResult(m.actionId, m.ok, m.reason),
      onDisconnect: () => setPanelState('error'),
    });
    // Phase 4: one perception worker per task, matching the vault's own per-task lifetime
    // (design.md §8) — a fresh worker means a fresh model-registry/backend-probe cycle rather
    // than pixels or model state surviving across unrelated tasks.
    const perceptionClient = createPerceptionClient();
    try {
      const ready = await perceptionClient.init('auto', [FACE_MODEL_SPEC], 'S');
      setPerceptionBackend(ready.backend);
      setModelsLoadedMB(ready.loaded.reduce((sum, m) => sum + m.bytes, 0) / (1024 * 1024));
    } catch {
      // Model load or backend probe failed — T-4.2's AC: this disables the image path only
      // (`deps.perception` is still passed; `runPerceptionStep` calls `capture()` and `perceive()`
      // regardless, and a session with no usable face model still returns `timedOut` regions,
      // which the compositor leaves grey, never silently cleared).
      setPerceptionBackend('wasm');
      setModelsLoadedMB(0);
    }

    newSession = new Session({
      contentPort,
      sendToGateway: (payload, signal) => gateway.sendStep(created.session_id, payload, signal),
      guardOrigin: origin,
      pageCategory: 'unknown',
      pageTitle: tab.title ?? '',
      onEvent: (event) => handleSessionEvent(event, newSession),
      confirm: (risk, description) =>
        new Promise<boolean>((resolve) => {
          setConfirmRequest({ risk, description, resolve });
        }),
      perception: { client: perceptionClient, capture: captureVisibleTabAsBitmap },
    });

    setSession(newSession);
    setPanelState('running');
    await newSession.start(task);
    await gateway.closeSession(created.session_id);
    perceptionClient.terminate(); // per-task lifetime — see the construction site's comment
    setPerceptionBackend(null);
  }

  function handleStop(): void {
    session?.cancel();
  }

  function handleConfirmDecision(allowed: boolean): void {
    confirmRequest?.resolve(allowed);
    setConfirmRequest(null);
    setPanelState('running');
  }

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', fontSize: 13, maxWidth: 480 }}>
      <div style={{ padding: 12 }}>
        <h2 style={{ margin: '0 0 4px' }}>AEGIS</h2>
        <p style={{ color: '#666', margin: '0 0 8px' }}>{panelStateLabel(panelState)}</p>

        {panelState === 'no-permission' && (
          <p style={{ color: '#b00' }}>This site needs host permission before AEGIS can run a task here. Try Run again to be prompted.</p>
        )}
        {panelState === 'error' && errorMessage && <p style={{ color: '#b00' }}>Error: {errorMessage}</p>}

        <TaskInput running={panelState === 'running' || panelState === 'loading'} onStart={handleStart} onStop={handleStop} />

        {confirmRequest && <ConfirmAction risk={confirmRequest.risk} description={confirmRequest.description} onDecide={handleConfirmDecision} />}
        {guardBlock && (
          <GuardBlockCard
            rule={guardBlock.rule}
            entity={guardBlock.entity}
            count={1}
            onRetry={() => setGuardBlock(null)}
            onStop={() => {
              setGuardBlock(null);
              session?.cancel();
            }}
          />
        )}

        <MetricsBar backend="not connected" steps={steps} />
        <ResourceBar backend={perceptionBackend} modelsLoadedMB={modelsLoadedMB} />
        <StepTimeline steps={steps} />
        {lastPayload && (
          <>
            <RedactionSummary redactions={lastPayload.redactions} coverage={lastPayload.coverage} />
            <PayloadViewer payload={lastPayload} />
          </>
        )}
        {report && <ReportView title={report.title} content={report.content} />}
      </div>
    </div>
  );
}

render(<App />, document.getElementById('root')!);
