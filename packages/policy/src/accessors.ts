import type { EntityType } from '@aegis/recognizers';
import type { ClassRule, Policy, Sensitivity } from './types';

/** design.md §7.1 step 1 — `policy.entityClass(entity)`. Entities absent from the map (should
 * not happen with a validated policy that covers the closed enum, but the accessor stays honest
 * about the type) fall back to the most conservative class. */
export function entityClass(policy: Policy, entity: EntityType): Sensitivity {
  return policy.entityClass[entity] ?? 'CRITICAL';
}

export function classRule(policy: Policy, sensitivity: Sensitivity): ClassRule {
  return policy.classes[sensitivity];
}

export function threshold(policy: Policy, sensitivity: Sensitivity): number {
  return classRule(policy, sensitivity).threshold;
}

/** design.md §7.1 step 2's uncertainty band floor: τ(class) − 0.15. */
export function bandFloor(policy: Policy, sensitivity: Sensitivity): number {
  return Math.max(0, threshold(policy, sensitivity) - 0.15);
}

export function isPresenceOnly(policy: Policy, entity: EntityType): boolean {
  return policy.presenceOnly.includes(entity);
}

export function allowsPartialDisclosure(policy: Policy, entity: EntityType, field: string): boolean {
  return policy.partialDisclosure[entity]?.[field] === true;
}

export function requiresRiskConfirmation(policy: Policy, riskTag: string): boolean {
  return policy.riskRules.confirm.includes(riskTag);
}

export function entitiesAtOrAbove(policy: Policy, minimum: Sensitivity): EntityType[] {
  const order: Sensitivity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
  const minIndex = order.indexOf(minimum);
  return (Object.keys(policy.entityClass) as EntityType[]).filter(
    (e) => order.indexOf(policy.entityClass[e]!) >= minIndex,
  );
}
