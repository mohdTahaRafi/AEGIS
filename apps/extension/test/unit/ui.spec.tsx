// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GuardStubBanner, panelStateLabel, type PanelState } from '../../src/ui/PanelStates';
import { TaskInput } from '../../src/ui/TaskInput';
import { StepTimeline } from '../../src/ui/StepTimeline';
import { MetricsBar } from '../../src/ui/MetricsBar';
import { ReportView } from '../../src/ui/ReportView';
import type { StepRecord } from '../../src/host/session';

let container: HTMLDivElement;

afterEach(() => {
  if (container) render(null, container);
});

function mount(vnode: preact.ComponentChild): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  render(vnode, container);
  return container;
}

const ALL_PANEL_STATES: PanelState[] = ['no-permission', 'loading', 'idle', 'running', 'error', 'done'];

describe('PanelStates (T-2.30 AC — six states, visually distinct)', () => {
  it('every one of the six design.md §13.2 states Phase 2 scopes in has a distinct label', () => {
    const labels = ALL_PANEL_STATES.map(panelStateLabel);
    expect(new Set(labels).size).toBe(6);
  });

  it('renders the mandated Phase-2 guard-stub banner text', () => {
    const el = mount(<GuardStubBanner />);
    expect(el.textContent).toContain('PHASE 2 BUILD — NO REDACTION');
  });
});

describe('TaskInput (T-2.26 AC)', () => {
  it('shows a Run button when idle and calls onStart with the trimmed task text', async () => {
    const onStart = vi.fn();
    const el = mount(<TaskInput running={false} onStart={onStart} onStop={() => {}} />);
    const input = el.querySelector('input')!;
    input.value = '  log in and submit  ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve(); // flush Preact's microtask-scheduled re-render before reading the button's closure
    const runButton = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Run')!;
    runButton.click();
    expect(onStart).toHaveBeenCalledWith('log in and submit');
  });

  it('shows a Stop button while running, and disables the input', () => {
    const onStop = vi.fn();
    const el = mount(<TaskInput running={true} onStart={() => {}} onStop={onStop} />);
    const stopButton = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Stop')!;
    stopButton.click();
    expect(onStop).toHaveBeenCalled();
    expect(el.querySelector('input')!.disabled).toBe(true);
  });
});

function step(overrides: Partial<StepRecord> = {}): StepRecord {
  return {
    stepIndex: 1,
    stepId: 's-1',
    stageTimings: { observe: 7, perceive: 0, sanitize: 1, guard: 0, server: 640, validate: 2, act: 9 },
    actionsPlanned: 2,
    outcome: 'acted',
    ...overrides,
  };
}

describe('StepTimeline (T-2.27 AC — per-stage timings sum to the step total)', () => {
  it('shows a placeholder with no steps', () => {
    const el = mount(<StepTimeline steps={[]} />);
    expect(el.textContent).toContain('No steps yet');
  });

  it('renders every stage and a total for each step', () => {
    const el = mount(<StepTimeline steps={[step()]} />);
    expect(el.textContent).toContain('Step 1');
    expect(el.textContent).toContain('acted');
    expect(el.textContent).toContain('659 ms'); // 7+0+1+0+640+2+9
    for (const stage of ['observe', 'perceive', 'sanitize', 'guard', 'server', 'validate', 'act']) {
      expect(el.textContent).toContain(stage);
    }
  });
});

describe('MetricsBar (T-2.28 AC — updates live)', () => {
  it('shows "—" for last step latency with no steps yet', () => {
    const el = mount(<MetricsBar backend="not connected" steps={[]} />);
    expect(el.textContent).toContain('backend: not connected');
    expect(el.textContent).toContain('last step: —');
  });

  it('reflects the latest step once one lands', () => {
    const el = mount(<MetricsBar backend="live" steps={[step()]} />);
    expect(el.textContent).toContain('backend: live');
    expect(el.textContent).toContain('last step: 659 ms');
  });
});

describe('ReportView (T-2.29 AC — FR-5)', () => {
  it('renders a report action\'s content and optional title', () => {
    const el = mount(<ReportView title="Summary" content="Logged in as Ramesh Kumar" />);
    expect(el.textContent).toContain('Summary');
    expect(el.textContent).toContain('Logged in as Ramesh Kumar');
  });

  it('renders content with no title', () => {
    const el = mount(<ReportView content="Done" />);
    expect(el.textContent).toContain('Done');
  });
});
