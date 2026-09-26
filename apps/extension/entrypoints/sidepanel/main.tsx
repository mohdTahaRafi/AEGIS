import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
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
import { UnredactPanel } from '../../src/ui/UnredactPanel';
import { Settings } from '../../src/ui/Settings';
import type { SanitizedContext } from '@aegis/protocol';
import type { EntityType } from '@aegis/recognizers';
import type { AblationArm } from '../../src/shared/ablation';
import { defaultPolicy } from '@aegis/policy';
import { applyAlwaysRedact, defaultSettings, loadSettings, saveSettings, type Settings as SettingsValue } from '../../src/host/settings/store';

// phase_2_spine.md §6.7's demo default; overridable at build time. design.md §13.5's "Server URL"
// setting (T-6.11) reads/writes these through `Settings`/`settings/store.ts` now — this constant
// stays as the *build-time* default `defaultSettings()` falls back to on a fresh install, per
// that row's own "Default: build-time value".
const GATEWAY_URL = (import.meta.env.VITE_GATEWAY_URL as string | undefined) ?? 'http://localhost:8787';
// design.md §4.1 (T-2.31); OQ-15 (docs/DECISIONS.md) leaves the finale's real provisioning model
// open — `dev-token` matches the gateway's own `config.py` default for local/demo use.
const GATEWAY_TOKEN = (import.meta.env.VITE_GATEWAY_TOKEN as string | undefined) ?? 'dev-token';

// design.md §13.5, T-6.11: `Settings`'s "Per-type redaction policy" row needs every entity type
// that exists — `defaultPolicy.entityClass`'s own keys are that list already (packages/policy's
// real data), not a second hardcoded enum living here.
const SETTINGS_ENTITY_TYPES = Object.keys(defaultPolicy.entityClass) as EntityType[];

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

// Mirrors models.manifest.json's three OCR entries (T-6.3/T-6.4) — same hand-duplication pattern
// and the same reason (public/ assets aren't part of the module graph). `resident: false`: OCR
// lazy-loads on first use (the halo re-scan today; a future T-6.5/T-6.6 fusion integration would
// be its other caller), per design.md §6.4's degradation ladder.
const OCR_DET_MODEL_SPEC = {
  id: 'ocr-det-ppocrv5-mobile',
  role: 'ocr-det' as const,
  url: '/models/ocr_det_ppocrv5_mobile.onnx',
  sha256: '4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae',
  resident: false,
};
const OCR_REC_EN_MODEL_SPEC = {
  id: 'ocr-rec-ppocrv5-mobile-en',
  role: 'ocr-rec' as const,
  script: 'latin' as const,
  url: '/models/ocr_rec_ppocrv5_mobile_en.onnx',
  sha256: 'c3461add59bb4323ecba96a492ab75e06dda42467c9e3d0c18db5d1d21924be8',
  dictUrl: '/models/ocr_rec_ppocrv5_mobile_en.dict.txt',
  dictSha256: 'e025a66d31f327ba0c232e03f407ae8d105e1e709e7ccb3f408aa778c24e70d6',
  resident: false,
};
const OCR_REC_DEVANAGARI_MODEL_SPEC = {
  id: 'ocr-rec-ppocrv5-mobile-devanagari',
  role: 'ocr-rec' as const,
  script: 'devanagari' as const,
  url: '/models/ocr_rec_ppocrv5_mobile_devanagari.onnx',
  sha256: 'd6f0a906580e3fa6b324a318718f1f31f268b6ea8ef985f91c2012a37f52c91e',
  dictUrl: '/models/ocr_rec_ppocrv5_mobile_devanagari.dict.txt',
  dictSha256: '09c7440bfc5477e5c41052304b6b185aff8c4a5e8b2b4c23c1c706f6fe1ee9fc',
  resident: false,
};

// Mirrors models.manifest.json's `vit-vision-clip-b32`/`vit-prompts-b32` entries (T-4.5/T-4.6),
// same hand-duplication pattern. `resident: true`: design.md §19 keeps the ViT encoder resident
// alongside the face detector, unlike OCR.
const VIT_VISION_MODEL_SPEC = {
  id: 'vit-vision-clip-b32',
  role: 'vit' as const,
  url: '/models/vit-vision.onnx',
  sha256: '2d070b5e6edc1ab9c849333753154025e780491b870bf4d0360f40b8378f19d6',
  assetUrl: '/models/vit-prompts.bin',
  assetSha256: 'e1a8968eba0269c36d56f89fefdaa340604a6b77198f77ca1f8d1f13d25417b6',
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

// phase_5_measurement.md §16a's harness-integration gap, closed here: the eval harness needs a
// way to start a task and read back the resulting ledger from outside the panel's own UI, since
// Playwright drives pages, not clicks on a specific rendered button. Declared narrowly (two
// functions, no state exposed) rather than exposing the whole `Session` object. Only ever
// reachable from this side-panel document's own `window` — a fixture page runs in a completely
// separate tab/document and has no access to it, so this adds no new surface a hostile page could
// reach; it's the same trust boundary the panel's own click handlers already sit behind.
declare global {
  interface Window {
    __aegisRunTask?: (task: string, canaries?: readonly string[]) => Promise<void>;
    __aegisLedgerExport?: () => unknown[];
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
  const [settings, setSettings] = useState<SettingsValue>(() => defaultSettings(GATEWAY_URL, GATEWAY_TOKEN));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;
  // T-6.8, 2026-09-26: real, previously-undiscovered bug found while measuring NER profile L's
  // corpus recall — `handleStart` (below) is assigned to `window.__aegisRunTask` exactly once, via
  // an empty-deps effect (see that effect's own comment for why: `handleStart` must stay a stable
  // reference across renders). That comment reasoned `handleStart` "closes over only stable
  // setters and module-level constants" — true for `session`/`panelState`, but NOT for `settings`,
  // which the ORIGINAL, now-fixed code read directly from component state. Every render's
  // `handleStart` closure captured THAT render's `settings` — but only the FIRST render's
  // `handleStart` is ever installed as `window.__aegisRunTask`, so it permanently saw the
  // hardcoded defaults (`nerProfile: 'S'`, `backend: 'auto'`, ...) from before `loadSettings()`'s
  // async `browser.storage.local` read had even resolved. Invisible to a real user (human reaction
  // time to click "Run" is far longer than one storage read), but genuinely means NO settings
  // change has ever actually reached a task run when `__aegisRunTask` fires programmatically before
  // that read resolves — the eval harness's `--ner-profile L` measurement above always silently ran
  // against profile S regardless of what was written to storage.local. Fixed the same way
  // `sessionRef` already fixes the identical class of problem one line up: a ref `handleStart`
  // reads from, kept current on every render rather than closed over once.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    loadSettings(browser.storage.local, defaultSettings(GATEWAY_URL, GATEWAY_TOKEN)).then(setSettings);
  }, []);

  function handleSessionEvent(event: SessionEvent, activeSession: Session): void {
    if (event.type === 'step') {
      setSteps((prev) => [...prev, event.step]);
      const latest = activeSession.getLedger().latest();
      if (latest) setLastPayload(latest.payload);
    } else if (event.type === 'sanitized_preview') {
      // Fires before the network call (session.ts, T-7.4/DR-2) so the sanitized preview survives
      // a SERVER_ERROR — the 'step' handler above still overwrites this once a step fully
      // completes, same payload shape either way.
      setLastPayload(event.payload);
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

  async function handleStart(task: string, canaries?: readonly string[]): Promise<void> {
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

    const gateway = createGatewayClient(settingsRef.current.serverUrl, import.meta.env.BROWSER === 'firefox' ? 'firefox' : 'chrome', fetch, settingsRef.current.accessToken);
    let created;
    try {
      created = await gateway.openSession();
    } catch {
      setPanelState('error');
      setErrorMessage('GATEWAY_UNREACHABLE');
      return;
    }

    // Phase 4: one perception worker per task, matching the vault's own per-task lifetime
    // (design.md §8) — a fresh worker means a fresh model-registry/backend-probe cycle rather
    // than pixels or model state surviving across unrelated tasks.
    //
    // [Fixed, Phase 5] This `await` used to sit BETWEEN `contentPort`'s construction and
    // `newSession`'s assignment below, which left a real window where a graph message arriving
    // from the content script mid-`init()` called `newSession.onGraph(m)` while `newSession` was
    // still the forward-reference's `undefined` — a genuine race, not a hypothetical one: it fired
    // in this project's very first real end-to-end Playwright run against the built extension
    // (Phase 5's harness-integration work), which no unit test's fake, synchronous content port
    // could ever have hit. Moved here so every `await` between the forward-reference and the real
    // assignment is gone — see docs/HISTORY.md's Phase 5 entry.
    const perceptionClient = createPerceptionClient();
    try {
      const ready = await perceptionClient.init(
        settingsRef.current.backend,
        [FACE_MODEL_SPEC, OCR_DET_MODEL_SPEC, OCR_REC_EN_MODEL_SPEC, OCR_REC_DEVANAGARI_MODEL_SPEC, VIT_VISION_MODEL_SPEC],
        settingsRef.current.nerProfile,
      );
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

    // design.md §18.3, T-6.9: the debug-only ablation switch. `import.meta.env.DEV` is Vite's own
    // build-mode flag (WXT wraps Vite) — a plain `wxt build`/`pnpm build` sets it `false`, so this
    // dynamic import (and `debug/ablations.ts` itself) never lands in a release bundle at all;
    // `test/unit/ablation-build.spec.ts` asserts that against the real built output, not just this
    // source line. Placed here, BEFORE the `newSession` forward-reference below, for the same
    // no-`await`-between-forward-reference-and-assignment reason `perceptionClient.init()` above
    // already has to be (see that block's own comment — a real race Phase 5 found and fixed).
    const ablationArm: AblationArm | undefined = import.meta.env.DEV
      ? await (await import('../../src/debug/ablations')).currentAblationArm(browser.storage.local)
      : undefined;

    const port = connectToTab(browser.tabs, tab.id);
    // Forward reference: ContentPortClient needs its handlers now, Session needs the constructed
    // ContentPortClient — see test/unit/session.spec.ts's buildSession() for the same pattern.
    // No `await` follows until `newSession` is actually assigned, by construction — see this
    // block's comment above for why that invariant matters.
    // eslint-disable-next-line prefer-const
    let newSession!: Session;
    const contentPort = new ContentPortClient(port, {
      onGraph: (m) => newSession.onGraph(m),
      onActionResult: (m) => newSession.onActionResult(m.actionId, m.ok, m.reason),
      onDisconnect: () => setPanelState('error'),
    });

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
      canaries,
      ablation: ablationArm,
      policy: applyAlwaysRedact(defaultPolicy, settingsRef.current.alwaysRedact),
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

  // Installed once — `handleStart` closes over only stable setters and module-level constants,
  // never over a render's `session`/`panelState` snapshot, so a single assignment stays correct
  // across the whole panel's lifetime (see `sessionRef` above for the one value that DOES need to
  // stay current across renders).
  useEffect(() => {
    window.__aegisRunTask = handleStart;
    window.__aegisLedgerExport = () => sessionRef.current?.getLedger().export() ?? [];
    return () => {
      delete window.__aegisRunTask;
      delete window.__aegisLedgerExport;
    };
  }, []);

  if (settingsOpen) {
    return (
      <div style={{ fontFamily: 'system-ui, sans-serif' }}>
        <Settings
          value={settings}
          entityTypes={SETTINGS_ENTITY_TYPES}
          onSave={(next) => {
            setSettings(next);
            saveSettings(browser.storage.local, next);
            setSettingsOpen(false);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      </div>
    );
  }

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', fontSize: 13, maxWidth: 480 }}>
      <div style={{ padding: 12 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <h2 style={{ margin: '0 0 4px' }}>AEGIS</h2>
          <button onClick={() => setSettingsOpen(true)}>Settings</button>
        </div>
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
        {settings.debugOverlay && <StepTimeline steps={steps} />}
        {lastPayload && (
          <>
            <RedactionSummary redactions={lastPayload.redactions} coverage={lastPayload.coverage} />
            <UnredactPanel redactions={lastPayload.redactions} onUnredact={(ref, reason) => session?.unredact(ref, reason)} />
            {settings.showRawPayload && <PayloadViewer payload={lastPayload} />}
          </>
        )}
        {report && <ReportView title={report.title} content={report.content} />}
      </div>
    </div>
  );
}

render(<App />, document.getElementById('root')!);
