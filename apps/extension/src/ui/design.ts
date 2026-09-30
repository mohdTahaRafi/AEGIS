// Shared design tokens and style primitives for the AEGIS side panel redesign.
// All UI components import from here to keep visual language consistent.
import type { JSX } from 'preact';

export type StyleObj = JSX.CSSProperties;

export const C = {
  // Neutrals
  white: '#ffffff',
  bg: '#f8f9fa',        // subtle off-white page background
  surface: '#ffffff',   // card / section surface
  border: '#e4e7eb',    // thin separator
  borderMid: '#d1d5db', // slightly stronger border
  muted: '#9ca3af',     // secondary text, placeholders
  secondary: '#6b7280', // sub-labels, descriptions
  body: '#374151',      // body text
  strong: '#111827',    // headings, important labels

  // Accent — restrained blue-charcoal
  accent: '#1e40af',       // primary action, active status
  accentLight: '#dbeafe',  // light tint for focus rings
  accentSoft: '#eff6ff',   // very subtle tint

  // Semantic
  ok: '#15803d',        // success text
  okBg: '#f0fdf4',      // success background
  okBorder: '#86efac',
  warn: '#b45309',      // warning text
  warnBg: '#fffbeb',
  warnBorder: '#fcd34d',
  error: '#b91c1c',     // error / blocked text
  errorBg: '#fef2f2',
  errorBorder: '#fca5a5',
  info: '#1d4ed8',      // info / awaiting text
  infoBg: '#eff6ff',
  infoBorder: '#bfdbfe',
} as const;

export const T = {
  // Font sizes
  xs: 11,
  sm: 12,
  base: 13,
  md: 14,

  // Font weights
  normal: 400,
  medium: 500,
  semibold: 600,
  bold: 700,

  // Line heights
  lhTight: 1.3,
  lhBase: 1.5,
} as const;

export const R = {
  sm: 4,
  md: 6,
  lg: 8,
} as const;

/** Returns a combined style object, filtering out undefined values. */
export function sx(...styles: (StyleObj | undefined | false)[]): StyleObj {
  const out: Record<string, unknown> = {};
  for (const s of styles) {
    if (s && typeof s === 'object') Object.assign(out, s);
  }
  return out as StyleObj;
}

// Shared reusable style fragments
export const S = {
  // Row of small muted metadata chips
  metaRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    fontSize: T.xs,
    color: C.secondary,
    padding: '3px 0',
  } as StyleObj,

  // Standard thin separator
  divider: {
    borderTop: `1px solid ${C.border}`,
    margin: '6px 0',
  } as StyleObj,

  // Section container
  section: {
    border: `1px solid ${C.border}`,
    borderRadius: R.md,
    margin: '8px 0',
    background: C.surface,
    overflow: 'hidden',
  } as StyleObj,

  // Section summary/header bar
  sectionHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '7px 10px',
    background: C.bg,
    borderBottom: `1px solid ${C.border}`,
    cursor: 'pointer',
    fontSize: T.sm,
    fontWeight: T.semibold,
    color: C.strong,
  } as StyleObj,

  // Section body
  sectionBody: {
    padding: '8px 12px 10px',
    fontSize: T.sm,
    lineHeight: T.lhBase,
    color: C.body,
  } as StyleObj,

  // Inline status dot
  dot: (color: string): StyleObj => ({
    display: 'inline-block',
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: color,
    flexShrink: 0,
  }),

  // Primary button
  btnPrimary: {
    background: C.accent,
    color: '#fff',
    border: 'none',
    borderRadius: R.sm,
    padding: '6px 14px',
    fontSize: T.base,
    fontWeight: T.medium,
    cursor: 'pointer',
    lineHeight: 1,
  } as StyleObj,

  // Secondary/ghost button
  btnSecondary: {
    background: 'transparent',
    color: C.body,
    border: `1px solid ${C.borderMid}`,
    borderRadius: R.sm,
    padding: '5px 12px',
    fontSize: T.sm,
    fontWeight: T.medium,
    cursor: 'pointer',
    lineHeight: 1,
  } as StyleObj,

  // Danger button
  btnDanger: {
    background: C.error,
    color: '#fff',
    border: 'none',
    borderRadius: R.sm,
    padding: '5px 12px',
    fontSize: T.sm,
    fontWeight: T.medium,
    cursor: 'pointer',
    lineHeight: 1,
  } as StyleObj,

  // Small label / tag
  tag: (color: string, bg: string): StyleObj => ({
    display: 'inline-flex',
    alignItems: 'center',
    padding: '1px 6px',
    borderRadius: 100,
    fontSize: T.xs,
    fontWeight: T.medium,
    color,
    background: bg,
  }),

  // Code / mono text
  mono: {
    fontFamily: 'ui-monospace, "SFMono-Regular", Consolas, monospace',
    fontSize: T.xs,
  } as StyleObj,

  // Muted caption
  caption: {
    fontSize: T.xs,
    color: C.muted,
  } as StyleObj,
} as const;
