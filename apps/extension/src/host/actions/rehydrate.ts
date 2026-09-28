// design.md §9.3 — `resolveFor`'s all-six-conditions rehydration pipeline (T-3.28), wired to a
// real `WireScreenNode` target. Conditions 1 (ref minted this session), 2 (not presence-only),
// 5 (class → confirm/allow) and 6 (visible/enabled/un-occluded) are enforced inside
// `Vault.resolveFor` itself; this file supplies condition 3 (type match) and 4 (origin match),
// which need DOM/policy evidence the vault module doesn't have, then calls into the vault.

import type { EntityType } from '@aegis/recognizers';
import { AADHAAR_LEXICON, ADDRESS_LEXICON, fieldEntitiesFromText, matchesLexicon, PAN_LEXICON, PASSPORT_LEXICON } from '@aegis/recognizers';
import type { Policy } from '@aegis/policy';
import { isPresenceOnly } from '@aegis/policy';
import type { Vault, ResolveFailureCode } from '../privacy/vault';
import type { WireScreenNode } from '../../shared/messages';

/** design.md §9.3 condition 3 — the target's own evidence must support the ref's entity. Each
 * branch is independent evidence a real page would actually expose; a node matching none of them
 * for a given entity is refused, not guessed at. */
function typeMatches(entity: EntityType, node: WireScreenNode): boolean {
  const autocomplete = (node.field?.autocomplete ?? '').toLowerCase();
  const inputType = (node.field?.inputType ?? '').toLowerCase();
  const nameOrLabel = `${node.name}`;

  // The same field-bound semantics that classified the field for redaction (Channel D) are the
  // target's strongest type evidence.
  if (node.domSignal && (node.domSignal.entity === entity || node.domSignal.alternatives?.includes(entity))) return true;
  if (fieldEntitiesFromText(nameOrLabel).includes(entity)) return true;

  switch (entity) {
    case 'EMAIL':
      return inputType === 'email' || autocomplete === 'email' || /email/i.test(nameOrLabel);
    case 'PHONE':
      return inputType === 'tel' || autocomplete.startsWith('tel') || /phone|mobile/i.test(nameOrLabel);
    case 'AADHAAR':
      return matchesLexicon(nameOrLabel, AADHAAR_LEXICON);
    case 'PAN':
      return matchesLexicon(nameOrLabel, PAN_LEXICON);
    case 'PASSPORT':
      return matchesLexicon(nameOrLabel, PASSPORT_LEXICON);
    case 'ADDRESS':
      return matchesLexicon(nameOrLabel, ADDRESS_LEXICON) || autocomplete.includes('address');
    case 'PERSON_NAME':
      return autocomplete.includes('name') || /name/i.test(nameOrLabel);
    case 'DOB':
      return autocomplete.startsWith('bday') || /birth|dob/i.test(nameOrLabel);
    case 'USERNAME':
      return autocomplete === 'username' || /user\s*name|login/i.test(nameOrLabel);
    default:
      // Entities with no meaningful "type" evidence beyond having been detected in the first
      // place (e.g. GSTIN, IFSC, UPI_VPA, PIN_CODE) are matched by name/label containing the
      // entity's own word — conservative, but never a silent pass.
      return nameOrLabel.toLowerCase().includes(entity.toLowerCase().replace(/_/g, ' '));
  }
}

export interface RehydrationDecision {
  originKey: string;
  confirmed: boolean;
  targetNode: WireScreenNode;
}

export function rehydrationRequiresConfirmation(policy: Policy, entity: EntityType): boolean {
  const cls = policy.entityClass[entity];
  return cls ? policy.classes[cls].rehydrate === 'confirm' : true;
}

export type RehydrateResult = { ok: true; value: string } | { ok: false; code: ResolveFailureCode };

export function resolveRehydration(vault: Vault, policy: Policy, ref: string, decision: RehydrationDecision): RehydrateResult {
  const description = vault.describe(ref);
  if (!description) return { ok: false, code: 'REF_UNKNOWN' };

  return vault.resolveFor(ref, {
    typeMatches: typeMatches(description.entity, decision.targetNode),
    originKey: decision.originKey,
    confirmed: decision.confirmed,
    isPresenceOnlyTarget: isPresenceOnly(policy, description.entity),
    visible: !decision.targetNode.state.occluded,
    enabled: !decision.targetNode.state.disabled,
    occluded: decision.targetNode.state.occluded,
  });
}
