import type { EntityType } from '@aegis/recognizers';

export type Sensitivity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type Operator = 'placeholder_or_fill' | 'placeholder' | 'pass';
export type RehydrateRule = 'confirm' | 'auto_same_origin' | 'n/a' | 'deny';
export type CrossOriginRehydration = 'deny' | 'confirm' | 'allow';

export interface ClassRule {
  threshold: number;
  operator: Operator;
  rehydrate: RehydrateRule;
}

export interface AllowRule {
  id: string;
  entity: EntityType;
  reason: string;
}

export interface Policy {
  id: string;
  version: string;
  classes: Record<Sensitivity, ClassRule>;
  entityClass: Partial<Record<EntityType, Sensitivity>>;
  presenceOnly: EntityType[];
  partialDisclosure: Record<string, Record<string, boolean>>;
  crossOriginRehydration: CrossOriginRehydration;
  allowRules: AllowRule[];
  riskRules: { confirm: string[] };
}
