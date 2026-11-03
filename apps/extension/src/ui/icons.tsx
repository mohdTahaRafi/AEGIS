// The panel's few icons, drawn inline (no icon font or network fetch). Stroke icons follow
// `currentColor` so they take the text colour of wherever they sit.
import type { JSX } from 'preact';

type IconProps = { size?: number; color?: string; class?: string; style?: JSX.CSSProperties };

function Stroke({ size = 14, color, class: cls, style, children }: IconProps & { children: JSX.Element | JSX.Element[] }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color ?? 'currentColor'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      class={cls}
      style={{ flexShrink: 0, ...style }}
    >
      {children}
    </svg>
  );
}

export const IconCheck = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M20 6L9 17l-5-5" />
  </Stroke>
);

export const IconX = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M18 6L6 18M6 6l12 12" />
  </Stroke>
);

export const IconMinus = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M5 12h14" />
  </Stroke>
);

export const IconChevron = (p: IconProps) => (
  <Stroke {...p} class={`ag-chev ${p.class ?? ''}`}>
    <path d="M9 18l6-6-6-6" />
  </Stroke>
);

export const IconAlert = (p: IconProps) => (
  <Stroke {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 8v4M12 16h.01" />
  </Stroke>
);

export const IconInfo = (p: IconProps) => (
  <Stroke {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4M12 8h.01" />
  </Stroke>
);

export const IconClock = (p: IconProps) => (
  <Stroke {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 6v6l4 2" />
  </Stroke>
);

export const IconShield = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </Stroke>
);

export const IconGear = (p: IconProps) => (
  <Stroke {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
  </Stroke>
);

export const IconSpinner = ({ size = 14, color }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" class="ag-spin" style={{ flexShrink: 0 }}>
    <circle cx="12" cy="12" r="9" stroke={color ?? 'currentColor'} strokeOpacity="0.2" strokeWidth="3" />
    <path d="M21 12a9 9 0 00-9-9" stroke={color ?? 'currentColor'} strokeWidth="3" strokeLinecap="round" />
  </svg>
);
