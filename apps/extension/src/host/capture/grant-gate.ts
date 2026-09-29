// A capture Chrome refuses for lack of the activeTab grant used to degrade the step to DOM-only
// and carry on to the model — so a tab whose grant had been withdrawn by a cross-origin navigation
// (shared/invocation.ts) silently ran a whole task without vision. Now the step pauses BEFORE
// anything is sent and asks the user to invoke AEGIS on the task's tab, or to allow AEGIS on all
// sites from the card (a host permission, which also covers screenshots); either way the capture is
// then retried and its real result used. There is no "continue without screenshots": every step
// carries one. Stop ends the wait with the real failure reason.

import { explainGrant, type GrantExplanation, type InvocationRecord } from '../../shared/invocation';
import type { CaptureFailureReason, CaptureResult } from './classify';

export type GrantPromptOutcome = 'invoked' | 'retry' | 'cancelled';

export interface GrantGateDeps {
  /** One real capture attempt of the task tab. */
  capture(): Promise<CaptureResult>;
  readInvocation(): Promise<InvocationRecord | null>;
  currentOrigin(): Promise<string | null>;
  /** Subscribes to toolbar invocations on the task's tab; returns the unsubscribe. */
  onInvoked(cb: () => void): () => void;
  /** Shows the "invoke AEGIS on this tab" prompt; the UI settles it with `retry` (the user granted
   * access from the card) or `cancelled`. Returns a function that removes the prompt. */
  prompt(explanation: GrantExplanation, settle: (outcome: 'retry' | 'cancelled') => void): () => void;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Failures a toolbar invocation on the tab can cure: it grants activeTab, which also carries host
 * access to the tab's current origin. */
const GRANT_FIXABLE: ReadonlySet<CaptureFailureReason> = new Set(['permission', 'host-access']);

/** Chrome allows two `captureVisibleTab` calls per second per extension. */
const MIN_CAPTURE_INTERVAL_MS = 550;

function waitForInvocation(explanation: GrantExplanation, since: number, deps: GrantGateDeps): Promise<GrantPromptOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const cleanups: Array<() => void> = [];
    const finish = (outcome: GrantPromptOutcome): void => {
      if (settled) return;
      settled = true;
      for (const cleanup of cleanups.splice(0)) cleanup();
      resolve(outcome);
    };
    // Registered as each is created, so one that settles synchronously is still torn down.
    for (const setup of [() => deps.onInvoked(() => finish('invoked')), () => deps.prompt(explanation, finish)]) {
      const cleanup = setup();
      if (settled) cleanup();
      else cleanups.push(cleanup);
    }
    // An invocation that landed after the refused capture started but before the subscription
    // above existed would otherwise be missed until the user clicked a second time.
    void deps.readInvocation().then((record) => {
      if (record && record.lostTo === undefined && record.at >= since) finish('invoked');
    });
  });
}

export function createGatedCapture(deps: GrantGateDeps): () => Promise<CaptureResult> {
  return async () => {
    let startedAt = deps.now();
    let result = await deps.capture();
    while (!result.ok && GRANT_FIXABLE.has(result.reason)) {
      const explanation = explainGrant(await deps.readInvocation(), await deps.currentOrigin());
      const failure: CaptureResult = {
        ok: false,
        reason: explanation.kind === 'lost-on-navigation' ? 'grant-lost-navigation' : result.reason,
        detail: result.detail,
      };
      const outcome = await waitForInvocation(explanation, startedAt, deps);
      if (outcome === 'cancelled') return failure;
      const wait = startedAt + MIN_CAPTURE_INTERVAL_MS - deps.now();
      if (wait > 0) await deps.sleep(wait);
      startedAt = deps.now();
      result = await deps.capture();
    }
    return result;
  };
}
