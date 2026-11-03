// The panel's view of its task, kept in `storage.session` so closing the panel does not lose it.
// Closing the panel still ends the task itself (the step loop, vault and model session live in the
// panel's page); on reopening, the run log and result are shown again and a task that was cut off
// can be resumed on its tab with its HISTORY so far (Session `resume`).
//
// Nothing here can hold a vault value or a raw capture: the run log carries only what was sent
// (sanitized payloads, redacted screenshots) and what the model wrote back, and HISTORY only
// sanitized names. The task text is the user's own, as typed. `storage.session` is memory-only
// (cleared when the browser closes) and readable only by the extension's own pages, never by a
// content script. One record per window, since each window has its own side panel; the background
// drops it when the window closes. The text typed in the task box (run or not) is kept the same way.

import type { HistoryEntry } from './session';
import type { PanelState } from '../ui/PanelStates';
import type { RunLog } from '../ui/RunLog';

export interface SavedTaskStore {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface SavedTask {
  version: 1;
  task: string;
  startedAt: number;
  /** The tab the task was working in last: a resume continues there. */
  tabId: number;
  state: PanelState;
  errorMessage: string | null;
  log: RunLog;
  history: HistoryEntry[];
}

// Chrome's `storage.session` holds 10 MB for the whole extension; a record stays well under half,
// so two windows' records and the invocation records always fit.
const MAX_RECORD_BYTES = 4_000_000;

export const savedTaskKey = (windowId: number): string => `aegis.task.${windowId}`;
export const draftKey = (windowId: number): string => `aegis.draft.${windowId}`;

/** A state the task can only be in while its panel is open: found in a saved record, the panel was
 * closed mid-run. */
export function wasCutOff(state: PanelState): boolean {
  return state === 'loading' || state === 'running' || state === 'awaiting-confirmation' || state === 'awaiting-grant' || state === 'awaiting-user';
}

/** How many steps the saved run started, so a resumed one continues with the next step id. */
export function stepsStarted(log: RunLog): number {
  let max = 0;
  for (const step of log.steps) max = Math.max(max, Number(step.stepId.split('-')[1]) || 0);
  return max;
}

function byteSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Drops the older steps' screenshots, then their payloads, until the record fits. The latest
 * step's payload is kept whole for as long as possible: the privacy card shows it. */
export function fitRecord(record: SavedTask, maxBytes = MAX_RECORD_BYTES): SavedTask | null {
  if (byteSize(record) <= maxBytes) return record;
  const steps = record.log.steps.map((s) => ({ ...s }));
  const fitted = { ...record, log: { ...record.log, steps } };
  const latest = steps.findLastIndex((s) => s.payload !== undefined);
  const older = steps.map((_, i) => i).filter((i) => i !== latest);
  const dropImage = (i: number) => {
    const image = steps[i]!.payload?.image;
    if (!image || image.data === '') return false;
    steps[i] = { ...steps[i]!, payload: { ...steps[i]!.payload!, image: { ...image, data: '' } } };
    return true;
  };
  const dropPayload = (i: number) => {
    if (!steps[i]!.payload) return false;
    steps[i] = { ...steps[i]!, payload: undefined };
    return true;
  };
  const cuts = [...older.map((i) => () => dropImage(i)), ...older.map((i) => () => dropPayload(i))];
  if (latest !== -1) cuts.push(() => dropImage(latest), () => dropPayload(latest));
  for (const cut of cuts) if (cut() && byteSize(fitted) <= maxBytes) return fitted;
  return null;
}

export async function saveTask(store: SavedTaskStore, windowId: number, record: SavedTask): Promise<void> {
  const fitted = fitRecord(record);
  if (fitted) await store.set({ [savedTaskKey(windowId)]: fitted });
}

function isSavedTask(value: unknown): value is SavedTask {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<SavedTask>;
  return v.version === 1 && typeof v.task === 'string' && typeof v.startedAt === 'number' && typeof v.tabId === 'number' && typeof v.state === 'string' && Array.isArray(v.history) && typeof v.log === 'object' && v.log !== null && Array.isArray(v.log.steps) && Array.isArray(v.log.setup);
}

export async function loadTask(store: SavedTaskStore, windowId: number): Promise<SavedTask | null> {
  const value = (await store.get(savedTaskKey(windowId)))[savedTaskKey(windowId)];
  return isSavedTask(value) ? value : null;
}

export async function forgetTask(store: SavedTaskStore, windowId: number): Promise<void> {
  await store.remove(savedTaskKey(windowId));
}

export async function saveDraft(store: SavedTaskStore, windowId: number, text: string): Promise<void> {
  if (text) await store.set({ [draftKey(windowId)]: text });
  else await store.remove(draftKey(windowId));
}

export async function loadDraft(store: SavedTaskStore, windowId: number): Promise<string> {
  const value = (await store.get(draftKey(windowId)))[draftKey(windowId)];
  return typeof value === 'string' ? value : '';
}

/** A closed window's saved task and draft. */
export async function forgetWindow(store: SavedTaskStore, windowId: number): Promise<void> {
  await Promise.all([store.remove(savedTaskKey(windowId)), store.remove(draftKey(windowId))]);
}
