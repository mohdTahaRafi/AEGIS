// A one-off message on the main view (an error before or after a task, a pause waiting for the
// user). Errors arrive as "CODE - explanation" (main.tsx `describeStop` and the start checks); the
// code becomes a plain title and stays visible, small, for support and the logs.

import type { ComponentChildren } from 'preact';
import { IconAlert, IconClock, IconInfo } from './icons';
import { C, R, T } from './design';

type Tone = 'error' | 'warn' | 'info';

const TONE: Record<Tone, { fg: string; bg: string; border: string }> = {
  error: { fg: C.error, bg: C.errorBg, border: C.errorBorder },
  warn: { fg: C.warn, bg: C.warnBg, border: C.warnBorder },
  info: { fg: C.info, bg: C.infoBg, border: C.infoBorder },
};

export function Notice({
  tone,
  title,
  code,
  children,
  testId,
}: {
  tone: Tone;
  title?: string;
  code?: string;
  children?: ComponentChildren;
  testId?: string;
}) {
  const t = TONE[tone];
  const Icon = tone === 'warn' ? IconClock : tone === 'info' ? IconInfo : IconAlert;
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      data-testid={testId}
      style={{
        display: 'flex',
        gap: 9,
        alignItems: 'flex-start',
        border: `1px solid ${t.border}`,
        background: t.bg,
        borderRadius: R.lg,
        padding: '9px 12px',
        margin: '10px 0',
        fontSize: T.sm,
        lineHeight: 1.45,
      }}
    >
      <span style={{ color: t.fg, marginTop: 1 }}>
        <Icon size={15} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {(title || code) && (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: children ? 2 : 0 }}>
            {title && <span style={{ fontWeight: 600, color: t.fg }}>{title}</span>}
            {code && (
              <code style={{ marginLeft: 'auto', fontSize: 10, color: C.secondary, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace' }}>{code}</code>
            )}
          </div>
        )}
        {children && <div style={{ color: C.body, overflowWrap: 'anywhere' }}>{children}</div>}
      </div>
    </div>
  );
}

const TITLES: Record<string, string> = {
  API_KEY_MISSING: 'Add an API key first',
  API_KEY_REJECTED: 'Your API key was rejected',
  DAILY_LIMIT_REACHED: "Today's free limit is used up",
  NO_ACTIVE_TAB: 'No tab to work on',
  UNSUPPORTED_PAGE: "AEGIS can't run on this page",
  PAGE_NOT_CONNECTED: "AEGIS can't reach this page",
  GATEWAY_REJECTED_TOKEN: 'The gateway refused the access token',
  GATEWAY_SESSION_FAILED: 'The gateway could not start a session',
  GATEWAY_UNREACHABLE: 'The gateway is not reachable',
  CANCELLED: 'You stopped the task',
  INTERNAL_ERROR: 'Something went wrong inside AEGIS',
  SERVER_ERROR: 'The model did not answer',
  SERVER_TIMEOUT: 'The model took too long to answer',
  MODEL_STOPPED: 'The model ended the task',
  PAGE_DISCONNECTED: 'The page was disconnected',
  USER_DECLINED: 'You declined an action',
  NEEDS_USER: 'The task needs you to continue',
  VISION_UNAVAILABLE: 'On-device vision is unavailable',
  RECOVERY_EXHAUSTED: 'The task kept failing and was ended',
  BLOCKED: 'The privacy guard ended the task',
  STEPS_EXCEEDED: 'The task reached its step limit',
  SERVER_CALLS_EXCEEDED: 'Too many model calls for one step',
  SETTLE_TIMEOUT: 'The page did not settle in time',
  WALL_CLOCK_EXCEEDED: 'The task reached its time limit',
  BUDGET_EXHAUSTED: 'The task reached its limits',
};

/** Splits "API_KEY_REJECTED - Groq refused…" / "SERVER_ERROR: upstream_429 - …" into a plain title,
 * the code, and the explanation. A message with no leading code is returned as the body only. */
export function describeError(message: string): { title: string; code?: string; body: string } {
  const m = /^([A-Z][A-Z0-9_]{2,})( \((?:HTTP )?\d+\))?(?: - |: |$)([\s\S]*)$/.exec(message);
  if (!m) return { title: 'Something went wrong', body: message };
  const code = `${m[1]}${m[2] ?? ''}`;
  const fallback = m[1]!.charAt(0) + m[1]!.slice(1).toLowerCase().replace(/_/g, ' ');
  const body = m[3]!.trim();
  return { title: TITLES[m[1]!] ?? fallback, code, body: body.charAt(0).toUpperCase() + body.slice(1) };
}

export function ErrorNotice({ message }: { message: string }) {
  const e = describeError(message);
  return (
    <Notice tone="error" title={e.title} code={e.code}>
      {e.body || undefined}
    </Notice>
  );
}
