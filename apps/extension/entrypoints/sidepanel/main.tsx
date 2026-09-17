import { render } from 'preact';
import { useState } from 'preact/hooks';
import { ContentPortClient, connectToTab } from '../../src/host/port';
import { ensureHostPermission } from '../../src/host/platform/capabilities';
import { createGatewayClient } from '../../src/host/egress/gateway-client';
import { Session, type SessionEvent, type StepRecord } from '../../src/host/session';
import { panelStateLabel, type PanelState } from '../../src/ui/PanelStates';
import { TaskInput } from '../../src/ui/TaskInput';
import { StepTimeline } from '../../src/ui/StepTimeline';
import { MetricsBar } from '../../src/ui/MetricsBar';
import { ReportView } from '../../src/ui/ReportView';
import { ConfirmAction } from '../../src/ui/ConfirmAction';
import { GuardBlockCard } from '../../src/ui/GuardBlockCard';
import { PayloadViewer } from '../../src/ui/PayloadViewer';
import { RedactionSummary } from '../../src/ui/RedactionSummary';
import type { SanitizedContext } from '@aegis/protocol';

// phase_2_spine.md §6.7's demo default; overridable at build time (design.md §13.5's "Server URL"
// setting — a real settings UI is not built this phase, so this is the one place it lives).
const GATEWAY_URL = (import.meta.env.VITE_GATEWAY_URL as string | undefined) ?? 'http://localhost:8787';

function App() {
  const [panelState, setPanelState] = useState<PanelState>('idle');
  const [steps, setSteps] = useState<StepRecord[]>([]);
  const [report, setReport] = useState<{ title?: string; content: string } | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [lastPayload, setLastPayload] = useState<SanitizedContext | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<{ risk: 'low' | 'medium' | 'high'; description: string; resolve: (v: boolean) => void } | null>(null);
  const [guardBlock, setGuardBlock] = useState<{ rule: string; entity?: string } | null>(null);

  function handleSessionEvent(event: SessionEvent, activeSession: Session): void {
    if (event.type === 'step') {
      setSteps((prev) => [...prev, event.step]);
      const latest = activeSession.getLedger().latest();
      if (latest) setLastPayload(latest.payload);
    } else if (event.type === 'report') {
      setReport({ title: event.title, content: event.content });
    } else if (event.type === 'done') {
      setPanelState('done');
      if (event.summary) setReport({ content: event.summary });
    } else if (event.type === 'guard_blocked') {
      setPanelState('blocked');
      setGuardBlock({ rule: event.rule, entity: event.entity });
    } else if (event.type === 'confirmation_required') {
      setPanelState('awaiting-confirmation');
      // The Promise this creates is handed to Session via `confirm` below — see handleStart.
    } else if (event.type === 'stopped') {
      setPanelState(event.reason === 'CANCELLED' ? 'idle' : 'error');
      if (event.reason !== 'CANCELLED') setErrorMessage(event.reason);
    }
  }

  async function handleStart(task: string): Promise<void> {
    setErrorMessage(null);
    setReport(null);
    setSteps([]);
    setLastPayload(null);
    setGuardBlock(null);
    setPanelState('loading');

    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) {
      setPanelState('error');
      setErrorMessage('NO_ACTIVE_TAB');
      return;
    }

    const origin = new URL(tab.url).origin;
    const permissionState = await ensureHostPermission(browser.permissions, origin);
    if (permissionState === 'denied') {
      setPanelState('no-permission');
      return;
    }

    const gateway = createGatewayClient(GATEWAY_URL, import.meta.env.BROWSER === 'firefox' ? 'firefox' : 'chrome');
    let created;
    try {
      created = await gateway.openSession();
    } catch {
      setPanelState('error');
      setErrorMessage('GATEWAY_UNREACHABLE');
      return;
    }

    const port = connectToTab(browser.tabs, tab.id);
    // Forward reference: ContentPortClient needs its handlers now, Session needs the constructed
    // ContentPortClient — see test/unit/session.spec.ts's buildSession() for the same pattern.
    // eslint-disable-next-line prefer-const
    let newSession!: Session;
    const contentPort = new ContentPortClient(port, {
      onGraph: (m) => newSession.onGraph(m),
      onActionResult: (m) => newSession.onActionResult(m.actionId, m.ok, m.reason),
      onDisconnect: () => setPanelState('error'),
    });
    newSession = new Session({
      contentPort,
      sendToGateway: (payload, signal) => gateway.sendStep(created.session_id, payload, signal),
      guardOrigin: origin,
      pageCategory: 'unknown',
      pageTitle: tab.title ?? '',
      onEvent: (event) => handleSessionEvent(event, newSession),
      confirm: (risk, description) =>
        new Promise<boolean>((resolve) => {
          setConfirmRequest({ risk, description, resolve });
        }),
    });

    setSession(newSession);
    setPanelState('running');
    await newSession.start(task);
    await gateway.closeSession(created.session_id);
  }

  function handleStop(): void {
    session?.cancel();
  }

  function handleConfirmDecision(allowed: boolean): void {
    confirmRequest?.resolve(allowed);
    setConfirmRequest(null);
    setPanelState('running');
  }

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', fontSize: 13, maxWidth: 480 }}>
      <div style={{ padding: 12 }}>
        <h2 style={{ margin: '0 0 4px' }}>AEGIS</h2>
        <p style={{ color: '#666', margin: '0 0 8px' }}>{panelStateLabel(panelState)}</p>

        {panelState === 'no-permission' && (
          <p style={{ color: '#b00' }}>This site needs host permission before AEGIS can run a task here. Try Run again to be prompted.</p>
        )}
        {panelState === 'error' && errorMessage && <p style={{ color: '#b00' }}>Error: {errorMessage}</p>}

        <TaskInput running={panelState === 'running' || panelState === 'loading'} onStart={handleStart} onStop={handleStop} />

        {confirmRequest && <ConfirmAction risk={confirmRequest.risk} description={confirmRequest.description} onDecide={handleConfirmDecision} />}
        {guardBlock && (
          <GuardBlockCard
            rule={guardBlock.rule}
            entity={guardBlock.entity}
            count={1}
            onRetry={() => setGuardBlock(null)}
            onStop={() => {
              setGuardBlock(null);
              session?.cancel();
            }}
          />
        )}

        <MetricsBar backend="not connected" steps={steps} />
        <StepTimeline steps={steps} />
        {lastPayload && (
          <>
            <RedactionSummary redactions={lastPayload.redactions} coverage={lastPayload.coverage} />
            <PayloadViewer payload={lastPayload} />
          </>
        )}
        {report && <ReportView title={report.title} content={report.content} />}
      </div>
    </div>
  );
}

render(<App />, document.getElementById('root')!);
