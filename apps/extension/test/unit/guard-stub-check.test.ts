/**
 * T-2.46: both CI tripwires actually fire on a real violation, not just pass on clean code —
 * same discipline as no-network-scan.ts's own test (T-1.9): a check that's never been proven to
 * fail is not known to work.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkEgressFolderRequirement, checkGuardStubTripwire } from '../../scripts/guard-stub-check.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'aegis-guard-stub-check-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relPath: string, content: string): string {
  const full = path.join(root, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

describe('checkEgressFolderRequirement', () => {
  it('fails when the egress folder does not exist at all', () => {
    const egressDir = path.join(root, 'src', 'host', 'egress');
    const result = checkEgressFolderRequirement(egressDir, []);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('must exist');
  });

  it('fails when the folder exists but nothing in it references fetch/XHR/WebSocket (vacuous pass avoided)', () => {
    const clientFile = write('src/host/egress/client.ts', 'export function noop() { return 1; }');
    const egressDir = path.join(root, 'src', 'host', 'egress');
    const result = checkEgressFolderRequirement(egressDir, [clientFile]);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('nothing would actually reach the network');
  });

  it('passes when a real fetch call (even via an injected, renamed parameter) is present', () => {
    const clientFile = write(
      'src/host/egress/client.ts',
      'export function createClient(fetchImpl: typeof fetch = fetch) { return fetchImpl; }',
    );
    const egressDir = path.join(root, 'src', 'host', 'egress');
    const result = checkEgressFolderRequirement(egressDir, [clientFile]);
    expect(result.ok).toBe(true);
  });
});

describe('checkGuardStubTripwire', () => {
  it('passes when the stub exists but the real guard does not yet (Phase 2 — expected today)', () => {
    const stub = write('src/host/egress/guard-stub.ts', '// stub');
    const realGuardDir = path.join(root, 'src', 'host', 'privacy', 'guard');
    expect(checkGuardStubTripwire(stub, realGuardDir).ok).toBe(true);
  });

  it('passes when neither exists', () => {
    const stub = path.join(root, 'src', 'host', 'egress', 'guard-stub.ts');
    const realGuardDir = path.join(root, 'src', 'host', 'privacy', 'guard');
    expect(checkGuardStubTripwire(stub, realGuardDir).ok).toBe(true);
  });

  it('fails when both the stub and the real guard exist — the tripwire the AC asks for', () => {
    const stub = write('src/host/egress/guard-stub.ts', '// stub');
    write('src/host/privacy/guard/index.ts', 'export const real = true;');
    const realGuardDir = path.join(root, 'src', 'host', 'privacy', 'guard');

    const result = checkGuardStubTripwire(stub, realGuardDir);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('must be deleted');
  });
});
