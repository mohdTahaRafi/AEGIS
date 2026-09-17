// GENERATED FILE — do not hand-edit. Run `pnpm gen:protocol` to regenerate.
// Source: packages/protocol/schema/

export type Action =
  | {
      op: 'click';
      node: string;
      expect?: Expect;
    }
  | {
      op: 'type';
      node: string;
      ref: string;
      clear_first?: boolean;
      expect?: Expect;
    }
  | {
      op: 'type';
      node: string;
      text: string;
      clear_first?: boolean;
      expect?: Expect;
    }
  | {
      op: 'select';
      node: string;
      option: string;
      expect?: Expect;
    }
  | {
      op: 'scroll';
      direction: 'up' | 'down' | 'left' | 'right';
      amount?: 'small' | 'page' | 'end';
      node?: string;
    }
  | {
      op: 'wait';
      ms: number;
    }
  | {
      op: 'click_point';
      x: number;
      y: number;
      label: string;
    }
  | {
      op: 'request_observation';
      level: 'L1' | 'L2';
      region?: Box;
    }
  | {
      op: 'report';
      title?: string;
      content: string;
    }
  | {
      op: 'ask_user';
      question: string;
    }
  | {
      op: 'done';
      summary?: string;
    }
  | {
      op: 'stop';
      reason: 'captcha' | 'blocked' | 'cannot_proceed' | 'unsafe';
    };
/**
 * [x, y, w, h] in CSS pixels, top-level viewport, origin top-left
 *
 * @minItems 4
 * @maxItems 4
 */
export type Box = [number, number, number, number];

/**
 * design.md §4.5/§4.6. Also used as the vLLM structured-decoding grammar (Phase 2, T-2.36) — a hallucinated action is a parse error, not a click.
 */
export interface ActionPlan {
  step_id: string;
  plan_id?: string;
  /**
   * @minItems 1
   * @maxItems 5
   */
  actions:
    | [Action]
    | [Action, Action]
    | [Action, Action, Action]
    | [Action, Action, Action, Action]
    | [Action, Action, Action, Action, Action];
  risk_hint?: 'low' | 'medium' | 'high';
  stop_if?: ('navigation_to_other_origin' | 'captcha_detected' | 'form_error_shown')[];
  note?: string;
}
export interface Expect {
  role?: string;
  name?: string;
  box_tolerance_px?: number;
}
