// phase_2_spine.md §7 (T-2.29, FR-5) — a `report` action's content, rendered as-is. Placeholder
// resolution (design.md §13.2's "Done" state: "placeholders resolved locally") is Phase 3's job —
// Phase 2 has no placeholders to resolve, so this renders exactly what the model sent.
export interface ReportViewProps {
  title?: string;
  content: string;
}

export function ReportView({ title, content }: ReportViewProps) {
  return (
    <section style={{ border: '1px solid #ccc', borderRadius: 4, padding: 8, marginTop: 8 }}>
      {title && <h4 style={{ margin: '0 0 4px' }}>{title}</h4>}
      <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{content}</p>
    </section>
  );
}
