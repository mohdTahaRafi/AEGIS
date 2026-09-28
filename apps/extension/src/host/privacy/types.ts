// design.md §3.2 — Candidate and SensitiveRegion, the shapes fusion consumes and produces.

import type { EntityType } from '@aegis/recognizers';
import type { Sensitivity } from '@aegis/policy';

export type Box = [x: number, y: number, w: number, h: number];
export type Channel = 'dom' | 'text-dom' | 'text-ocr' | 'ner' | 'vision';

export interface Candidate {
  entity: EntityType;
  box: Box;
  score: number;
  channel: Channel;
  source: string;
  nodeId?: string;
  textRunId?: string;
  span?: [number, number];
  /** Set when the candidate came from a value the host actually read (so it can be minted into
   * the vault); absent for presence-only DOM signals. */
  value?: string;
  presenceOnly?: boolean;
  /** Channel D only: this entity's position in the field's own semantic reading (0 = the
   * primary type, 1.. = alternatives the same label names). Fusion uses it so a value recognizer
   * can pick among a field's semantic types but never override them — see merge.ts. */
  semanticRank?: number;
}

export interface SensitiveRegion {
  id: string;
  entity: EntityType;
  entities: EntityType[];
  class: Sensitivity;
  score: number;
  boxes: Box[];
  sources: string[];
  nodeId?: string;
  textRunId?: string;
  span?: [number, number];
  value?: string;
  presenceOnly: boolean;
  unverified: boolean;
}
