// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { panelStateLabel, type PanelState } from '../../src/ui/PanelStates';
import { TaskInput } from '../../src/ui/TaskInput';
import { StepTimeline } from '../../src/ui/StepTimeline';
import { MetricsBar } from '../../src/ui/MetricsBar';
import { ReportView } from '../../src/ui/ReportView';
import { ConfirmAction } from '../../src/ui/ConfirmAction';
import { GuardBlockCard } from '../../src/ui/GuardBlockCard';
import { GrantRequest } from '../../src/ui/GrantRequest';
import { RedactionSummary } from '../../src/ui/RedactionSummary';
import { PayloadViewer } from '../../src/ui/PayloadViewer';
import { ResourceBar } from '../../src/ui/ResourceBar';
import type { StepRecord } from '../../src/host/session';
import type { SanitizedContext } from '@aegis/protocol';

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

const ALL_PANEL_STATES: PanelState[] = [
  'no-permission',
  'loading',
  'idle',
  'running',
  'awaiting-confirmation',
  'awaiting-grant',
  'blocked',
  'error',
  'done',
];

describe('PanelStates (T-2.30 / T-3.31 / T-3.34 AC — eight states, visually distinct)', () => {
  it('every one of design.md §13.2\'s states has a distinct label', () => {
    const labels = ALL_PANEL_STATES.map(panelStateLabel);
    expect(new Set(labels).size).toBe(ALL_PANEL_STATES.length);
  });
});

describe('ConfirmAction (T-3.31 AC)', () => {
  it('renders the description and risk level, and calls onDecide(true) on Allow once', () => {
    const onDecide = vi.fn();
    const el = mount(<ConfirmAction risk="high" description="Type Aadhaar into field X?" onDecide={onDecide} />);
    expect(el.textContent).toContain('Type Aadhaar into field X?');
    expect(el.textContent).toContain('high risk');
    const [allow] = el.querySelectorAll('button');
    allow!.dispatchEvent(new Event('click', { bubbles: true }));
    expect(onDecide).toHaveBeenCalledWith(true);
  });

  it('calls onDecide(false) on Deny', () => {
    const onDecide = vi.fn();
    const el = mount(<ConfirmAction risk="medium" description="desc" onDecide={onDecide} />);
    const [, deny] = el.querySelectorAll('button');
    deny!.dispatchEvent(new Event('click', { bubbles: true }));
    expect(onDecide).toHaveBeenCalledWith(false);
  });
});

describe('GuardBlockCard (T-3.34 AC)', () => {
  it('shows the rule and entity, and wires Retry/Stop', () => {
    const onRetry = vi.fn();
    const onStop = vi.fn();
    const el = mount(<GuardBlockCard rule="VAULT_LEAK" entity="AADHAAR" count={1} onRetry={onRetry} onStop={onStop} />);
    expect(el.textContent).toContain('VAULT_LEAK');
    expect(el.textContent).toContain('AADHAAR');
    const [retry, stop] = el.querySelectorAll('button');
    retry!.dispatchEvent(new Event('click', { bubbles: true }));
    stop!.dispatchEvent(new Event('click', { bubbles: true }));
    expect(onRetry).toHaveBeenCalled();
    expect(onStop).toHaveBeenCalled();
  });
});

describe('RedactionSummary (T-3.33 AC)', () => {
  it('shows counts by entity and the coverage triple', () => {
    const el = mount(
      <RedactionSummary
        redactions={[
          { ref: '⟪AADHAAR#1⟫', entity: 'AADHAAR', class: 'CRITICAL', boxes: [], method: 'placeholder', confidence: 0.95, sources: [], unverified: false } as never,
          { ref: null, entity: 'PASSWORD', class: 'CRITICAL', boxes: [], method: 'placeholder', confidence: 1, sources: [], unverified: false } as never,
        ]}
        coverage={{ cleared: 0.8, redacted: 0.2, unanalysed: 0 }}
      />,
    );
    expect(el.textContent).toContain('AADHAAR 1');
    expect(el.textContent).toContain('PASSWORD 1');
    expect(el.textContent).toContain('80%');
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

function fakePayload(): SanitizedContext {
  return {
    schema: 'AEGIS/1',
    step_id: 's-1',
    task: 'log in',
    reason: 'initial',
    viewport: { w: 800, h: 600, dpr: 1, scroll_y: 0, doc_h: 600 },
    page: { category: 'unknown', title: 'Test' },
    nodes: [],
    text: [],
    redactions: [{ ref: '⟪AADHAAR#1⟫', entity: 'AADHAAR', class: 'CRITICAL', boxes: [], method: 'placeholder', confidence: 0.95, sources: [], unverified: false }] as never,
    unexplained: [],
    coverage: { cleared: 1, redacted: 0, unanalysed: 0 },
    image: null,
    history: [],
    client_timing: {},
  };
}

describe('PayloadViewer (T-3.32, FR-34, AC-9)', () => {
  it('the exact bytes are hidden until the toggle is pressed', async () => {
    const el = mount(<PayloadViewer payload={fakePayload()} />);
    expect(el.textContent).not.toContain('⟪AADHAAR#1⟫');
    const button = el.querySelector('button')!;
    button.dispatchEvent(new Event('click', { bubbles: true }));
    await Promise.resolve(); // flush Preact's microtask-scheduled re-render
    expect(el.textContent).toContain('⟪AADHAAR#1⟫');
    expect(el.textContent).toContain('"schema": "AEGIS/1"');
  });

  it('T-4.22: shows the composed image alongside the bytes when one was sent', async () => {
    const payload = fakePayload();
    payload.image = { level: 'L1', region: [0, 0, 100, 100], scale: 1, format: 'image/webp', sha256: 'a'.repeat(64), data: 'ZmFrZQ==', legend: 'Grey = unanalysed.' };
    const el = mount(<PayloadViewer payload={payload} />);
    const button = el.querySelector('button')!;
    button.dispatchEvent(new Event('click', { bubbles: true }));
    await Promise.resolve();
    const img = el.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('data:image/webp;base64,ZmFrZQ==');
    expect(el.textContent).toContain('Grey = unanalysed.');
  });

  it('renders no image element when payload.image is null (the common L0 case)', async () => {
    const el = mount(<PayloadViewer payload={fakePayload()} />);
    const button = el.querySelector('button')!;
    button.dispatchEvent(new Event('click', { bubbles: true }));
    await Promise.resolve();
    expect(el.querySelector('img')).toBeNull();
  });
});

describe('ResourceBar (T-4.22/T-4.23)', () => {
  it('shows the ML backend and total model MB', () => {
    const el = mount(<ResourceBar backend="webgpu" modelsLoadedMB={21.4} />);
    expect(el.textContent).toContain('webgpu');
    expect(el.textContent).toContain('21.4');
  });

  it('shows "not loaded" before the worker has reported a backend', () => {
    const el = mount(<ResourceBar backend={null} modelsLoadedMB={0} />);
    expect(el.textContent).toContain('not loaded');
  });
});

describe('GrantRequest — the step waits for a real toolbar invocation, never silently DOM-only', () => {
  it('explains a grant lost on a cross-site navigation with both origins, and offers waive/stop', () => {
    const onContinueWithout = vi.fn();
    const onStop = vi.fn();
    const el = mount(
      <GrantRequest
        explanation={{ kind: 'lost-on-navigation', grantedOrigin: 'https://www.practo.com', currentOrigin: 'https://accounts.practo.com' }}
        onContinueWithout={onContinueWithout}
        onStop={onStop}
      />,
    );
    expect(el.textContent).toContain('https://www.practo.com');
    expect(el.textContent).toContain('https://accounts.practo.com');
    expect(el.textContent).toContain('AEGIS icon in Chrome');
    expect(el.textContent).toContain('Nothing has been sent for this step yet');
    const buttons = [...el.querySelectorAll('button')];
    buttons.find((b) => b.textContent === 'Continue without screenshots')!.click();
    buttons.find((b) => b.textContent === 'Stop')!.click();
    expect(onContinueWithout).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('has no "allow" button of its own — a click in the panel cannot grant activeTab', () => {
    const el = mount(<GrantRequest explanation={{ kind: 'never-invoked' }} onContinueWithout={() => {}} onStop={() => {}} />);
    expect([...el.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Continue without screenshots', 'Stop']);
  });
});
