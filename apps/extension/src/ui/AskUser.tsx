// The model's `ask_user`: its question, and a box for the answer. Continue resumes the task with
// the answer (it joins the task text, sanitized like the rest of the task); Skip ends it.

import { useState } from 'preact/hooks';

export interface AskUserProps {
  question: string;
  onAnswer: (answer: string | null) => void;
}

export function AskUser({ question, onAnswer }: AskUserProps) {
  const [answer, setAnswer] = useState('');
  return (
    <div role="dialog" data-testid="ask-user" style={{ border: '2px solid #2563eb', borderRadius: 6, padding: 10, margin: '8px 0', background: '#eff6ff' }}>
      <p style={{ margin: '0 0 6px', fontWeight: 600 }}>AEGIS needs your input</p>
      <p style={{ margin: '0 0 8px' }}>{question}</p>
      <textarea value={answer} onInput={(e) => setAnswer((e.target as HTMLTextAreaElement).value)} rows={2} style={{ width: '100%', boxSizing: 'border-box' }} />
      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        <button disabled={!answer.trim()} onClick={() => onAnswer(answer)}>
          Continue
        </button>
        <button onClick={() => onAnswer(null)}>Skip (end task)</button>
      </div>
    </div>
  );
}
