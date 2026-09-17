// phase_2_spine.md §7 (T-2.26) — natural-language task input, start/stop (FR-3: stop must be
// effective mid-step, not just between steps — enforced by src/host/session.ts's `cancel()`
// calling straight into the controller, which aborts an in-flight server request immediately
// (T-2.18), not by anything queued here).
import { useState } from 'preact/hooks';

export interface TaskInputProps {
  running: boolean;
  disabled?: boolean;
  onStart: (task: string) => void;
  onStop: () => void;
}

export function TaskInput({ running, disabled, onStart, onStop }: TaskInputProps) {
  const [task, setTask] = useState('');

  return (
    <div style={{ display: 'flex', gap: 6, padding: '8px 0' }}>
      <input
        type="text"
        value={task}
        disabled={running || disabled}
        placeholder="e.g. log in and submit the form"
        onInput={(e) => setTask((e.target as HTMLInputElement).value)}
        style={{ flex: 1, padding: 6 }}
        aria-label="Task"
      />
      {running ? (
        <button onClick={onStop} aria-label="Stop task">
          Stop
        </button>
      ) : (
        <button onClick={() => task.trim() && onStart(task.trim())} disabled={disabled || task.trim().length === 0} aria-label="Run task">
          Run
        </button>
      )}
    </div>
  );
}
