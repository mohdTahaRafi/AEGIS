import { describe, expect, it, vi } from 'vitest';
import { ensureHostPermission, listenForPermissionRevocation } from '../../src/host/platform/capabilities';

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
