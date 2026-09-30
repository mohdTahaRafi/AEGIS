// The model's `ask_user`: its question, and a box for the answer.
// Redesigned: compact, clean input prompt card with clear actions.

import { useState } from 'preact/hooks';
import { C, R, S, T } from './design';

export interface AskUserProps {
  question: string;
  onAnswer: (answer: string | null) => void;
}

export function AskUser({ question, onAnswer }: AskUserProps) {
  const [answer, setAnswer] = useState('');
  const canContinue = answer.trim().length > 0;

  return (
    <div
      role="dialog"
      data-testid="ask-user"
      style={{
        border: `1px solid ${C.infoBorder}`,
        borderLeft: `3px solid ${C.accent}`,
        borderRadius: R.md,
        padding: '10px 12px',
        margin: '8px 0',
        background: C.infoBg,
      }}
    >
      <div style={{ fontSize: T.sm, fontWeight: 600, color: C.strong, marginBottom: 4 }}>
        AEGIS needs your input
      </div>
      <p style={{ margin: '0 0 8px', fontSize: T.sm, color: C.body, lineHeight: 1.4 }}>{question}</p>
      <textarea
        value={answer}
        onInput={(e) => setAnswer((e.target as HTMLTextAreaElement).value)}
        rows={2}
        placeholder="Type your response..."
        style={{
          width: '100%',
          boxSizing: 'border-box',
          padding: '6px 8px',
          fontSize: T.sm,
          border: `1px solid ${C.borderMid}`,
          borderRadius: R.sm,
          background: C.white,
          color: C.strong,
          resize: 'vertical',
          outline: 'none',
        }}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
        <button
          disabled={!canContinue}
          onClick={() => canContinue && onAnswer(answer)}
          style={{
            ...S.btnPrimary,
            fontSize: T.sm,
            padding: '5px 12px',
            opacity: !canContinue ? 0.45 : 1,
            cursor: !canContinue ? 'not-allowed' : 'pointer',
          }}
        >
          Continue
        </button>
        <button
          onClick={() => onAnswer(null)}
          style={{
            ...S.btnSecondary,
            fontSize: T.sm,
            padding: '5px 12px',
          }}
        >
          Skip (end task)
        </button>
      </div>
    </div>
  );
}
