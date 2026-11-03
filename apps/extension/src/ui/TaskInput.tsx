// phase_2_spine.md §7 (T-2.26) — natural-language task input, start/stop.
// One bordered box: the task text on top, the keyboard hint and the Run / Stop action below it.
import { useState } from 'preact/hooks';
import { IconSpinner } from './icons';
import { C, R, S, T } from './design';

export interface TaskInputProps {
  running: boolean;
  disabled?: boolean;
  onStart: (task: string) => void;
  onStop: () => void;
  /** The text, when the owner keeps it (the panel saves it so a closed panel does not lose it). */
  value?: string;
  onValueChange?: (text: string) => void;
}

export function TaskInput({ running, disabled, onStart, onStop, value, onValueChange }: TaskInputProps) {
  const [ownTask, setOwnTask] = useState('');
  const task = value ?? ownTask;
  const setTask = (text: string) => {
    setOwnTask(text);
    onValueChange?.(text);
  };

  const canSubmit = !disabled && task.trim().length > 0;

  // Enter runs; Shift+Enter starts a new line (a complex task is often several sentences).
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!running && canSubmit) onStart(task.trim());
    }
  };

  const locked = running || disabled;

  return (
    <div
      class="ag-taskbox"
      style={{
        border: `1px solid ${C.borderMid}`,
        borderRadius: R.lg,
        background: locked ? C.bg : C.white,
        margin: '12px 0 10px',
        transition: 'border-color 0.12s ease, box-shadow 0.12s ease',
      }}
    >
      <textarea
        value={task}
        disabled={locked}
        rows={Math.min(6, Math.max(3, task.split('\n').length))}
        placeholder="What should AEGIS do on this page? e.g. Find the 3 cheapest 1 TB SSDs here and compare them"
        onInput={(e) => setTask((e.target as HTMLTextAreaElement).value)}
        onKeyDown={handleKeyDown}
        aria-label="Task"
        style={{
          display: 'block',
          width: '100%',
          padding: '10px 12px 4px',
          fontSize: T.md,
          fontFamily: 'inherit',
          lineHeight: 1.45,
          resize: 'none',
          border: 'none',
          background: 'transparent',
          color: C.strong,
          outline: 'none',
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px 8px 12px' }}>
        <span style={{ fontSize: T.xs, color: C.muted, flex: 1, minWidth: 0 }}>
          {running ? 'Working on your task…' : disabled ? 'Add an API key above to start' : 'Enter to run · Shift+Enter for a new line'}
        </span>
        {running ? (
          <button
            class="ag-danger"
            onClick={onStop}
            aria-label="Stop task"
            style={{
              ...S.btnSecondary,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              color: C.error,
              borderColor: C.errorBorder,
              background: C.errorBg,
              padding: '7px 14px',
              fontSize: T.sm,
            }}
          >
            <IconSpinner size={12} />
            Stop
          </button>
        ) : (
          <button
            class="ag-primary"
            onClick={() => canSubmit && onStart(task.trim())}
            disabled={!canSubmit}
            aria-label="Run task"
            style={{
              ...S.btnPrimary,
              padding: '8px 20px',
              fontSize: T.sm,
              fontWeight: 600,
              opacity: !canSubmit ? 0.4 : 1,
              cursor: !canSubmit ? 'not-allowed' : 'pointer',
            }}
          >
            Run
          </button>
        )}
      </div>
    </div>
  );
}
