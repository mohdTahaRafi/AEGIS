// Every preflight failure reason must be loggable: an unlisted one threw inside the content
// script's action handler, which then never answered the host (Gmail, 2026-09-29).

import { describe, expect, it } from 'vitest';
import { log } from '../../src/shared/logger';
import type { PreflightFailureReason } from '../../src/shared/messages';

const REASONS: PreflightFailureReason[] = ['NODE_UNRESOLVED', 'FACET_ROLE', 'FACET_NAME', 'HIT_TEST_FAILED', 'DISABLED', 'CONTAINER_MISMATCH', 'LEASE_EXPIRED', 'NODE_VOLATILE', 'INTERNAL_ERROR'];

describe('logger closed vocabulary', () => {
  it.each(REASONS)('accepts preflight reason %s', (reason) => {
    expect(() => log({ code: 'preflight_failed', detail: reason })).not.toThrow();
  });

  it('still refuses free text', () => {
    expect(() => log({ code: 'preflight_failed', detail: 'ramesh.kumar@example.in' })).toThrow(/closed vocabulary/);
  });
});
