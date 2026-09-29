import { describe, expect, it, vi } from 'vitest';
import { ensureHostPermission, ensureTaskPermissions, listenForPermissionRevocation } from '../../src/host/platform/capabilities';

describe('ensureHostPermission (T-2.4 AC)', () => {
  it('does not prompt if the origin is already granted', async () => {
    const permissions = { contains: vi.fn().mockResolvedValue(true), request: vi.fn() };
    const result = await ensureHostPermission(permissions, 'https://example.com');
    expect(result).toBe('granted');
    expect(permissions.request).not.toHaveBeenCalled();
  });

  it('requests (prompts) when not already granted, and reports a grant', async () => {
    const permissions = { contains: vi.fn().mockResolvedValue(false), request: vi.fn().mockResolvedValue(true) };
    const result = await ensureHostPermission(permissions, 'https://example.com');
    expect(result).toBe('requested-and-granted');
    expect(permissions.request).toHaveBeenCalledWith({ origins: ['https://example.com/*'] });
  });

  it('reports denial as a state, not an error, when the user says no', async () => {
    const permissions = { contains: vi.fn().mockResolvedValue(false), request: vi.fn().mockResolvedValue(false) };
    const result = await ensureHostPermission(permissions, 'https://example.com');
    expect(result).toBe('denied');
  });
});

// captureVisibleTab needs <all_urls> or an activeTab click on that very tab; a per-site grant is
// not enough, so a tab the task opens on another site could be read but never screenshotted.
describe('ensureTaskPermissions — all sites, so every tab the task reaches can be captured', () => {
  const granted = (patterns: string[]) => vi.fn(async ({ origins }: { origins: string[] }) => origins.every((o) => patterns.includes(o)));

  it('does not prompt when all sites is already granted', async () => {
    const permissions = { contains: granted(['<all_urls>']), request: vi.fn() };
    expect(await ensureTaskPermissions(permissions, 'https://www.amazon.in')).toEqual({ state: 'granted', allSites: true });
    expect(permissions.request).not.toHaveBeenCalled();
  });

  it('asks for all sites (one prompt) when only this site was granted before', async () => {
    const permissions = { contains: granted(['https://www.amazon.in/*']), request: vi.fn().mockResolvedValue(true) };
    expect(await ensureTaskPermissions(permissions, 'https://www.amazon.in')).toEqual({ state: 'requested-and-granted', allSites: true });
    expect(permissions.request).toHaveBeenCalledTimes(1);
    expect(permissions.request).toHaveBeenCalledWith({ origins: ['<all_urls>'] });
  });

  it('falls back to this site when all sites is declined', async () => {
    const permissions = { contains: granted(['https://www.amazon.in/*']), request: vi.fn().mockResolvedValue(false) };
    expect(await ensureTaskPermissions(permissions, 'https://www.amazon.in')).toEqual({ state: 'granted', allSites: false });
  });

  it('reports denied when neither all sites nor this site is granted, even if the second prompt throws', async () => {
    const permissions = { contains: granted([]), request: vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('This function must be called during a user gesture')) };
    expect(await ensureTaskPermissions(permissions, 'https://example.com')).toEqual({ state: 'denied', allSites: false });
  });
});

describe('listenForPermissionRevocation (T-2.2 AC)', () => {
  it('calls onRevoked when the revoked origin matches the current task', () => {
    let handler: (message: unknown) => void = () => {};
    const runtime = { addMessageListener: (cb: (m: unknown) => void) => (handler = cb) };
    const onRevoked = vi.fn();
    listenForPermissionRevocation(runtime, () => 'https://example.com', onRevoked);

    handler({ type: 'permission-revoked', origin: 'https://example.com/*' });
    expect(onRevoked).toHaveBeenCalledWith('https://example.com/*');
  });

  it('ignores a revocation for a different origin', () => {
    let handler: (message: unknown) => void = () => {};
    const runtime = { addMessageListener: (cb: (m: unknown) => void) => (handler = cb) };
    const onRevoked = vi.fn();
    listenForPermissionRevocation(runtime, () => 'https://example.com', onRevoked);

    handler({ type: 'permission-revoked', origin: 'https://evil.example.com.attacker.net/*' });
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('ignores a malformed message and a revocation when no task is running', () => {
    let handler: (message: unknown) => void = () => {};
    const runtime = { addMessageListener: (cb: (m: unknown) => void) => (handler = cb) };
    const onRevoked = vi.fn();
    listenForPermissionRevocation(runtime, () => null, onRevoked);

    handler({ type: 'permission-revoked', origin: 'https://example.com/*' });
    handler({ not: 'a permission message' });
    expect(onRevoked).not.toHaveBeenCalled();
  });
});
