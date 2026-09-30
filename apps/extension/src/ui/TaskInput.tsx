// phase_2_spine.md §7 (T-2.26) — natural-language task input, start/stop.
// Redesigned: compact, professional input bar with clear keyboard support and distinct actions.
import { useState } from 'preact/hooks';
import { C, R, S, T } from './design';

export interface TaskInputProps {
  running: boolean;
  disabled?: boolean;
  onStart: (task: string) => void;
  onStop: () => void;
}

export function TaskInput({ running, disabled, onStart, onStop }: TaskInputProps) {
  const [task, setTask] = useState('');

  const canSubmit = !disabled && task.trim().length > 0;

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !running && canSubmit) {
      onStart(task.trim());
    }
  };

  return (
    <div style={{ display: 'flex', gap: 6, padding: '8px 0', alignItems: 'center' }}>
      <input
        type="text"
        value={task}
        disabled={running || disabled}
        placeholder="e.g. log in and submit the form"
        onInput={(e) => setTask((e.target as HTMLInputElement).value)}
        onKeyDown={handleKeyDown}
        aria-label="Task"
        style={{
          flex: 1,
          padding: '7px 10px',
          fontSize: T.base,
          border: `1px solid ${C.border}`,
          borderRadius: R.sm,
          background: running || disabled ? C.bg : C.white,
          color: C.strong,
          outline: 'none',
          minWidth: 0,
        }}
      />
      {running ? (
        <button
          onClick={onStop}
          aria-label="Stop task"
          style={{
            ...S.btnSecondary,
            color: C.error,
            borderColor: C.errorBorder,
            background: C.errorBg,
            flexShrink: 0,
            padding: '7px 14px',
            fontSize: T.sm,
            fontWeight: 500,
          }}
        >
          Stop
        </button>
      ) : (
        <button
          onClick={() => canSubmit && onStart(task.trim())}
          disabled={!canSubmit}
          aria-label="Run task"
          style={{
            ...S.btnPrimary,
            flexShrink: 0,
            padding: '7px 16px',
            fontSize: T.sm,
            fontWeight: 500,
            opacity: !canSubmit ? 0.45 : 1,
            cursor: !canSubmit ? 'not-allowed' : 'pointer',
          }}
        >
          Run
        </button>
      )}
    </div>
  );
}
