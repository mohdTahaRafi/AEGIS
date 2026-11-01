# R-5 — Keep the task alive across page navigation (+ silent-stop fixes)

**Priority:** P0 · **Depends on:** R-3 (full snapshots, host-owned `reason`) · **Unblocks:** R-6
**Bugs fixed:** A6, A7, A8, A16, A18 (new), A19 (new) · **Parent list:** [tasks.md](tasks.md)

`ext/` = `apps/extension/`. Paths are relative to `AEGIS/`.

## Goal

A click that loads a new document (form submit, redirect, link) no longer ends the task. The
session waits for the new page, reconnects the content script, re-observes, and continues. If the
new page is on another origin, the panel asks for access in a user click. Values minted on the old
origin can never be typed into the new one.

Every other way a step can end also produces a visible, correct state.

## New bugs found while writing this step

| # | Bug | Where |
|---|---|---|
| A18 | Declining a risky-action confirmation makes `actOnPlan` return `'stopped'`, and `stepLoop` returns. No `stopped` event is emitted and the controller stays in `ACTING`, so the panel shows "running" forever. Same shape as A6. | `ext/src/host/session.ts:669-674` |
| A19 | `ReconciliationTracker.resetForNewStep()` is never called. The re-observation budget (3) is spent across the **whole task**, not per step. Once A6 is fixed (failed actions re-observe), the fourth failed action in a long task stops with `BUDGET_EXHAUSTED` even when every step made progress. | `ext/src/host/controller/reconcile.ts`, `session.ts` |

## Today (verified)

- `session.ts:onContentDisconnected` rejects every pending wait with `PageDisconnectedError`.
  `start()` catches it and stops with `PAGE_DISCONNECTED`.
- `content/port.ts:handleDispatch`:
  1. posts `action-result ok:true` right after dispatching;
  2. `waitForSettle`;
  3. posts `settled`;
  4. on `'navigated'` (pagehide) returns **without** a graph. Otherwise it sends
     `graph (after_action)`.

  A navigating click therefore gives: `action-result`, maybe `settled`, then the port disconnects.
- `host/content-connection.ts:connectToLiveContent(tabId, deps)` already does connect → wait for
  `ready` → inject → retry, and returns `{ ok, port } | { ok: false, reason: 'inject-failed' | 'no-ready' }`.
- `session.ts` uses `this.deps.contentPort`, `this.deps.guardOrigin` and `this.deps.pageTitle`.
  All three are fixed at construction.
- `main.tsx:310` builds `const target: CaptureTarget = { tabId, origin }`. `capture-tab.ts:blocker`
  refuses to capture when the tab's origin ≠ `target.origin` (`'origin-changed'`), and the grant
  gate never prompts for that reason (it isn't in `GRANT_FIXABLE`).
- Controller table (`controller/machine.ts`): `ACTING → acted → SETTLING → settled → OBSERVING`.
  There is no `ACTING → OBSERVING` edge, so a failed action must go through `acted`/`settled`.
- `actOnPlan` problems:
  - it pushes a history entry with `step_id: ''` on a refused rehydration (A7);
  - `op: 'stop'` emits `stopped: CANCELLED` (A8);
  - a failed dispatch or refusal returns `'stopped'` with no event (A6).
- `SanitizedContext.reason` enum: `initial | after_action | requested | reconcile`
  (`packages/protocol/schema/sanitized-context.schema.json:13`).
- Release manifests hold `optional_host_permissions: ['<all_urls>']`; dev builds make it required
  (`wxt.config.ts:30-51`). The declared content script injects automatically only on origins the
  extension holds host access to.

## Decisions (fixed)

- **When is a disconnect a navigation?** When at least one action was dispatched since the last
  graph arrived (`actionsSinceGraph > 0`) and a `reconnect` dependency exists. Any other
  disconnect stops with `PAGE_DISCONNECTED`, as today.
- **Actions after a navigating one in the same plan are skipped.** Their node ids belong to the old
  page. A `done` later in the plan still completes the task.
- **Wait for the new page** with `tabs.onUpdated` `status: 'complete'` on the task tab, timeout
  **15 000 ms**. `tabs.onRemoved` for the tab ends the wait at once (tab closed).
- **Cross-origin access.** If the content script can't be connected on the new origin, show a card
  "The page moved to `<origin>`. Allow AEGIS on this site to continue." with **Allow** (calls
  `permissions.request` inside the click, a real user gesture) and **Stop**. A toolbar click on the
  tab (grants `activeTab`) also resolves it. There is no timeout; the user decides.
- **Origin binding.** After reconnecting, the session's origin key, the page title and
  `CaptureTarget.origin` all become the new page's. The vault is **not** cleared: refs from the old
  origin stay sealed and are refused on the new origin by the existing strict rule (`ORIGIN_MISMATCH`).
- **`reason: 'navigation'`** is added to the protocol enum and sent on the first step after a
  reconnect. The previous step's history outcome becomes `'navigated'`.
- **Stop reasons.**
  - `op: 'stop'` from the model → `stopped: MODEL_STOPPED`, controller `STOPPED`.
  - A declined confirmation → the same as the user pressing Stop: `session.cancel()` →
    `stopped: CANCELLED`.
  - A failed action or refused rehydration → re-observe with `reason: 'reconcile'`, unless the
    reconcile budget says stop → `this.stop('BUDGET_EXHAUSTED')`.
- **The reconcile budget is per step**: `resetForNewStep()` runs at the start of every step.

## Implementation

### 1. Protocol — add `navigation`

- `packages/protocol/schema/sanitized-context.schema.json` line 13:
  `"reason": { "enum": ["initial", "after_action", "requested", "reconcile", "navigation"] },`
- Regenerate: `pnpm --filter @aegis/protocol generate`. This updates the TS types/validators and
  `server/gateway/src/aegis_gateway/protocol/sanitized_context.py` (`Reason.navigation`). Never
  hand-edit generated files.
- `pnpm --filter @aegis/protocol test`: the contract round-trip must stay green. Add
  `test/contract/samples/valid/sanitized-context-navigation.json` (a copy of the valid sample with
  `"reason": "navigation"`, `"delta_of": null`) and list it in `samples/manifest.json` the same way
  the existing valid sample is listed.

### 2. `ext/src/host/navigation/reconnect.ts` (new)

```ts
// Reconnects a task to its tab after the page navigated: waits for the new document to finish
// loading, connects (or injects) the content script, and — if the extension has no access to the
// new origin — asks the user through `requestAccess`, which must resolve only on a user action.

import { originOf } from '../../shared/invocation';
import type { ContentConnectResult } from '../content-connection';
import type { HostPort } from '../port';

export const NAVIGATION_LOAD_TIMEOUT_MS = 15_000;

export interface ReconnectDeps {
  tabId: number;
  /** Resolves true when the tab reports status 'complete', false on timeout or tab removal. */
  waitForComplete(tabId: number, timeoutMs: number): Promise<boolean>;
  currentTab(tabId: number): Promise<{ url?: string; title?: string } | null>;
  connect(tabId: number): Promise<ContentConnectResult>;
  requestAccess(origin: string): Promise<'granted' | 'cancelled'>;
}

export type ReconnectResult =
  | { ok: true; port: HostPort; origin: string; title: string }
  | { ok: false; reason: 'load-timeout' | 'tab-closed' | 'no-origin' | 'access-cancelled' | 'no-content' };

export async function reconnectAfterNavigation(deps: ReconnectDeps): Promise<ReconnectResult> {
  if (!(await deps.waitForComplete(deps.tabId, NAVIGATION_LOAD_TIMEOUT_MS))) return { ok: false, reason: 'load-timeout' };
  const tab = await deps.currentTab(deps.tabId);
  if (!tab) return { ok: false, reason: 'tab-closed' };
  const origin = originOf(tab.url);
  if (!origin) return { ok: false, reason: 'no-origin' };
  let connection = await deps.connect(deps.tabId);
  if (!connection.ok) {
    if ((await deps.requestAccess(origin)) !== 'granted') return { ok: false, reason: 'access-cancelled' };
    connection = await deps.connect(deps.tabId);
    if (!connection.ok) return { ok: false, reason: 'no-content' };
  }
  return { ok: true, port: connection.port, origin, title: tab.title ?? '' };
}
```

### 3. `ext/src/host/session.ts`

**3a. New deps and events.** Add to `SessionDeps`:

```ts
  /** Reconnects after the page navigated (see host/navigation/reconnect.ts). Absent means a
   * disconnect always stops the task, the pre-R-5 behaviour. Resolves null when it can't. */
  reconnect?: () => Promise<{ contentPort: ContentPortClient; origin: string; title: string } | null>;
```

In `SessionEvent`, change the `stopped` reason union to
`BudgetReasonCode | 'BLOCKED' | 'SERVER_ERROR' | 'CANCELLED' | 'PAGE_DISCONNECTED' | 'MODEL_STOPPED'`,
and add `| { type: 'navigated'; origin: string }` (the panel shows it in the step timeline).

In `StepRecord.outcome`, add `'failed' | 'navigated'`.

**3b. Mutable page state.** Add fields and initialise them in the constructor:

```ts
  private contentPort: ContentPortClient;
  private originKey: string;
  private pageTitle: string;
  private navigationPending = false;
  private actionsSinceGraph = 0;
  ...
  constructor(private readonly deps: SessionDeps) {
    ...
    this.contentPort = deps.contentPort;
    this.originKey = deps.guardOrigin;
    this.pageTitle = deps.pageTitle;
  }
```

Replace every use:
- `this.deps.contentPort` → `this.contentPort` (in `requestGraph` and `dispatchAndAwait`);
- `this.deps.guardOrigin` → `this.originKey` (`buildSanitizedContext`'s `originKey` and
  `resolveRehydration`'s `originKey`);
- `this.deps.pageTitle` → `this.pageTitle` (`collectFreeTextSources` and `buildSanitizedContext`).

`allSeenNodes` must not be `readonly`; R-3 already requires this.

**3c. Counters.** In `dispatchAndAwait`, add `this.actionsSinceGraph += 1;` before
`this.contentPort.dispatchAction(...)`. Reset it to `0` only in `observe()` (3e), right after
`requestGraph()` resolves. **Don't reset it in `onGraph`.** A submit click often mutates the page
before it unloads (a button disables, a spinner appears), and the content script auto-sends that
graph. Resetting there would make the following unload look like an unexplained disconnect.

**3d. Disconnect handling.** Add the error class next to `PageDisconnectedError`:

```ts
class NavigationPendingError extends Error {
  constructor() {
    super('NAVIGATION_PENDING');
    this.name = 'NavigationPendingError';
  }
}
```

Replace `onContentDisconnected`:

```ts
  onContentDisconnected(): void {
    if (this.pageDisconnected || this.navigationPending) return;
    if (this.actionsSinceGraph > 0 && this.deps.reconnect && !this.isFinished()) {
      this.navigationPending = true;
      // The click that navigated never gets its action-result on the old document; it succeeded.
      for (const pending of this.pendingActions.values()) pending.resolveOk(true);
      this.pendingActions.clear();
      this.pendingGraph?.reject(new NavigationPendingError());
      this.pendingGraph = null;
      return;
    }
    this.pageDisconnected = true;
    const err = new PageDisconnectedError();
    this.pendingGraph?.reject(err);
    this.pendingGraph = null;
    for (const pending of this.pendingActions.values()) pending.reject(err);
    this.pendingActions.clear();
  }
```

In `requestGraph`, add as the first line:
`if (this.navigationPending) return Promise.reject(new NavigationPendingError());`.

**3e. Reconnect.**

```ts
  /** True when the session is on the new page and ready to observe it. */
  private async reconnectAfterNavigation(): Promise<boolean> {
    const next = this.deps.reconnect ? await this.deps.reconnect() : null;
    if (this.isFinished()) return false;
    if (!next) {
      this.stop('PAGE_DISCONNECTED');
      return false;
    }
    this.contentPort = next.contentPort;
    this.originKey = next.origin;
    this.pageTitle = next.title;
    this.allSeenNodes = new Map();
    this.lastGraphMessage = null;
    this.digestGuard.reset();
    this.actionsSinceGraph = 0;
    this.navigationPending = false;
    const last = this.history[this.history.length - 1];
    if (last) last.outcome = 'navigated';
    this.deps.onEvent({ type: 'navigated', origin: next.origin });
    return true;
  }

  /** Requests a graph, reconnecting once if the page navigated. Null means the session stopped. */
  private async observe(): Promise<{ graph: GraphMessage; navigated: boolean } | null> {
    let navigated = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.navigationPending) {
        if (!(await this.reconnectAfterNavigation())) return null;
        navigated = true;
      }
      try {
        const graph = await this.requestGraph();
        this.actionsSinceGraph = 0;
        return { graph, navigated };
      } catch (err) {
        if (!(err instanceof NavigationPendingError)) throw err;
      }
    }
    this.stop('PAGE_DISCONNECTED');
    return null;
  }
```

The origin is only an internal key, never sent (design.md §3.4). `next.origin` doesn't go into any
event other than `navigated`, which only the panel sees.

**3f. `stepLoop` changes** (on top of R-3's version):
- After the budget checks at the top of the iteration, add `this.reconcile.resetForNewStep();`
  (A19).
- Replace `const graphMessage = await this.requestGraph();` with:

```ts
      const observed = await this.observe();
      if (!observed) return;
      const graphMessage = observed.graph;
      if (observed.navigated) stepReason = 'navigation';
```

- The actions loop result: `const outcome = await this.actOnPlan(validated.plan, stepId);` (new
  second argument).
- After the `history.push` and the `step` event:

```ts
      if (outcome === 'done') { … unchanged … }
      if (outcome === 'stopped') return;
      this.controller.send({ type: 'acted' });
      this.controller.send({ type: 'settled' });
      this.emitState();
      stepReason = outcome === 'failed' ? 'reconcile' : 'after_action';
```

  If the page navigated during this step, the next iteration's `observe()` reconnects and
  overrides the reason with `'navigation'`.

**3g. `actOnPlan(plan, stepId)`**. Return type `'acted' | 'done' | 'stopped' | 'failed'`:

```ts
  private async actOnPlan(plan: ActionPlan, stepId: string): Promise<'acted' | 'done' | 'stopped' | 'failed'> {
    this.reconcile.resetForNewAction();
    for (const action of plan.actions) {
      if (action.op === 'done') {
        this.deps.onEvent({ type: 'done', summary: action.summary });
        return 'done';
      }
      if (this.navigationPending) return 'acted';            // later actions target the old page
      if (action.op === 'stop') {
        this.controller.send({ type: 'stop' });
        this.vault.clear();
        this.emitState();
        this.deps.onEvent({ type: 'stopped', reason: 'MODEL_STOPPED' });
        return 'stopped';
      }

      const classified = classifyAction(action);
      if (classified.kind === 'host') { … unchanged … continue; }

      if (classified.kind === 'rehydrate') {
        const resolved = await this.resolveAndDispatchRehydration(classified);
        if (!resolved.ok) {
          this.deps.onEvent({ type: 'rehydration_rejected', code: resolved.code });
          this.history.push({ step_id: stepId, actions: [{ op: 'type' }], outcome: `REHYDRATE_${resolved.code}` });
          return this.afterFailedAction();
        }
        continue;
      }

      const level = classifyRisk(classified.action, {});
      if (requiresConfirmation(level)) {
        const description = `${classified.action.op} on ${'node' in classified.action ? classified.action.node : 'the page'}`;
        this.deps.onEvent({ type: 'confirmation_required', risk: level, description });
        const approved = this.deps.confirm ? await this.deps.confirm(level, description) : true;
        if (!approved) {
          this.cancel();
          return 'stopped';
        }
      }

      const actionId = `a-${Math.random().toString(36).slice(2)}`;
      const result = await this.dispatchAndAwait(actionId, classified.action);
      if (!result.ok) return this.afterFailedAction();
    }
    return 'acted';
  }

  private afterFailedAction(): 'failed' | 'stopped' {
    const decision = this.reconcile.decide(false);
    if (decision.action === 'stop') {
      this.stop(decision.reason);
      return 'stopped';
    }
    return 'failed';
  }
```

Notes:
- The rehydration path records the refusal code in its own history entry (with a valid `step_id`)
  and the step's entry follows it. Both are ≤ 200 chars.
- `done` is checked before the `navigationPending` skip, so `[click submit, done]` finishes the
  task even though the click navigated.
- The old comment in the file header about "Phase 2 simplification … goes straight to
  re-observation" now matches the code; keep it.

**3h. `start()`**: unchanged. A `PageDisconnectedError` still becomes `PAGE_DISCONNECTED`, and
`NavigationPendingError` never escapes `observe()`.

### 4. `ext/entrypoints/sidepanel/main.tsx`

1. Make the port handlers reusable and the port replaceable. Replace the `contentPort`
   construction (lines ~384-391):

```ts
    const portHandlers: ContentPortHandlers = {
      onGraph: (m) => newSession.onGraph(m),
      onActionResult: (m) => newSession.onActionResult(m.actionId, m.ok, m.reason),
      onDisconnect: () => {
        void browser.runtime.lastError;
        newSession.onContentDisconnected();
      },
    };
    let currentPort = port;
    const contentPort = new ContentPortClient(port, portHandlers);
```

   Import `type ContentPortHandlers` from `../../src/host/port`. At the end of `handleStart`,
   replace `port.disconnect?.();` with `currentPort.disconnect?.();`.

2. Add a helper at module level:

```ts
function waitForTabComplete(tabId: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.tabs.onRemoved.removeListener(onRemoved);
      resolve(value);
    };
    const onUpdated = (id: number, info: { status?: string }): void => {
      if (id === tabId && info.status === 'complete') finish(true);
    };
    const onRemoved = (id: number): void => {
      if (id === tabId) finish(false);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.onRemoved.addListener(onRemoved);
    browser.tabs.get(tabId).then((t) => { if (t.status === 'complete') finish(true); }, () => finish(false));
  });
}
```

3. New state for the access card, next to `grantRequest`:
   `const [accessRequest, setAccessRequest] = useState<{ origin: string; settle: (o: 'granted' | 'cancelled') => void } | null>(null);`
   and a ref for the failure reason:
   `const reconnectFailureRef = useRef<string | null>(null);`. Reset it to `null` at the start of
   `handleStart`.

4. Pass `reconnect` in `new Session({...})`:

```ts
      reconnect: async () => {
        const result = await reconnectAfterNavigation({
          tabId: target.tabId,
          waitForComplete: waitForTabComplete,
          currentTab: (id) => browser.tabs.get(id).then((t) => ({ url: t.url, title: t.title }), () => null),
          connect: (id) =>
            connectToLiveContent(id, {
              connect: (tabId) => connectToTab(browser.tabs, tabId),
              inject: injectContentScript,
              lastErrorMessage: () => browser.runtime.lastError?.message,
            }),
          requestAccess: (origin) =>
            new Promise((resolve) => {
              const listener = (message: unknown): undefined => {
                if (isActionInvokedMessage(message) && message.tabId === target.tabId) done('granted');
              };
              const done = (outcome: 'granted' | 'cancelled'): void => {
                browser.runtime.onMessage.removeListener(listener);
                setAccessRequest(null);
                setPanelState((s) => (s === 'awaiting-grant' ? 'running' : s));
                resolve(outcome);
              };
              browser.runtime.onMessage.addListener(listener);
              setAccessRequest({ origin, settle: done });
              setPanelState('awaiting-grant');
            }),
        });
        if (!result.ok) {
          reconnectFailureRef.current = result.reason;
          return null;
        }
        target.origin = result.origin;
        currentPort = result.port;
        return { contentPort: new ContentPortClient(result.port, portHandlers), origin: result.origin, title: result.title };
      },
```

   Import `reconnectAfterNavigation` from `../../src/host/navigation/reconnect`.
   `target` is a `const` object; its fields are mutable (`CaptureTarget` has no `readonly`), and
   `captureTabAsBitmap(target)` reads `target.origin` at call time.

5. Render the card below `GrantRequest`:

```tsx
        {accessRequest && (
          <NavigationAccess
            origin={accessRequest.origin}
            onAllow={async () => {
              const state = await ensureHostPermission(browser.permissions, accessRequest.origin);
              accessRequest.settle(state === 'denied' ? 'cancelled' : 'granted');
            }}
            onStop={() => {
              accessRequest.settle('cancelled');
              handleStop();
            }}
          />
        )}
```

   `ensureHostPermission` is called directly in the click handler, so `permissions.request` runs
   inside the user gesture.

6. In `handleSessionEvent`:
   - `stopped` with reason `PAGE_DISCONNECTED` and `reconnectFailureRef.current` set:
     `setErrorMessage(\`PAGE_DISCONNECTED (${reconnectFailureRef.current})\`)`.
   - `stopped` with reason `MODEL_STOPPED`: `setPanelState('error')` with the message
     "The model stopped the task (it could not continue safely or was blocked)."
   - `navigated`: no state change. The step timeline shows it through the `step` event's
     `navigated` outcome.

   `handleStop` must also call `accessRequest?.settle('cancelled')`.

### 5. `ext/src/ui/NavigationAccess.tsx` (new)

```tsx
// Shown when the task's page moved to an origin AEGIS has no access to. Nothing has been sent for
// the new page yet. Resolves only by the user's click (Allow runs permissions.request inside it)
// or a toolbar click on the tab.

export interface NavigationAccessProps {
  origin: string;
  onAllow: () => void;
  onStop: () => void;
}

export function NavigationAccess({ origin, onAllow, onStop }: NavigationAccessProps) {
  return (
    <div role="alertdialog" data-testid="navigation-access" style={{ border: '2px solid #2563eb', borderRadius: 6, padding: 10, margin: '8px 0', background: '#eff6ff' }}>
      <p style={{ margin: '0 0 6px', fontWeight: 600 }}>The page moved to {origin}</p>
      <p style={{ margin: '0 0 8px' }}>
        AEGIS needs access to this site to keep working on the task. Nothing from the new page has been read or sent yet. Values from the previous site will not be
        typed here.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onAllow}>Allow on {origin}</button>
        <button onClick={onStop}>Stop</button>
      </div>
    </div>
  );
}
```

### 6. UI copy for the new outcomes — `ext/src/ui/StepTimeline.tsx`

Wherever the timeline maps `outcome` to a label, add `failed` → "action failed, re-observing" and
`navigated` → "page changed". If it renders the raw outcome string, no change is needed.

## Tests

### Unit — `ext/test/unit/reconnect.spec.ts` (new)

With a `deps()` helper where every function is a `vi.fn` with a happy-path default:
1. Happy path, same origin → `{ ok: true, origin: 'http://a.test', title }`; `requestAccess` not
   called.
2. `waitForComplete` → `false` → `{ ok: false, reason: 'load-timeout' }`; `connect` not called.
3. `currentTab` → `null` → `tab-closed`.
4. URL `chrome://newtab/` → `originOf` gives null → `no-origin`.
5. First `connect` → `{ ok: false, reason: 'inject-failed' }`, `requestAccess` → `'granted'`,
   second `connect` ok → `ok: true`; `connect` called twice.
6. `requestAccess` → `'cancelled'` → `access-cancelled`, and `connect` called once.
7. Both connects fail → `no-content`.

### Unit — `ext/test/unit/session.spec.ts`

Add a `buildSession` override that supplies `reconnect`. A second `ScriptedPort` stands for the
new page; `reconnect` returns `{ contentPort: new ContentPortClient(port2, handlers), origin:
'http://localhost:5601', title: 'Dashboard' }`.

New describe `Session — navigation (R-5)`:
1. **Same flow continues.** Plan 1: `click n-1`. The responder sends `action-result ok`, then
   calls `session.onContentDisconnected()`. `port2` answers `extract` with a graph of `[DASH_NODE]`.
   Plan 2: `done`. Assert:
   - state `DONE`;
   - `reconnect` called once;
   - the second payload has `reason: 'navigation'`, `delta_of: null`, nodes `['n-dash']`;
   - its `history[0].outcome === 'navigated'`.
2. **Disconnect before the action result still counts as navigation.** The responder disconnects
   during `dispatch-action` without sending `action-result` → same assertions as 1.
3. **Reconnect fails.** `reconnect` resolves `null` → state `STOPPED`, event
   `stopped: PAGE_DISCONNECTED`, and `sendToGateway` called once.
4. **No action since the last graph → stop.** Disconnect during the first `extract` wait →
   `PAGE_DISCONNECTED` and `reconnect` never called. This is the existing test and must still pass.
4b. **An auto-sent graph between the click and the unload doesn't hide the navigation.** The
    responder answers the click with `action-result ok`, then emits an unsolicited `graph`, then
    disconnects → `reconnect` is called and the task continues (same assertions as 1).
5. **Later actions are skipped.** Plan 1 `[click n-1, type n-2 text 'x']` where the click
   navigates → no `dispatch-action` for n-2 is posted on either port.
6. **Origin rebinding.** Step 1 mints `⟪EMAIL#1⟫` from an email field on the old origin. After
   navigation, plan 2 `type n-new ref ⟪EMAIL#1⟫` → event `rehydration_rejected` with
   `ORIGIN_MISMATCH`, and no `dispatch-action` is posted for it.
7. **`[click, done]` with a navigating click** → `DONE`, and `reconnect` not called (the task ended
   first).

New describe `Session — every stop is visible (A6/A7/A8/A18/A19)`:
8. **Failed action re-observes.** `action-result ok:false reason HIT_TEST_FAILED`, then plan 2
   `done` → `DONE`; payload 2 has `reason: 'reconcile'`; no `stopped` event.
9. **Repeated failures stop with a visible event.** Every dispatch fails, and plans keep clicking →
   an event `stopped: BUDGET_EXHAUSTED` and state `STOPPED`. The loop must not hang (use vitest's
   default timeout).
10. **Budget is per step.** 5 steps, each with one failed action followed by a successful step →
    no `BUDGET_EXHAUSTED`.
11. **Refused rehydration history.** Payload 2's history contains no entry with `step_id: ''`, and
    the refusal entry has `step_id: 's-1'`.
12. **Model stop.** Plan `stop reason 'unsafe'` → `stopped: MODEL_STOPPED`, state `STOPPED`.
13. **Declined confirmation.** `confirm` resolves `false` → `stopped: CANCELLED`, state
    `CANCELLED`.

### Unit — UI

`ext/test/unit/ui.spec.tsx`: `NavigationAccess` renders the origin, and its buttons call
`onAllow`/`onStop`.

### Protocol / gateway

- `pnpm --filter @aegis/protocol test`, with the new valid sample.
- `server/gateway/tests/test_contract.py` still passes. Add one gateway route test: a step with
  `reason: 'navigation'` is accepted (200 with a fake `complete`).

### End to end — real extension, real navigation (`eval/tests/test_navigation_task.py`, new)

Uses the harness pieces that already exist (`runner/browser.py:extension_context`,
`runner/drive.py:open_panel`/`run_task_in_panel`, `runner/collect.py:collect_ledger_export`), plus
a scripted gateway mock.

1. Add to `eval/src/aegis_eval/runner/gateway_mock.py`:

```python
@dataclass
class ScriptedGateway(MockGateway):
    """Answers each step with `plan_for(request_body)`. Node ids are random per session, so a
    script finds its targets by role and name in the request, never by a fixed id."""

    plan_for: Callable[[dict], dict] = lambda body: DEFAULT_PLAN

    def _handle(self, route: Route) -> None:
        request = route.request
        if request.url.endswith("/steps"):
            body = json.loads(request.post_data or "{}")
            session_id = request.url.split("/sessions/")[1].split("/steps")[0]
            plan = {**self.plan_for(body), "step_id": body.get("step_id", "s-1")}
            self.captured_steps.append(CapturedStep(session_id=session_id, request_body=body, response_plan=plan))
            route.fulfill(status=200, content_type="application/json", body=json.dumps(plan))
        else:
            super()._handle(route)


def node_id(body: dict, role: str, name: str) -> str:
    return next(n["id"] for n in body["nodes"] if n["role"] == role and n["name"] == name)
```

   Import `Callable` from `collections.abc`.

2. The test writes two pages into a `tmp_path` and serves them with `serve_corpus(tmp_path)`:
   - `login.html`: `<form action="{DASH_URL}" method="get"><label>Username <input name="u"></label><button type="submit">Sign in</button></form>`;
   - `dashboard.html`: `<h1>Dashboard</h1><p>Welcome</p>`.

   Script:
   - step with `reason == "initial"` → `{"actions":[{"op":"click","node": node_id(body,"button","Sign in")}]}`;
   - step with `reason == "navigation"` → `{"actions":[{"op":"done","summary":"on dashboard"}]}`;
   - anything else → `{"actions":[{"op":"stop","reason":"cannot_proceed"}]}`.

3. `test_same_origin_navigation_completes`: `DASH_URL` = the same server's `/dashboard.html`.
   Assert:
   - the panel text includes "Done";
   - two captured steps, the second with `reason == "navigation"` and a node named "Dashboard";
   - the ledger export has 2 entries.

4. `test_cross_origin_navigation_completes_in_dev_build`: serve the same `tmp_path` a second time
   (`serve_corpus(tmp_path, host="localhost")`) and point `DASH_URL` at that second origin. The dev
   build holds `<all_urls>`, so the content script injects without a prompt. Same assertions as 3.

The release-build path, where the Allow card appears, is covered by the unit tests plus the manual
check below. Playwright can't click a permission prompt.

### Manual check (release build)

1. `pnpm --filter @aegis/extension build`, then load `.output/chrome-mv3` unpacked in Chrome.
2. Serve the two pages on two origins, as in the e2e test. Open login on origin A, click the AEGIS
   toolbar icon, and run the task.
3. Expected:
   - after the submit, the panel shows "The page moved to `<origin B>`";
   - clicking **Allow** shows Chrome's permission prompt; accept it;
   - the task completes, and the step timeline shows "page changed".
4. Record the Chrome version and the result in the Acceptance list below.

## Acceptance

- [ ] Unit tests 1–13 and `reconnect.spec.ts` 1–7 pass. The protocol and gateway contract tests
  pass.
- [ ] `eval/tests/test_navigation_task.py`: same-origin and cross-origin (dev build) pass.
- [ ] Manual release-build cross-origin check done: Chrome version ______, result ______.
- [ ] The Decision-log rows R5-navigation, R5-origin and R5-stop-reasons in `tasks.md` still match
  what was built. Update them if anything changed during implementation.
