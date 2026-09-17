// design.md §7.6 steps 3-4 — the two independent sweeps that give the guard its value. Step 3
// catches a substitution bug (a value the vault knows about but a *different* occurrence of it
// slipped through unsubstituted). Step 4 catches a detection bug (a value no channel ever found,
// so it never reached the vault at all). "Independent" means: different inputs (final serialized
// bytes, not DOM/candidates) at a different time (after substitution) — see design.md §7.2.

import { ALL_RECOGNIZERS, type EntityType } from '@aegis/recognizers';
import type { Policy, Sensitivity } from '@aegis/policy';
import { entityClass } from '@aegis/policy';
import type { Vault } from '../vault';
import { normalizedContains } from './normalize-contains';

export interface GuardBlock {
  rule: 'VAULT_LEAK' | 'PATTERN' | 'SCHEMA' | 'ID_SHAPE';
  entity?: EntityType;
}

const CLASS_ORDER: Sensitivity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/** Step 3: every value the vault knows about, searched for in the outgoing bytes. */
export function vaultLeakSweep(vault: Vault, bytes: string): GuardBlock | null {
  for (const normalized of vault.normalizedValues()) {
    if (normalizedContains(bytes, normalized)) {
      return { rule: 'VAULT_LEAK' };
    }
  }
  return null;
}

/** Step 4: recognizers where class ≥ HIGH run again, over the final payload's strings —
 * independently of whatever detected (or failed to detect) them the first time. */
export function patternResweep(policy: Policy, bytes: string): GuardBlock | null {
  const highOrAbove = new Set(['HIGH', 'CRITICAL']);
  for (const recognizer of ALL_RECOGNIZERS) {
    if (!highOrAbove.has(entityClass(policy, recognizer.entity))) continue;
    for (const match of recognizer.find(bytes)) {
      if (match.valid) {
        return { rule: 'PATTERN', entity: recognizer.entity };
      }
    }
  }
  return null;
}

export function classAtLeast(a: Sensitivity, b: Sensitivity): boolean {
  return CLASS_ORDER.indexOf(a) >= CLASS_ORDER.indexOf(b);
}
