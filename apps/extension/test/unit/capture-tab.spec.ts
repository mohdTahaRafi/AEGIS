import { describe, expect, it, vi } from 'vitest';
import { captureTargetTab, type TabsCaptureApi } from '../../src/host/capture/capture-tab';

type TabState = Awaited<ReturnType<TabsCaptureApi['get']>>;
const TARGET = { tabId: 42, origin: 'https://accounts.example.test' };
const ON_TARGET = 'https://accounts.example.test/login?next=%2Fhome';

function tabs(states: TabState[], capture: TabsCaptureApi['captureVisibleTab']): TabsCaptureApi & { get: ReturnType<typeof vi.fn> } {
  const get = vi.fn();
  for (const s of states) get.mockResolvedValueOnce(s);
  return { get, captureVisibleTab: capture };
}

describe('captureTargetTab — pinned to the task tab and origin, never "whatever is in front"', () => {
  it("captures the task tab's own window, not the caller's current window", async () => {
    const capture = vi.fn().mockResolvedValue('data:image/jpeg;base64,AAA');
    const api = tabs([{ active: true, windowId: 7, url: ON_TARGET }, { active: true, windowId: 7, url: ON_TARGET }], capture);
    expect(await captureTargetTab(api, TARGET)).toEqual({ ok: true, dataUrl: 'data:image/jpeg;base64,AAA' });
    expect(api.get).toHaveBeenCalledWith(42);
    expect(capture).toHaveBeenCalledWith(7, { format: 'jpeg', quality: 80 });
  });

  it('does not capture at all when the task tab is in the background (another tab would be grabbed)', async () => {
    const capture = vi.fn();
    const result = await captureTargetTab(tabs([{ active: false, windowId: 7, url: ON_TARGET }], capture), TARGET);
    expect(result).toMatchObject({ ok: false, reason: 'not-visible', diag: { tabId: 42, windowId: 7, active: false } });
    expect(capture).not.toHaveBeenCalled();
  });

  it('does not capture a task tab that has navigated to another site', async () => {
    const capture = vi.fn();
    const result = await captureTargetTab(tabs([{ active: true, windowId: 7, url: 'https://other.example.test/x' }], capture), TARGET);
    expect(result).toMatchObject({ ok: false, reason: 'origin-changed', diag: { origin: 'https://other.example.test', taskOrigin: TARGET.origin } });
    expect(capture).not.toHaveBeenCalled();
  });

  it('keeps capturing across a same-origin path change (SPA route or same-site navigation)', async () => {
    const capture = vi.fn().mockResolvedValue('data:image/jpeg;base64,AAA');
    const moved = 'https://accounts.example.test/new_patient_signup';
    const result = await captureTargetTab(tabs([{ active: true, windowId: 7, url: moved }, { active: true, windowId: 7, url: moved }], capture), TARGET);
    expect(result.ok).toBe(true);
  });

  it('discards the frame when the user switched tabs while it was being taken', async () => {
    const capture = vi.fn().mockResolvedValue('data:image/jpeg;base64,AAA');
    const result = await captureTargetTab(tabs([{ active: true, windowId: 7, url: ON_TARGET }, { active: false, windowId: 7, url: ON_TARGET }], capture), TARGET);
    expect(result).toMatchObject({ ok: false, reason: 'not-visible' });
  });

  it('discards the frame when the tab navigated cross-origin while it was being taken', async () => {
    const capture = vi.fn().mockResolvedValue('data:image/jpeg;base64,AAA');
    const result = await captureTargetTab(tabs([{ active: true, windowId: 7, url: ON_TARGET }, { active: true, windowId: 7, url: 'https://other.example.test/' }], capture), TARGET);
    expect(result).toMatchObject({ ok: false, reason: 'origin-changed' });
  });

  it('discards the frame when the tab moved to another window mid-capture', async () => {
    const capture = vi.fn().mockResolvedValue('data:image/jpeg;base64,AAA');
    const result = await captureTargetTab(tabs([{ active: true, windowId: 7, url: ON_TARGET }, { active: true, windowId: 9, url: ON_TARGET }], capture), TARGET);
    expect(result).toMatchObject({ ok: false, reason: 'not-visible' });
  });

  it('a closed tab is no-tab, not an exception', async () => {
    const api: TabsCaptureApi = { get: vi.fn().mockRejectedValue(new Error('No tab with id: 42.')), captureVisibleTab: vi.fn() };
    expect(await captureTargetTab(api, TARGET)).toMatchObject({ ok: false, reason: 'no-tab' });
  });

  it("reports Chrome's real activeTab refusal as permission, with its text and the tab state", async () => {
    const capture = vi.fn().mockRejectedValue(new Error("Either the '<all_urls>' or 'activeTab' permission is required."));
    const result = await captureTargetTab(tabs([{ active: true, windowId: 7, url: ON_TARGET, status: 'complete', discarded: false }], capture), TARGET);
    expect(result).toEqual({
      ok: false,
      reason: 'permission',
      detail: "Either the '<all_urls>' or 'activeTab' permission is required.",
      diag: { tabId: 42, windowId: 7, active: true, status: 'complete', discarded: false, origin: TARGET.origin, taskOrigin: TARGET.origin },
    });
  });

  it('a host-access error is host-access (not "activeTab not granted"), with any quoted URL removed', async () => {
    const capture = vi.fn().mockRejectedValue(new Error('Cannot access contents of url "https://accounts.example.test/login?token=abc". Extension manifest must request permission to access this host.'));
    const result = await captureTargetTab(tabs([{ active: true, windowId: 7, url: ON_TARGET }], capture), TARGET);
    expect(result).toMatchObject({ ok: false, reason: 'host-access', detail: 'Cannot access contents of url "…". Extension manifest must request permission to access this host.' });
    expect(JSON.stringify(result)).not.toContain('token=abc');
  });

  it('an unrecognised Chrome error stays unknown and keeps its text', async () => {
    const capture = vi.fn().mockRejectedValue(new Error('Failed to capture tab: unknown error'));
    const result = await captureTargetTab(tabs([{ active: true, windowId: 7, url: ON_TARGET }], capture), TARGET);
    expect(result).toMatchObject({ ok: false, reason: 'unknown', detail: 'Failed to capture tab: unknown error' });
  });
});
