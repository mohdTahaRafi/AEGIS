import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ContentPortClient, connectToTab } from '../../src/host/port';
import { connectToLiveContent } from '../../src/host/content-connection';
import { ensureTaskPermissions, listenForPermissionRevocation } from '../../src/host/platform/capabilities';
import { createGatewayClient, type GatewayClient } from '../../src/host/egress/gateway-client';
import { createAgentClient } from '../../src/host/egress/agent-client';
import { verifyApiKey } from '../../src/host/egress/model-client';
import { PROVIDERS, type ProviderId } from '../../src/host/egress/providers';
import { PERCEPTION_MODELS } from '../../src/host/perception-client/model-specs';
import { Session, type HistoryEntry, type SessionEvent, type StepRecord } from '../../src/host/session';
import { forgetTask, loadDraft, loadTask, saveDraft, saveTask, stepsStarted, wasCutOff, type SavedTask } from '../../src/host/saved-task';
import { PerceptionClient, type WorkerProblem } from '../../src/host/perception-client/client';
import type { CaptureResult } from '../../src/host/capture/classify';
import { captureTargetTab, type CaptureTarget } from '../../src/host/capture/capture-tab';
import { createGatedCapture } from '../../src/host/capture/grant-gate';
import { originOf, readInvocation, type GrantExplanation } from '../../src/shared/invocation';
import { isActionInvokedMessage } from '../../src/shared/messages';
import type { FromWorker, ModelLoadFailure } from '../../src/shared/worker-protocol';
import { panelStateLabel, type PanelState } from '../../src/ui/PanelStates';
import { TaskInput } from '../../src/ui/TaskInput';
import { StepTimeline } from '../../src/ui/StepTimeline';
import { MetricsBar } from '../../src/ui/MetricsBar';
import { ResourceBar } from '../../src/ui/ResourceBar';
import { ConfirmAction } from '../../src/ui/ConfirmAction';
import { AskUser } from '../../src/ui/AskUser';
import { GrantRequest } from '../../src/ui/GrantRequest';
import { GuardBlockCard } from '../../src/ui/GuardBlockCard';
import { applyRunLogEvent, EMPTY_RUN_LOG, type RunLog } from '../../src/ui/RunLog';
import { ResultCard, RunLogView } from '../../src/ui/RunLogView';
import type { ProtectedField } from '../../src/host/session';
import { PrivacyCard } from '../../src/ui/PrivacyCard';
import { TaskProgress } from '../../src/ui/TaskProgress';
import { ErrorNotice, Notice } from '../../src/ui/Notice';
import { IconGear } from '../../src/ui/icons';
import { Settings } from '../../src/ui/Settings';
import type { SanitizedContext } from '@aegis/protocol';
import type { EntityType } from '@aegis/recognizers';
import type { AblationArm } from '../../src/shared/ablation';
import { defaultPolicy } from '@aegis/policy';
import { activeApiKey, applyAlwaysRedact, defaultSettings, loadSettings, resolveModelConfig, saveSettings, type Settings as SettingsValue } from '../../src/host/settings/store';
import { ApiKeyCard } from '../../src/ui/ApiKeyCard';
import { C, R, S, T } from '../../src/ui/design';

// A release build (`wxt build`) has no server and no developer endpoints: every task goes straight
// from this panel to the chosen model API (egress/providers.ts) with the user's own key. Development builds may still use the legacy
// gateway (eval harness, replay demo) when no key is saved.
const RELEASE = import.meta.env.MODE === 'production';

// phase_2_spine.md §6.7's demo default; overridable at build time. design.md §13.5's "Server URL"
// setting (T-6.11) reads/writes these through `Settings`/`settings/store.ts` now — this constant
// stays as the *build-time* default `defaultSettings()` falls back to on a fresh install, per
// that row's own "Default: build-time value".
const GATEWAY_URL = RELEASE ? '' : ((import.meta.env.VITE_GATEWAY_URL as string | undefined) ?? 'http://localhost:8787');
// design.md §4.1 (T-2.31); OQ-15 (docs/DECISIONS.md) leaves the finale's real provisioning model
// open — `dev-token` matches the gateway's own `config.py` default for local/demo use.
const GATEWAY_TOKEN = RELEASE ? '' : ((import.meta.env.VITE_GATEWAY_TOKEN as string | undefined) ?? 'dev-token');

// design.md §13.5, T-6.11: `Settings`'s "Per-type redaction policy" row needs every entity type
// that exists — `defaultPolicy.entityClass`'s own keys are that list already (packages/policy's
// real data), not a second hardcoded enum living here.
const SETTINGS_ENTITY_TYPES = Object.keys(defaultPolicy.entityClass) as EntityType[];

/** design.md §11.1 — the host's only reference to `perception/worker.ts`, via the `new
 * Worker(url, {type:'module'})` constructor rather than an import (the ESLint boundary rule
 * blocks `src/host/**` from importing `src/perception/**` by module path; a Worker URL is not a
 * module import — it is exactly the "talk only by message" the boundary requires). */
const ROLE_NAME: Partial<Record<string, string>> = { face: 'YuNet', vit: 'CLIP', 'ocr-det': 'OCR det', 'ocr-rec': 'OCR rec' };

/** Resource-bar detail: why WebGPU was refused, or where each resident model landed and the probe
 * timings that decided it (OCR loads lazily, so it appears in the per-step line instead). */
function describeReadyBackend(ready: Extract<FromWorker, { t: 'ready' }>): string | undefined {
  if (ready.webgpuRejected) return `WebGPU refused: ${ready.webgpuRejected}`;
  if (ready.backend !== 'webgpu') return undefined;
  return ready.loaded
    .map((m) => {
      const probe = m.probeMs?.wasm !== undefined && m.probeMs.webgpu !== undefined ? ` (${Math.round(m.probeMs.wasm)}/${Math.round(m.probeMs.webgpu)} ms)` : '';
      return `${ROLE_NAME[m.role] ?? m.role} ${m.provider}${probe}`;
    })
    .join(' · ');
}

/** From a worker factory: a crashed or wedged worker is replaced by a fresh one mid-task. */
function createPerceptionClient(): PerceptionClient {
  return new PerceptionClient(() => new Worker(new URL('../../src/perception/worker.ts', import.meta.url), { type: 'module' }));
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

/** architecture §5.3 — captures the task's own tab (never "whatever is in front of the current
 * window", see capture-tab.ts) and decodes it into a transferable `ImageBitmap` in the host, which
 * then hands it to the worker (the only context that touches raw pixels beyond this decode step).
 * A failure carries its reason and Chrome's own error text so the panel and ledger show why vision
 * was not used; a missing activeTab grant is handled one level up (grant-gate.ts). */
async function captureTabAsBitmap(target: CaptureTarget): Promise<CaptureResult> {
  // No `update`/`query`: the task tab is never pulled to the front behind the user's back — the
  // capture waits until the user is back on it (`waitForTaskTabVisible` below).
  const captured = await captureTargetTab({ get: (id) => browser.tabs.get(id), captureVisibleTab: (w, o) => browser.tabs.captureVisibleTab(w, o) }, target);
  if (!captured.ok) {
    let invocation: unknown;
    try {
      invocation = await readInvocation(browser.storage.session, target.tabId);
    } catch {
      invocation = 'unreadable';
    }
    // Local console only. Origins, never paths or queries; no page content.
    console.warn('[aegis] capture failed', { reason: captured.reason, chromeError: captured.detail, ...captured.diag, invocation });
    return { ok: false, reason: captured.reason, detail: captured.detail };
  }
  try {
    return { ok: true, bitmap: await createImageBitmap(dataUrlToBlob(captured.dataUrl)) };
  } catch {
    return { ok: false, reason: 'decode' };
  }
}

/** Resolves true once the tab has finished loading, false on timeout or if the tab is gone. */
function waitForTabComplete(tabId: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let finished = false;
    const listener = (id: number, info: { status?: string }): void => {
      if (id === tabId && info.status === 'complete') finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    function finish(ok: boolean): void {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(listener);
      resolve(ok);
    }
    browser.tabs.onUpdated.addListener(listener);
    browser.tabs.get(tabId).then(
      (t) => {
        if (t.status === 'complete') finish(true);
      },
      () => finish(false),
    );
  });
}

/** Resolves true when the tab starts loading a document, false after `timeoutMs` (it never did:
 * a same-document change, or nothing to go back to). Listen BEFORE triggering the navigation. */
function waitForLoadStart(tabId: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const listener = (id: number, info: { status?: string }): void => {
      if (id === tabId && info.status === 'loading') finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    function finish(started: boolean): void {
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(listener);
      resolve(started);
    }
    browser.tabs.onUpdated.addListener(listener);
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
// After a step's actions, before the page is observed and captured: a click that navigates
// starts loading only after its request goes out, so give it this long to start. The tab's
// `complete` status is then waited for only briefly: heavy pages (trackers, ads) fire it long
// after they are usable, and whether the page is visually complete — its pictures loaded — is
// decided by the page itself before every observation (content/observe/ready.ts).
const LOAD_START_GRACE_MS = 600;
const PAINT_MS = 150;
const PAGE_LOAD_TIMEOUT_MS = 2500;
// Gateway session open at Run: a gateway that is still starting (or restarting) gets this long.
const GATEWAY_OPEN_ATTEMPTS = 6;
// Re-attaching to a page AEGIS's own action loaded: past this the page is reported unreachable.
const ATTACH_DEADLINE_MS = 60_000;
const WEB_PAGE = /^https?:\/\//;
// The saved task (host/saved-task.ts) is written at most this often while a task runs.
const SAVE_EVERY_MS = 400;

type InjectableFiles = NonNullable<Parameters<typeof browser.scripting.executeScript>[0]['files']>;

/** The manifest's own declared content-script file(s) — the same bundle Chrome injects on page
 * load, so a programmatic injection can never be a different build of it. */
async function injectContentScript(tabId: number): Promise<void> {
  const files = browser.runtime.getManifest().content_scripts?.flatMap((cs) => cs.js ?? []) ?? [];
  if (files.length === 0) throw new Error('no content script declared');
  // WXT types `files` as its own build-time path union; these come from the built manifest itself.
  await browser.scripting.executeScript({ target: { tabId, allFrames: true }, files: files as InjectableFiles });
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
    __aegisRunTask?: (task: string, canaries?: readonly string[], targetTabId?: number) => Promise<void>;
    __aegisLedgerExport?: () => unknown[];
  }
}

/** The user's country from the browser's language ("en-IN" → "IN"), for picking shops that serve
 * it. Undefined when the language names no country. */
function browserRegion(): string | undefined {
  for (const tag of navigator.languages ?? [navigator.language]) {
    const region = /^[a-z]{2,3}-([A-Z]{2})\b/.exec(tag)?.[1];
    if (region) return region;
  }
  return undefined;
}

/** A stopped task's message. A refused key or an exhausted quota is something the user can fix, so
 * it says so (the detail is the closed-vocabulary one from `agent/errors.ts`). */
function describeStop(reason: string, detail: string | undefined, provider: string): string {
  if (detail?.includes('upstream_auth')) return `API_KEY_REJECTED - ${provider} refused your API key (revoked, mistyped or from another account). Open Settings and enter a valid key.`;
  if (detail?.includes('upstream_quota_day')) return `DAILY_LIMIT_REACHED - today's free requests on ${provider} are used up for every model AEGIS can use there. Switch provider in Settings, or Run again tomorrow.`;
  if (detail?.includes('upstream_429')) return `${reason}: ${detail} - your ${provider} free-tier limit is used up for now; wait, or switch provider in Settings, then Run again`;
  return detail ? `${reason}: ${detail}` : reason;
}

/** Resolves once the tab is the front tab of its window (immediately if it already is), or false if
 * `signal` aborts or the tab closes first. `captureVisibleTab` can only see a front tab. */
function waitForTabVisible(tabId: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (visible: boolean) => {
      if (done) return;
      done = true;
      browser.tabs.onActivated.removeListener(onActivated);
      browser.tabs.onRemoved.removeListener(onRemoved);
      signal.removeEventListener('abort', onAbort);
      resolve(visible);
    };
    const onActivated = (info: { tabId: number }) => {
      if (info.tabId === tabId) finish(true);
    };
    const onRemoved = (id: number) => {
      if (id === tabId) finish(false);
    };
    const onAbort = () => finish(false);
    browser.tabs.onActivated.addListener(onActivated);
    browser.tabs.onRemoved.addListener(onRemoved);
    signal.addEventListener('abort', onAbort, { once: true });
    browser.tabs.get(tabId).then(
      (t) => {
        if (t.active) finish(true);
      },
      () => finish(false),
    );
  });
}

/** The panel's one perception worker: created when the panel opens (models load while the user
 * types the task) and kept across tasks; `reset` between tasks drops each task's capture and
 * cached findings. Recreated only when the backend or NER profile setting changes. */
interface PerceptionHandle {
  key: string;
  client: PerceptionClient;
  ready: Promise<Extract<FromWorker, { t: 'ready' }> | null>;
}

function App() {
  const [panelState, setPanelState] = useState<PanelState>('idle');
  const [steps, setSteps] = useState<StepRecord[]>([]);
  const [runLog, setRunLog] = useState<RunLog>(EMPTY_RUN_LOG);
  const [protectedFields, setProtectedFields] = useState<ProtectedField[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // The task last started from this panel and when, for the progress card.
  const [currentTask, setCurrentTask] = useState<{ text: string; startedAt: number } | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [lastPayload, setLastPayload] = useState<SanitizedContext | null>(null);
  const [grantRequest, setGrantRequest] = useState<{ explanation: GrantExplanation; settle: (outcome: 'retry' | 'cancelled') => void } | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<{ risk: 'low' | 'medium' | 'high'; description: string; resolve: (v: boolean) => void } | null>(null);
  const [questionRequest, setQuestionRequest] = useState<{ question: string; resolve: (answer: string | null) => void } | null>(null);
  const [userWait, setUserWait] = useState<string | null>(null);
  const [guardBlock, setGuardBlock] = useState<{ rule: string; entity?: string } | null>(null);
  const [perceptionBackend, setPerceptionBackend] = useState<'webgpu' | 'wasm' | null>(null);
  const [backendDetail, setBackendDetail] = useState<string | undefined>(undefined);
  const [gatewayMode, setGatewayMode] = useState<'live' | 'record' | 'replay' | 'not connected'>('not connected');
  const [modelsLoadedMB, setModelsLoadedMB] = useState(0);
  const [modelLoadFailures, setModelLoadFailures] = useState<ModelLoadFailure[]>([]);
  const [workerProblems, setWorkerProblems] = useState<WorkerProblem[]>([]);
  const [settings, setSettings] = useState<SettingsValue>(() => defaultSettings(GATEWAY_URL, GATEWAY_TOKEN));
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The first-run key card stays up a few seconds after a key is saved, so its "Key works" is seen.
  const [keyJustSaved, setKeyJustSaved] = useState(false);
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;
  // The model "Test key" picked on the first-run card, saved with the key.
  const pickedModel = useRef<string | undefined>(undefined);
  // Read by `handleStart`, which the harness hook installs once: it must see the current settings,
  // not the first render's (the async storage read resolves after that render).
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const perceptionRef = useRef<PerceptionHandle | null>(null);
  // Aborted by Stop: ends the task's own waits (the task tab coming back to the front, ...).
  const taskAbortRef = useRef<AbortController | null>(null);
  // The user declined "all sites" once in this panel session: not asked again on every Run.
  const allSitesDeclinedRef = useRef(false);
  // Pending user-facing promises, so Stop can settle every one of them.
  const confirmRef = useRef(confirmRequest);
  confirmRef.current = confirmRequest;
  const questionRef = useRef(questionRequest);
  questionRef.current = questionRequest;
  const grantRef = useRef(grantRequest);
  grantRef.current = grantRequest;
  // The task is saved per window (host/saved-task.ts): set once the saved one has been looked for.
  const savedTaskReadyRef = useRef(false);
  // A task cut off by closing the panel, as saved: Resume continues it. Kept until a session starts.
  const [resumable, setResumable] = useState<SavedTask | null>(null);
  // A task has been started from this panel: a saved one is no longer restored over it.
  const startedRef = useRef(false);
  // The task's tab (it follows the task into tabs it opens) and the HISTORY to save until the
  // task's Session exists, for the saved record.
  const taskTargetRef = useRef<CaptureTarget | null>(null);
  const priorHistoryRef = useRef<HistoryEntry[]>([]);
  const pendingSaveRef = useRef<SavedTask | null>(null);
  // The task box's text, saved on every change so closing the panel does not lose it.
  const [draft, setDraft] = useState('');
  const draftTouchedRef = useRef(false);

  function changeDraft(text: string): void {
    draftTouchedRef.current = true;
    setDraft(text);
    browser.windows
      .getCurrent()
      .then((win) => (win.id === undefined ? undefined : saveDraft(browser.storage.session, win.id, text)))
      .catch((err: unknown) => console.error('[aegis] saving the draft', err));
  }
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function flushSave(): void {
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    const pending = pendingSaveRef.current;
    pendingSaveRef.current = null;
    // The window is looked up on every save: a panel page moved to another window (the harness's
    // visible runs do this) saves where it now is.
    if (pending)
      browser.windows
        .getCurrent()
        .then((win) => (win.id === undefined ? undefined : saveTask(browser.storage.session, win.id, pending)))
        .catch((err: unknown) => console.error('[aegis] saving the task', err));
  }

  function restoreTask(saved: SavedTask): void {
    const state = wasCutOff(saved.state) ? 'interrupted' : saved.state;
    const latest = saved.log.steps.findLast((s) => s.payload !== undefined);
    setCurrentTask({ text: saved.task, startedAt: saved.startedAt });
    setRunLog(saved.log);
    setSteps(saved.log.steps.flatMap((s) => (s.record ? [s.record] : [])));
    setLastPayload(latest?.payload ?? null);
    setProtectedFields(latest?.protectedFields ?? []);
    setErrorMessage(saved.errorMessage);
    setPanelState(state);
    taskTargetRef.current = { tabId: saved.tabId, origin: '' };
    priorHistoryRef.current = saved.history;
    if (state === 'interrupted') setResumable({ ...saved, state });
  }

  // Every change to the task's view is saved, so a closed panel shows it again when reopened.
  useEffect(() => {
    if (!savedTaskReadyRef.current || !currentTask) return;
    pendingSaveRef.current = {
      version: 1,
      task: currentTask.text,
      startedAt: currentTask.startedAt,
      tabId: taskTargetRef.current?.tabId ?? -1,
      state: panelState,
      errorMessage,
      log: runLog,
      history: sessionRef.current?.getHistory() ?? priorHistoryRef.current,
    };
    saveTimerRef.current ??= setTimeout(flushSave, SAVE_EVERY_MS);
  }, [currentTask, runLog, panelState, errorMessage]);

  useEffect(() => {
    void loadSettings(browser.storage.local, defaultSettings(GATEWAY_URL, GATEWAY_TOKEN)).then((loaded) => {
      settingsRef.current = loaded;
      setSettings(loaded);
      setSettingsLoaded(true);
    });
    void browser.windows
      .getCurrent()
      .then(async (win) => {
        if (win.id === undefined || !browser.storage.session) return;
        const [saved, savedDraft] = await Promise.all([loadTask(browser.storage.session, win.id), loadDraft(browser.storage.session, win.id)]);
        savedTaskReadyRef.current = true;
        if (savedDraft && !draftTouchedRef.current) setDraft(savedDraft);
        if (saved && !startedRef.current) restoreTask(saved);
      })
      .catch((err: unknown) => console.error('[aegis] restoring the task', err));
    const onUnload = () => {
      flushSave();
      perceptionRef.current?.client.terminate();
    };
    window.addEventListener('pagehide', onUnload);
    return () => window.removeEventListener('pagehide', onUnload);
  }, []);

  /** The panel's perception worker for the current settings, created (and its models loading) on
   * first use; a worker for different backend/NER settings is replaced. */
  function ensurePerception(current: SettingsValue): PerceptionHandle {
    const profile: 'S' | 'L' = RELEASE ? 'S' : current.nerProfile;
    const key = `${current.backend}|${profile}`;
    const existing = perceptionRef.current;
    if (existing && existing.key === key) return existing;
    existing?.client.terminate();
    const client = createPerceptionClient();
    client.onProblem((problem) => {
      console.error('[aegis] perception worker problem', problem);
      setWorkerProblems((prev) => [...prev.slice(-9), problem]);
    });
    const ready = client.init(current.backend, PERCEPTION_MODELS, profile).then(
      (info) => {
        setPerceptionBackend(info.backend);
        setBackendDetail(describeReadyBackend(info));
        setModelsLoadedMB(info.loaded.reduce((sum, m) => sum + m.bytes, 0) / (1024 * 1024));
        setModelLoadFailures(info.failed);
        console.info('[aegis] perception backend', info.backend, { adapter: info.adapterInfo, webgpuRejected: info.webgpuRejected, models: info.loaded.map((m) => ({ role: m.role, provider: m.provider, probeMs: m.probeMs })) });
        if (info.failed.length > 0) console.error('[aegis] perception models failed to load', info.failed);
        return info;
      },
      (err: unknown) => {
        // The client re-initialises on the next request (a fresh worker if this one died).
        console.error('[aegis] perception init failed', err);
        setPerceptionBackend(null);
        setBackendDetail(undefined);
        setModelsLoadedMB(0);
        setWorkerProblems((prev) => [...prev.slice(-9), { kind: 'error', code: 'INIT_FAILED' }]);
        return null;
      },
    );
    const handle = { key, client, ready };
    perceptionRef.current = handle;
    return handle;
  }

  // Preload: the models load while the user reads the page and types the task.
  useEffect(() => {
    if (settingsLoaded) ensurePerception(settings);
  }, [settingsLoaded, settings.backend, settings.nerProfile]);

  function note(text: string): void {
    setRunLog((prev) => applyRunLogEvent(prev, { type: 'note', text }));
  }

  function handleSessionEvent(event: SessionEvent, activeSession: Session | null): void {
    setRunLog((prev) => applyRunLogEvent(prev, event));
    if (event.type === 'step') {
      // Numbers only (closed vocabulary): per-stage wall time of this step, in ms.
      console.info('[aegis] step timings', event.step.stepId, JSON.stringify(Object.fromEntries(Object.entries(event.step.stageTimings).map(([k, v]) => [k, Math.round(v)]))));
      setSteps((prev) => [...prev, event.step]);
      const latest = activeSession?.getLedger().latest();
      if (latest) setLastPayload(latest.payload);
    } else if (event.type === 'sanitized_preview') {
      // Fires before the network call, so the sanitized preview survives a server error.
      setLastPayload(event.payload);
      setProtectedFields(event.protectedFields ?? []);
    } else if (event.type === 'perception') {
      setUserWait(null);
      const d = event.status.diagnostics;
      if (d) console.info('[aegis] perception timings', event.stepId, JSON.stringify({ total: Math.round(d.ms.total), face: Math.round(d.ms.face), vit: Math.round(d.ms.vit), ocr: Math.round(d.ms.ocr), screenLabel: Math.round(d.ms.screenLabel), crops: d.regions.length, cached: d.cachedRegions ?? 0, backend: d.backend }));
    } else if (event.type === 'done') {
      setPanelState('done');
      setUserWait(null);
    } else if (event.type === 'guard_blocked') {
      // Not the end of the task: that step sent nothing, and the next one starts afresh.
      setGuardBlock({ rule: event.rule, entity: event.entity });
    } else if (event.type === 'waiting_user') {
      setUserWait(event.detail ?? 'AEGIS is waiting for you on the page');
    } else if (event.type === 'plan') {
      setUserWait(null);
      setGuardBlock(null);
    } else if (event.type === 'recovering') {
      console.warn('[aegis] recovering', event.what, event.detail);
    } else if (event.type === 'confirmation_required') {
      setPanelState('awaiting-confirmation');
    } else if (event.type === 'stopped') {
      setUserWait(null);
      setConfirmRequest(null);
      setQuestionRequest(null);
      setGrantRequest(null);
      setPanelState(event.reason === 'CANCELLED' ? 'idle' : 'error');
      if (event.reason !== 'CANCELLED') setErrorMessage(describeStop(event.reason, event.detail, PROVIDERS[settingsRef.current.provider].label.replace(/ \(.*\)$/, '')));
    }
  }

  /** `targetTabId`: the tab to run on when it is not the active one — a resumed task's own tab, or
   * (harness, `__aegisRunTask`) a page beside a panel in its own window. `resume`: a task cut off
   * by closing the panel, continued with its run log and HISTORY. */
  async function handleStart(task: string, canaries?: readonly string[], targetTabId?: number, resume?: SavedTask): Promise<void> {
    setErrorMessage(null);
    const current = settingsRef.current;
    const apiKey = activeApiKey(current);
    const providerName = PROVIDERS[current.provider].label.replace(/ \(.*\)$/, '');
    if (RELEASE && !apiKey) {
      setPanelState('error');
      setErrorMessage(`API_KEY_MISSING - add your free ${providerName} API key in the box at the top of this panel, then Run again`);
      return;
    }
    startedRef.current = true;
    sessionRef.current = null;
    setSession(null);
    priorHistoryRef.current = resume?.history ?? [];
    taskTargetRef.current = resume ? { tabId: resume.tabId, origin: '' } : null;
    if (!resume) setResumable(null);
    setCurrentTask({ text: task, startedAt: Date.now() });
    if (!resume) {
      setRunLog(EMPTY_RUN_LOG);
      setProtectedFields([]);
      setSteps([]);
      setLastPayload(null);
    }
    setGuardBlock(null);
    setWorkerProblems([]);
    setPanelState('loading');
    const taskAbort = new AbortController();
    taskAbortRef.current = taskAbort;

    const [tab] = targetTabId !== undefined ? [await browser.tabs.get(targetTabId).catch(() => undefined)] : await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) {
      setPanelState('error');
      setErrorMessage('NO_ACTIVE_TAB');
      return;
    }

    if (!WEB_PAGE.test(tab.url)) {
      setPanelState('error');
      setErrorMessage('UNSUPPORTED_PAGE - AEGIS runs on http(s) web pages, not browser pages (chrome://, the Web Store, the PDF viewer, file://)');
      return;
    }
    const origin = new URL(tab.url).origin;
    if (resume) note(`Resumed after the panel was closed: continuing after step ${stepsStarted(resume.log)}`);
    note(`AEGIS build ${import.meta.env.VITE_AEGIS_BUILD ?? 'unknown'} UTC`);
    note(`Task "${task}" on ${origin}`);
    const permissions = await ensureTaskPermissions(browser.permissions, origin, !allSitesDeclinedRef.current);
    if (permissions.state === 'denied') {
      setPanelState('no-permission');
      return;
    }
    if (!permissions.allSites) allSitesDeclinedRef.current = true;
    note(
      permissions.allSites
        ? 'Site access: all sites (the task can move to other sites by itself)'
        : 'Site access: this site only - a tab the task opens on another site needs a click on the AEGIS icon there (allow "all sites" to avoid this)',
    );
    // After the permission prompt (it needs the Run click's user gesture): a page still loading
    // shows the model a half-empty page on step 1, so let it finish first.
    if (tab.status === 'loading') {
      note('Waiting for the page to finish loading');
      await waitForTabComplete(tab.id, PAGE_LOAD_TIMEOUT_MS);
      await sleep(PAINT_MS);
    }

    // Before the model session: a tab with no live content script (open since before an extension
    // reload, or loaded before its host grant) can never produce a graph. The port is buffered, so
    // nothing the content script sends during the awaits below is lost.
    const connection = await connectToLiveContent(tab.id, {
      connect: (tabId) => connectToTab(browser.tabs, tabId),
      inject: injectContentScript,
      lastErrorMessage: () => browser.runtime.lastError?.message,
    });
    if (!connection.ok) {
      if (connection.reason === 'inject-failed') console.warn('[aegis] content script injection failed', connection.detail);
      setPanelState('error');
      setErrorMessage('PAGE_NOT_CONNECTED - click the AEGIS toolbar icon while this tab is in front (or reload the page), then Run again');
      return;
    }
    const port = connection.port;
    note('Connected to the page');
    let currentPort = port;
    // The task's target: every capture is of this tab. Its origin follows the page when one of
    // AEGIS's own actions navigates (reconnect below).
    const target: CaptureTarget = { tabId: tab.id, origin };
    taskTargetRef.current = target;
    // Every tab this task has worked in, in first-use order: the model sees them as TABS and can go
    // back to one (switch_tab) or close it. Tabs the user had open otherwise are never listed.
    const taskTabs: number[] = [tab.id];

    // Bring your own key: with a key saved (always, in a release build) the model is called directly
    // from this panel; the gateway is a development fallback only.
    const useOwnKey = RELEASE || apiKey !== '';
    let lastStepId = 's-0';
    const modelConfig = resolveModelConfig(current, RELEASE);
    const gateway: GatewayClient = useOwnKey
      ? createAgentClient(
          modelConfig,
          {
            onModelSwitch: (from, to) => {
              const label = (id: string) => PROVIDERS[modelConfig.provider].models.find((m) => m.id === id)?.label.replace(/ \(.*\)$/, '') ?? id;
              note(`Today's free requests for ${label(from)} are used up: continuing with ${label(to)}`);
            },
          },
          (commentary) => handleSessionEvent({ type: 'commentary', stepId: lastStepId, ...commentary }, sessionRef.current),
          browserRegion(),
        )
      : createGatewayClient(current.serverUrl, import.meta.env.BROWSER === 'firefox' ? 'firefox' : 'chrome', fetch, current.accessToken);
    // A gateway that is starting, restarting or briefly unreachable is waited for; only a wrong
    // token (retrying cannot fix it) or a gateway that never comes up ends the attempt. Opening a
    // session with the model directly is local and cannot fail.
    let created: Awaited<ReturnType<typeof gateway.openSession>> | undefined;
    let openStatus: string | undefined;
    for (let attempt = 0; attempt < GATEWAY_OPEN_ATTEMPTS; attempt++) {
      try {
        created = await gateway.openSession();
        break;
      } catch (err) {
        openStatus = /SESSION_OPEN_FAILED: (\d+)/.exec(err instanceof Error ? err.message : '')?.[1];
        if (openStatus === '401' || openStatus === '403') break;
        if (attempt < GATEWAY_OPEN_ATTEMPTS - 1) {
          const waitMs = Math.min(8000, 1000 * 2 ** attempt);
          note(`Gateway not answering (${openStatus ? `HTTP ${openStatus}` : 'unreachable'}): trying again in ${Math.round(waitMs / 1000)} s`);
          await sleep(waitMs);
        }
      }
    }
    if (!created) {
      setPanelState('error');
      setErrorMessage(
        openStatus === '401' || openStatus === '403'
          ? 'GATEWAY_REJECTED_TOKEN (401) - the access token in Settings must match the gateway\'s AEGIS_TOKEN'
          : openStatus
            ? `GATEWAY_SESSION_FAILED (HTTP ${openStatus})`
            : `GATEWAY_UNREACHABLE - is the gateway running at ${current.serverUrl}? (server/deploy/run-gateway.sh)`,
      );
      setGatewayMode('not connected');
      port.disconnect?.();
      return;
    }
    let gatewaySessionId = created.session_id;
    setGatewayMode(created.mode);
    note(useOwnKey ? `Model: ${created.model} on ${providerName} (your API key)` : `Gateway session opened at ${current.serverUrl} (${created.mode} model)`);

    // The panel's worker, usually loaded already (it starts when the panel opens). No `await` may
    // sit between the ContentPortClient's construction and `newSession`'s assignment below (a graph
    // arriving in between would reach an undefined session), so the wait happens here.
    const perception = ensurePerception(current);
    if (!perception.client.isReady()) note('Loading the local vision models (first run on this panel)');
    const ready = await perception.ready;
    if (ready) {
      note(
        `Local models on ${ready.backend}: ${ready.loaded.map((m) => `${ROLE_NAME[m.role] ?? m.role} (${m.provider})`).join(', ')}` +
          `${ready.failed.length > 0 ? `; failed: ${ready.failed.map((f) => f.role).join(', ')}` : ''}`,
      );
    } else {
      // Every step retries them (the client replaces the worker and re-initialises it); a step is
      // only sent with a redacted screenshot, so until they load the task waits rather than sends.
      note('Local vision models failed to start: retrying on every step (nothing is sent without a redacted screenshot)');
    }

    // The debug-only ablation switch (never in a release bundle; test/unit/ablation-build.spec.ts).
    const ablationArm: AblationArm | undefined = import.meta.env.DEV
      ? await (await import('../../src/debug/ablations')).currentAblationArm(browser.storage.local)
      : undefined;

    // Forward reference: ContentPortClient needs its handlers now, Session needs the constructed
    // ContentPortClient. No `await` follows until `newSession` is assigned.
    // eslint-disable-next-line prefer-const
    let newSession!: Session;
    // Messages from a port that is no longer the task's (a page AEGIS left, a superseded
    // connection) are ignored: they describe a document the session is not looking at.
    const wirePort = (hostPort: typeof port) =>
      new ContentPortClient(hostPort, {
        onGraph: (m) => hostPort === currentPort && newSession.onGraph(m),
        onActionResult: (m) => hostPort === currentPort && newSession.onActionResult(m.actionId, m.ok, m.reason, m.openUrl),
        onSettled: (m) => hostPort === currentPort && newSession.onSettled(m.actionId),
        onDisconnect: () => {
          void browser.runtime.lastError;
          if (hostPort === currentPort) newSession.onContentDisconnected();
        },
      });
    const contentPort = wirePort(port);

    // After an AEGIS action loads a new page in this tab, or opens one in a new tab: wait for it,
    // check the host permission WITHOUT prompting (a prompt needs a user gesture and would hang),
    // then attach. The attached tab becomes the task's target (every capture is of it).
    // `loadWaitMs`: how long to wait for the tab's load event first. Zero after a navigation in the
    // task's tab, which Session already waited for (`waitForPageReady`): waiting again cost up to
    // 2.5 s on every ad-heavy page, which fires its load event long after it is usable.
    const attachTab = async (tabId: number, what: string, loadWaitMs: number) => {
      const deadline = Date.now() + ATTACH_DEADLINE_MS;
      // A heavy page can take far longer than PAGE_LOAD_TIMEOUT_MS to fire its load event, yet it
      // is usable long before that: past the wait, connect anyway. The content script's own
      // `ready` is what says the page can be read.
      if (loadWaitMs > 0) {
        await sleep(150);
        await waitForTabComplete(tabId, loadWaitMs);
      }
      for (let attempt = 0; Date.now() < deadline && !taskAbort.signal.aborted; attempt++) {
        await sleep(attempt === 0 ? PAINT_MS : 1000);
        const next = await browser.tabs.get(tabId).catch(() => null);
        if (!next) {
          console.warn(`[aegis] ${what}; cannot attach`, { attempt, reason: 'tab-closed' });
          return null;
        }
        if (!next.url || !WEB_PAGE.test(next.url)) {
          // Mid-redirect a tab can briefly show no web URL; a settled one never becomes a web page.
          if (next.status === 'loading') continue;
          console.warn(`[aegis] ${what}; cannot attach`, { attempt, reason: 'not-a-web-page' });
          return null;
        }
        const nextOrigin = new URL(next.url).origin;
        if (!(await browser.permissions.contains({ origins: [`${nextOrigin}/*`] }))) {
          console.warn(`[aegis] ${what}; cannot attach`, { attempt, reason: 'no-host-permission', origin: nextOrigin });
          return null;
        }
        const reconnected = await connectToLiveContent(tabId, {
          connect: (id) => connectToTab(browser.tabs, id),
          inject: injectContentScript,
          lastErrorMessage: () => browser.runtime.lastError?.message,
        });
        if (!reconnected.ok) {
          console.warn(`[aegis] ${what}; cannot attach yet`, { attempt, reason: reconnected.reason, origin: nextOrigin });
          continue;
        }
        // The previous connection (a document that is gone, or a content script that stopped
        // answering) is closed so it cannot keep observing or sending.
        currentPort.disconnect?.();
        currentPort = reconnected.port;
        target.tabId = tabId;
        if (!taskTabs.includes(tabId)) taskTabs.push(tabId);
        target.origin = nextOrigin;
        console.info(`[aegis] ${what}; reconnected`, { tabId, origin: nextOrigin });
        note(`${what}: ${nextOrigin}`);
        return { contentPort: wirePort(reconnected.port), origin: nextOrigin, title: next.title ?? '' };
      }
      console.warn(`[aegis] ${what}; cannot attach`, { reason: 'deadline' });
      return null;
    };
    const reconnect = () => attachTab(target.tabId, 'page changed', 0);
    // Tabs opened FROM the task's tab (a target=_blank link, a shop's product page). Only an AEGIS
    // action consumes one (Session.observe after acting), and the task then continues in it.
    let openedTabId: number | null = null;
    const onTabCreated = (createdTab: { id?: number; openerTabId?: number }): void => {
      if (createdTab.id !== undefined && createdTab.openerTabId === target.tabId) openedTabId = createdTab.id;
    };
    browser.tabs.onCreated.addListener(onTabCreated);
    // The model's navigation ops, on the task's tab. Each waits only for the load to start: the
    // one wait for it to finish is Session's `waitForPageReady`, right after the step's actions.
    const runNavigation = async (trigger: () => Promise<unknown>) => {
      const started = waitForLoadStart(target.tabId, 3000);
      await trigger();
      await started;
    };
    const browserControl = {
      navigate: (url: string) => runNavigation(() => browser.tabs.update(target.tabId, { url })),
      openTab: async (url: string) => {
        // In the task tab's own window: Chrome refuses an opener in another window, and the panel's
        // "current window" is not always the page's (a detached panel, a harness run).
        const { windowId } = await browser.tabs.get(target.tabId);
        const opened = await browser.tabs.create({ url, openerTabId: target.tabId, windowId, active: true });
        if (opened.id !== undefined) openedTabId = opened.id;
      },
      goBack: () => runNavigation(() => browser.tabs.goBack(target.tabId)),
      goForward: () => runNavigation(() => browser.tabs.goForward(target.tabId)),
      reload: () => runNavigation(() => browser.tabs.reload(target.tabId)),
      waitForPageReady: async () => {
        await sleep(LOAD_START_GRACE_MS);
        await waitForTabComplete(target.tabId, PAGE_LOAD_TIMEOUT_MS);
        await sleep(PAINT_MS);
      },
      listTabs: async () => {
        const live: { title: string; current: boolean }[] = [];
        for (const id of [...taskTabs]) {
          const t = await browser.tabs.get(id).catch(() => null);
          if (!t) {
            taskTabs.splice(taskTabs.indexOf(id), 1);
            continue;
          }
          live.push({ title: t.title ?? '', current: id === target.tabId });
        }
        return live;
      },
      switchTab: async (index: number) => {
        const tabId = taskTabs[index - 1];
        if (tabId === undefined) return null;
        const exists = await browser.tabs.update(tabId, { active: true }).then(
          () => true,
          () => false,
        );
        if (!exists) return null;
        return attachTab(tabId, 'switched to tab', PAGE_LOAD_TIMEOUT_MS);
      },
      closeTab: async (index: number) => {
        const tabId = taskTabs[index - 1];
        if (tabId === undefined || tabId === target.tabId) return false;
        await browser.tabs.remove(tabId).catch(() => undefined);
        taskTabs.splice(taskTabs.indexOf(tabId), 1);
        return true;
      },
    };
    const followOpenedTab = async () => {
      const tabId = openedTabId;
      openedTabId = null;
      if (tabId === null) return null;
      return attachTab(tabId, 'the action opened a new tab', PAGE_LOAD_TIMEOUT_MS);
    };
    // The screenshot can only be taken of the front tab: if the user is on another tab, the task
    // pauses (never pulls its tab to the front behind the user's back) and resumes when they return.
    const captureWhenVisible = async (): Promise<CaptureResult> => {
      const visibleNow = await browser.tabs.get(target.tabId).then((t) => t.active, () => false);
      if (!visibleNow) {
        setUserWait('Paused: AEGIS can only see the task\'s tab while it is in front. Switch back to that tab and it continues by itself.');
        const visible = await waitForTabVisible(target.tabId, taskAbort.signal);
        setUserWait(null);
        if (!visible) return { ok: false, reason: 'not-visible' };
        await sleep(250);
      }
      return captureTabAsBitmap(target);
    };

    newSession = new Session({
      contentPort,
      sendToGateway: (payload, signal) => {
        lastStepId = payload.step_id;
        return gateway.sendStep(gatewaySessionId, payload, signal);
      },
      pageQueries: true,
      reopenSession: async () => {
        const reopened = await gateway.openSession();
        gatewaySessionId = reopened.session_id;
        note('Model session re-opened');
      },
      askUser: (question) =>
        new Promise<string | null>((resolve) => {
          setQuestionRequest({ question, resolve });
          setPanelState('awaiting-user');
        }),
      guardOrigin: origin,
      pageCategory: 'unknown',
      pageTitle: tab.title ?? '',
      onEvent: (event) => handleSessionEvent(event, newSession),
      confirm: (risk, description) =>
        new Promise<boolean>((resolve) => {
          setConfirmRequest({ risk, description, resolve });
        }),
      perception: {
        client: perception.client,
        capture: createGatedCapture({
          capture: captureWhenVisible,
          readInvocation: () => readInvocation(browser.storage.session, target.tabId),
          currentOrigin: () => browser.tabs.get(target.tabId).then((t) => originOf(t.url), () => null),
          onInvoked: (cb) => {
            const listener = (message: unknown): undefined => {
              if (isActionInvokedMessage(message) && message.tabId === target.tabId) cb();
            };
            browser.runtime.onMessage.addListener(listener);
            return () => browser.runtime.onMessage.removeListener(listener);
          },
          prompt: (explanation, settle) => {
            setGrantRequest({ explanation, settle });
            setPanelState('awaiting-grant');
            return () => {
              setGrantRequest(null);
              setPanelState((state) => (state === 'awaiting-grant' ? 'running' : state));
            };
          },
          now: () => Date.now(),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        }),
      },
      promptProfile: PROVIDERS[current.provider].profile,
      // NER runs only where its model exists (profile L, development builds).
      ner: !RELEASE && current.nerProfile === 'L',
      canaries,
      reconnect,
      followOpenedTab,
      browser: browserControl,
      ablation: ablationArm,
      policy: applyAlwaysRedact(defaultPolicy, current.alwaysRedact),
      resume: resume ? { history: resume.history, stepsDone: stepsStarted(resume.log) } : undefined,
    });

    // Site access removed while the task runs (chrome://extensions, or the browser's own menu):
    // the task stops instead of failing step after step.
    let revocationActive = true;
    listenForPermissionRevocation(
      { addMessageListener: (cb) => browser.runtime.onMessage.addListener((m: unknown) => void (revocationActive && cb(m))) },
      () => (permissions.allSites ? null : target.origin),
      () => newSession.abort('PAGE_DISCONNECTED', 'site access was removed'),
    );

    sessionRef.current = newSession;
    setSession(newSession);
    setResumable(null);
    setPanelState('running');
    note('Task started');
    try {
      await newSession.start(task);
    } catch (err) {
      console.error('[aegis] task failed', err);
      setPanelState('error');
      setErrorMessage('INTERNAL_ERROR - see the panel console');
    } finally {
      // Ends the content script's per-connection session (observers included), the model session
      // and this task's state in the worker; the worker itself (and its models) stays loaded.
      revocationActive = false;
      taskAbort.abort();
      if (taskAbortRef.current === taskAbort) taskAbortRef.current = null;
      browser.tabs.onCreated.removeListener(onTabCreated);
      currentPort.disconnect?.();
      await gateway.closeSession(gatewaySessionId).catch(() => undefined);
      perception.client.reset();
      setUserWait(null);
    }
  }

  function handleStop(): void {
    // Every card that is waiting on the user is settled first, so the task's own waits unwind and
    // nothing queued behind a card can still act on the page.
    grantRef.current?.settle('cancelled');
    confirmRef.current?.resolve(false);
    questionRef.current?.resolve(null);
    setGrantRequest(null);
    setConfirmRequest(null);
    setQuestionRequest(null);
    setUserWait(null);
    taskAbortRef.current?.abort();
    sessionRef.current?.cancel();
  }

  /** Continues a cut-off task on its own tab, or on the active tab if that one was closed. */
  async function handleResume(): Promise<void> {
    const saved = resumable;
    if (!saved) return;
    const tabAlive = saved.tabId >= 0 && (await browser.tabs.get(saved.tabId).then(() => true, () => false));
    await handleStart(saved.task, undefined, tabAlive ? saved.tabId : undefined, saved);
  }

  function handleDismissSaved(): void {
    pendingSaveRef.current = null;
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    browser.windows
      .getCurrent()
      .then((win) => (win.id === undefined ? undefined : forgetTask(browser.storage.session, win.id)))
      .catch(() => undefined);
    setResumable(null);
    setCurrentTask(null);
    setRunLog(EMPTY_RUN_LOG);
    setSteps([]);
    setLastPayload(null);
    setProtectedFields([]);
    setErrorMessage(null);
    setPanelState('idle');
  }

  function handleAnswer(answer: string | null): void {
    questionRequest?.resolve(answer);
    setQuestionRequest(null);
    setPanelState('running');
  }

  function handleConfirmDecision(allowed: boolean): void {
    confirmRequest?.resolve(allowed);
    setConfirmRequest(null);
    setPanelState('running');
  }

  // Installed once — `handleStart` reads everything that changes through refs.
  useEffect(() => {
    window.__aegisRunTask = handleStart;
    window.__aegisLedgerExport = () => sessionRef.current?.getLedger().export() ?? [];
    return () => {
      delete window.__aegisRunTask;
      delete window.__aegisLedgerExport;
    };
  }, []);

  function updateSettings(next: SettingsValue): void {
    settingsRef.current = next;
    setSettings(next);
    void saveSettings(browser.storage.local, next);
  }

  /** The key (and the model "Test key" picked for it) is stored as soon as it is saved. */
  function saveApiKey(provider: ProviderId, apiKey: string, model?: string): void {
    const base = settingsRef.current;
    const apiKeys = { ...base.apiKeys };
    if (apiKey) apiKeys[provider] = apiKey;
    else delete apiKeys[provider];
    updateSettings({ ...base, provider, apiKeys, models: model ? { ...base.models, [provider]: model } : base.models });
  }

  function testApiKey(provider: ProviderId, apiKey: string) {
    return verifyApiKey(resolveModelConfig({ ...settingsRef.current, provider }, RELEASE, apiKey));
  }

  function changeProvider(provider: ProviderId): void {
    updateSettings({ ...settingsRef.current, provider });
  }

  if (settingsOpen) {
    return (
      <div style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}>
        <Settings
          value={settings}
          entityTypes={SETTINGS_ENTITY_TYPES}
          release={RELEASE}
          onSaveKey={saveApiKey}
          onTestKey={testApiKey}
          onProviderChange={changeProvider}
          onSave={(next) => {
            // Keys and the provider are saved the moment they change; never overwrite them with
            // the form's copy.
            const { provider, apiKeys } = settingsRef.current;
            updateSettings({ ...next, provider, apiKeys });
            setSettingsOpen(false);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      </div>
    );
  }

  const isRunning =
    panelState === 'running' ||
    panelState === 'loading' ||
    panelState === 'awaiting-grant' ||
    panelState === 'awaiting-user' ||
    panelState === 'awaiting-confirmation';

  const statusDotColor =
    panelState === 'error' || panelState === 'no-permission' || panelState === 'blocked' ? C.error
    : panelState === 'done' ? C.ok
    : panelState === 'awaiting-confirmation' || panelState === 'awaiting-grant' || panelState === 'awaiting-user' || panelState === 'interrupted' ? C.warn
    : isRunning ? C.accent
    : C.muted;

  const statusBgColor =
    statusDotColor === C.error ? C.errorBg
    : statusDotColor === C.ok ? C.okBg
    : statusDotColor === C.warn ? C.warnBg
    : isRunning ? C.infoBg
    : '#f1f3f5';

  const keySaved = activeApiKey(settings) !== '';
  const needsKey = RELEASE && !keySaved;
  const providerPreset = PROVIDERS[settings.provider];
  const configuredModel = resolveModelConfig(settings, RELEASE).model;
  const modelName = providerPreset.models.find((m) => m.id === configuredModel)?.label.replace(/ \(.*\)$/, '') ?? configuredModel;
  const hasRun = runLog.setup.length > 0 || runLog.steps.length > 0 || runLog.result !== undefined;
  const latestStep = runLog.steps.at(-1);

  return (
    <div
      style={{
        fontSize: T.base,
        background: C.bg,
        minHeight: '100vh',
        color: C.strong,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '10px 14px',
          background: C.surface,
          borderBottom: `1px solid ${C.border}`,
          position: 'sticky',
          top: 0,
          zIndex: 10,
        }}
      >
        {/* No name or logo: the browser's own side-panel bar above already shows them. */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexDirection: 'row-reverse', flex: 1 }}>
          {/* The state pill is the header's last line of text: the e2e harness reads it there. */}
          <button
            class="ag-ghost"
            onClick={() => setSettingsOpen(true)}
            aria-label="Settings"
            title="Settings"
            style={{
              background: C.surface,
              border: `1px solid ${C.border}`,
              borderRadius: R.md,
              width: 30,
              height: 30,
              cursor: 'pointer',
              color: C.secondary,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
            }}
          >
            <IconGear size={15} />
          </button>
          <span
            data-testid="panel-state"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '3px 9px',
              borderRadius: 100,
              fontSize: T.xs,
              fontWeight: 600,
              color: statusDotColor,
              background: statusBgColor,
              whiteSpace: 'nowrap',
            }}
          >
            <span class={isRunning ? 'ag-pulse' : undefined} style={S.dot(statusDotColor)} />
            {panelStateLabel(panelState)}
          </span>
        </div>
      </header>

      {/* Connection and on-device status */}
      <div style={{ padding: '7px 14px 8px', background: C.surface, borderBottom: `1px solid ${C.border}` }}>
        <MetricsBar backend={gatewayMode} steps={steps} model={keySaved || RELEASE ? { name: modelName, keySaved } : undefined} />
        <ResourceBar backend={perceptionBackend} modelsLoadedMB={modelsLoadedMB} detail={backendDetail} />
      </div>

      <main style={{ padding: '2px 14px 16px', flex: 1 }}>
        {/* Bring your own key: nothing runs until one is saved (a release build has no other model). */}
        {RELEASE && (!keySaved || keyJustSaved) && (
          <div style={{ marginTop: 12 }}>
            <ApiKeyCard
              provider={settings.provider}
              onProviderChange={changeProvider}
              savedKey={activeApiKey(settings)}
              onSave={(key) => {
                saveApiKey(settingsRef.current.provider, key, pickedModel.current);
                setKeyJustSaved(true);
                setTimeout(() => setKeyJustSaved(false), 6000);
              }}
              onRemove={() => saveApiKey(settingsRef.current.provider, '')}
              onTest={async (key) => {
                const check = await testApiKey(settingsRef.current.provider, key);
                pickedModel.current = check.ok ? check.model : undefined;
                return check;
              }}
            />
          </div>
        )}

        <TaskInput running={isRunning} disabled={needsKey} onStart={handleStart} onStop={handleStop} value={draft} onValueChange={changeDraft} />

        {/* What AEGIS does, until the first task is run */}
        {!hasRun && !needsKey && panelState !== 'error' && (
          <ol style={{ listStyle: 'none', margin: '4px 0 0', padding: '2px 2px', display: 'flex', flexDirection: 'column', gap: 7, fontSize: T.xs, color: C.secondary }}>
            {[
              'AEGIS reads this page and its screenshot on your device.',
              'Private details (IDs, faces, card numbers, passwords) are hidden before anything leaves the browser.',
              'The model sees only the redacted view and tells AEGIS what to do; AEGIS acts on the page for you.',
            ].map((line, i) => (
              <li key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <span style={{ width: 16, height: 16, borderRadius: '50%', border: `1px solid ${C.borderMid}`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: C.body, flexShrink: 0 }}>{i + 1}</span>
                <span>{line}</span>
              </li>
            ))}
          </ol>
        )}

        {panelState === 'no-permission' && (
          <Notice tone="error" title="AEGIS needs access to this site">
            Allow site access when Chrome asks, then press Run again.
          </Notice>
        )}

        {resumable && !isRunning && (
          <Notice tone="warn" title="Task interrupted" testId="task-interrupted">
            The AEGIS panel was closed while this task was running, which stopped it. Resume continues it on its tab from where it left off.
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button style={{ ...S.btnPrimary, fontSize: T.xs, padding: '5px 12px' }} onClick={() => void handleResume()} disabled={needsKey}>
                Resume
              </button>
              <button style={{ ...S.btnSecondary, fontSize: T.xs, padding: '5px 12px' }} onClick={handleDismissSaved}>
                Dismiss
              </button>
            </div>
          </Notice>
        )}

        {/* A stop that ended a task is explained in the result card instead. */}
        {panelState === 'error' && errorMessage && !runLog.result && <ErrorNotice message={errorMessage} />}

        {/* Requests that need the user, first: the task is waiting on them */}
        {grantRequest && (
          <GrantRequest
            explanation={grantRequest.explanation}
            onAllowAllSites={() => {
              void browser.permissions.request({ origins: ['<all_urls>'] }).then(
                (granted) => granted && grantRequest.settle('retry'),
                () => undefined,
              );
            }}
            onStop={handleStop}
          />
        )}

        {confirmRequest && <ConfirmAction risk={confirmRequest.risk} description={confirmRequest.description} onDecide={handleConfirmDecision} />}

        {questionRequest && <AskUser question={questionRequest.question} onAnswer={handleAnswer} />}

        {userWait && (
          <Notice tone="warn" title="Paused" testId="user-wait">
            {userWait}
          </Notice>
        )}

        {guardBlock && (
          <GuardBlockCard
            rule={guardBlock.rule}
            entity={guardBlock.entity}
            count={1}
            onRetry={() => setGuardBlock(null)}
            onStop={() => {
              setGuardBlock(null);
              handleStop();
            }}
          />
        )}

        {currentTask && (isRunning || runLog.steps.length > 0 || runLog.result) && (
          <TaskProgress task={currentTask.text} startedAt={currentTask.startedAt} panelState={panelState} log={runLog} />
        )}

        <ResultCard log={runLog} stopMessage={errorMessage} />

        <PrivacyCard payload={lastPayload} protectedFields={protectedFields} latest={latestStep} onUnredact={(ref, reason) => session?.unredact(ref, reason)} />

        <RunLogView log={runLog} running={isRunning} showRawPayload={settings.showRawPayload} loadFailures={modelLoadFailures} workerProblems={workerProblems} />

        {/* Developer timeline (when enabled in settings) */}
        {settings.debugOverlay && <StepTimeline steps={steps} />}
      </main>
    </div>
  );
}

render(<App />, document.getElementById('root')!);
