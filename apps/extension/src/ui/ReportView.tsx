// phase_2_spine.md §7 (T-2.29, FR-5) — a `report` action's content, rendered as-is.
// Redesigned: clean card presentation with subtle border and crisp typography.
import { C, R, T } from './design';

export interface ReportViewProps {
  title?: string;
  content: string;
}

export function ReportView({ title, content }: ReportViewProps) {
  return (
    <section
      style={{
        border: `1px solid ${C.border}`,
        borderRadius: R.sm,
        padding: '10px 12px',
        marginTop: 8,
        background: C.surface,
      }}
    >
      {title && (
        <h4 style={{ margin: '0 0 6px', fontSize: T.sm, fontWeight: 600, color: C.strong }}>
          {title}
        </h4>
      )}
      <p style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: T.sm, color: C.body, lineHeight: 1.45 }}>
        {content}
      </p>
    </section>
  );
}
