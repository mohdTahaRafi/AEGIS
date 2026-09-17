// GENERATED FILE — do not hand-edit. Run `pnpm gen:protocol` to regenerate.
// Source: packages/protocol/schema/

/**
 * [x, y, w, h] in CSS pixels, top-level viewport, origin top-left
 *
 * @minItems 4
 * @maxItems 4
 */
export type Box = [number, number, number, number];
export type NodeValue =
  | {
      kind: 'empty';
    }
  | {
      kind: 'presence';
      entity:
        | 'PASSWORD'
        | 'OTP'
        | 'CARD_NUMBER'
        | 'CARD_CVV'
        | 'CARD_EXPIRY'
        | 'AADHAAR'
        | 'FACE'
        | 'ID_DOCUMENT'
        | 'SIGNATURE'
        | 'QR_CODE'
        | 'SECRET'
        | 'EMAIL'
        | 'PHONE'
        | 'ADDRESS'
        | 'DOB'
        | 'BANK_ACCOUNT'
        | 'PAN'
        | 'GSTIN'
        | 'IFSC'
        | 'UPI_VPA'
        | 'PASSPORT'
        | 'VEHICLE_REG'
        | 'PERSON_NAME'
        | 'USERNAME'
        | 'PIN_CODE'
        | 'DATE'
        | 'AMOUNT'
        | 'CITY'
        | 'COUNTRY'
        | 'UNKNOWN_SENSITIVE'
        | 'CAPTCHA'
        | 'MEDIA'
        | 'LIVE';
      len: number;
    }
  | {
      kind: 'placeholder';
      ref: string;
      entity:
        | 'PASSWORD'
        | 'OTP'
        | 'CARD_NUMBER'
        | 'CARD_CVV'
        | 'CARD_EXPIRY'
        | 'AADHAAR'
        | 'FACE'
        | 'ID_DOCUMENT'
        | 'SIGNATURE'
        | 'QR_CODE'
        | 'SECRET'
        | 'EMAIL'
        | 'PHONE'
        | 'ADDRESS'
        | 'DOB'
        | 'BANK_ACCOUNT'
        | 'PAN'
        | 'GSTIN'
        | 'IFSC'
        | 'UPI_VPA'
        | 'PASSPORT'
        | 'VEHICLE_REG'
        | 'PERSON_NAME'
        | 'USERNAME'
        | 'PIN_CODE'
        | 'DATE'
        | 'AMOUNT'
        | 'CITY'
        | 'COUNTRY'
        | 'UNKNOWN_SENSITIVE'
        | 'CAPTCHA'
        | 'MEDIA'
        | 'LIVE';
      len: number;
    }
  | {
      kind: 'text';
      text: string;
    };

/**
 * design.md §4.3. Everything the client sends to the gateway for one step. No field in this schema may hold a URL, a CSS selector, an XPath, or a page origin — that is enforced structurally, not by convention.
 */
export interface SanitizedContext {
  schema: 'AEGIS/1';
  step_id: string;
  /**
   * Sanitized task text (Channel T + placeholder substitution already applied).
   */
  task: string;
  reason: 'initial' | 'after_action' | 'requested' | 'reconcile';
  delta_of?: string | null;
  viewport: {
    w: number;
    h: number;
    dpr: number;
    scroll_y: number;
    doc_h: number;
  };
  /**
   * OQ-11 default: category only, never an origin or URL.
   */
  page: {
    category: 'gov' | 'banking' | 'email' | 'social' | 'health' | 'docs' | 'canvas_app' | 'unknown';
    /**
     * Sanitized page title.
     */
    title: string;
  };
  nodes: SanitizedNode[];
  /**
   * Delta only: node ids no longer present.
   */
  removed?: string[];
  text: SanitizedTextRun[];
  redactions: RedactionLegendEntry[];
  unexplained: {
    box: Box;
    reason: 'canvas' | 'img' | 'video' | 'iframe-blocked' | 'svg-text' | 'embed' | 'other';
    status: 'grey' | 'analysed';
  }[];
  coverage: {
    cleared: number;
    redacted: number;
    unanalysed: number;
  };
  image?: ImagePart | null;
  /**
   * @maxItems 5
   */
  history:
    | []
    | [
        {
          step_id: string;
          actions: {
            op: string;
            [k: string]: unknown;
          }[];
          outcome: string;
        }
      ]
    | [
        {
          step_id: string;
          actions: {
            op: string;
            [k: string]: unknown;
          }[];
          outcome: string;
        },
        {
          step_id: string;
          actions: {
            op: string;
            [k: string]: unknown;
          }[];
          outcome: string;
        }
      ]
    | [
        {
          step_id: string;
          actions: {
            op: string;
            [k: string]: unknown;
          }[];
          outcome: string;
        },
        {
          step_id: string;
          actions: {
            op: string;
            [k: string]: unknown;
          }[];
          outcome: string;
        },
        {
          step_id: string;
          actions: {
            op: string;
            [k: string]: unknown;
          }[];
          outcome: string;
        }
      ]
    | [
        {
          step_id: string;
          actions: {
            op: string;
            [k: string]: unknown;
          }[];
          outcome: string;
        },
        {
          step_id: string;
          actions: {
            op: string;
            [k: string]: unknown;
          }[];
          outcome: string;
        },
        {
          step_id: string;
          actions: {
            op: string;
            [k: string]: unknown;
          }[];
          outcome: string;
        },
        {
          step_id: string;
          actions: {
            op: string;
            [k: string]: unknown;
          }[];
          outcome: string;
        }
      ]
    | [
        {
          step_id: string;
          actions: {
            op: string;
            [k: string]: unknown;
          }[];
          outcome: string;
        },
        {
          step_id: string;
          actions: {
            op: string;
            [k: string]: unknown;
          }[];
          outcome: string;
        },
        {
          step_id: string;
          actions: {
            op: string;
            [k: string]: unknown;
          }[];
          outcome: string;
        },
        {
          step_id: string;
          actions: {
            op: string;
            [k: string]: unknown;
          }[];
          outcome: string;
        },
        {
          step_id: string;
          actions: {
            op: string;
            [k: string]: unknown;
          }[];
          outcome: string;
        }
      ];
  client_timing: {
    [k: string]: number;
  };
}
export interface SanitizedNode {
  id: string;
  role: string;
  name: string;
  box: Box;
  frame: string;
  z: number;
  state: {
    focused?: boolean;
    disabled?: boolean;
    readonly?: boolean;
    required?: boolean;
    checked?: boolean;
    expanded?: boolean;
    selected?: boolean;
    has_value?: boolean;
    value_len?: number;
    occluded?: boolean;
    volatile?: boolean;
  };
  affordances: ('click' | 'type' | 'select' | 'toggle' | 'scroll')[];
  value?: NodeValue;
}
export interface SanitizedTextRun {
  id: string;
  box: Box;
  /**
   * Sanitized — placeholders already substituted.
   */
  text: string;
}
export interface RedactionLegendEntry {
  ref?: string | null;
  entity:
    | 'PASSWORD'
    | 'OTP'
    | 'CARD_NUMBER'
    | 'CARD_CVV'
    | 'CARD_EXPIRY'
    | 'AADHAAR'
    | 'FACE'
    | 'ID_DOCUMENT'
    | 'SIGNATURE'
    | 'QR_CODE'
    | 'SECRET'
    | 'EMAIL'
    | 'PHONE'
    | 'ADDRESS'
    | 'DOB'
    | 'BANK_ACCOUNT'
    | 'PAN'
    | 'GSTIN'
    | 'IFSC'
    | 'UPI_VPA'
    | 'PASSPORT'
    | 'VEHICLE_REG'
    | 'PERSON_NAME'
    | 'USERNAME'
    | 'PIN_CODE'
    | 'DATE'
    | 'AMOUNT'
    | 'CITY'
    | 'COUNTRY'
    | 'UNKNOWN_SENSITIVE'
    | 'CAPTCHA'
    | 'MEDIA'
    | 'LIVE';
  class: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  len?: number;
  boxes: Box[];
  method: 'placeholder' | 'fill';
  confidence: number;
  sources: string[];
  unverified: boolean;
}
export interface ImagePart {
  level: 'L1' | 'L2';
  region: Box;
  scale: number;
  format: 'image/webp';
  sha256: string;
  data: string;
  legend: string;
}
