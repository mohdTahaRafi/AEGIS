// Bring your own key: the one thing a user must do before AEGIS can run a task. Shown on the main
// panel until a key is saved, and again in Settings. The key is checked against the API before it is
// stored (a rejected key is never saved); an unreachable API only warns, so a user who is offline
// can still store the key they typed.

import { useState } from 'preact/hooks';
import { cleanApiKey, looksLikeApiKey } from '../host/settings/store';
import type { KeyCheck } from '../host/egress/model-client';
import { C, R, S, T } from './design';

export const KEYS_URL = 'https://console.groq.com/keys';

export interface ApiKeyCardProps {
  /** The saved key, or '' when none. */
  savedKey: string;
  onSave(key: string): void;
  onRemove(): void;
  /** Asks the API whether the key works (host/egress/model-client.ts `verifyApiKey`). */
  onTest(key: string): Promise<KeyCheck>;
  /** The card's own heading is left out where a parent already has one (Settings). */
  heading?: boolean;
}

type Status = { kind: 'idle' } | { kind: 'testing' } | { kind: 'ok'; note?: string } | { kind: 'warn'; text: string } | { kind: 'bad'; text: string };

function maskedKey(key: string): string {
  return key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-4)}` : '••••';
}

export function ApiKeyCard({ savedKey, onSave, onRemove, onTest, heading = true }: ApiKeyCardProps) {
  const [draft, setDraft] = useState('');
  const [reveal, setReveal] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  async function save(): Promise<void> {
    const key = cleanApiKey(draft);
    if (!looksLikeApiKey(key)) {
      setStatus({ kind: 'bad', text: 'That does not look like an API key. Copy the whole key from the Groq console (it starts with gsk_).' });
      return;
    }
    setStatus({ kind: 'testing' });
    const check = await onTest(key);
    if (!check.ok && check.reason === 'invalid_key') {
      setStatus({ kind: 'bad', text: 'Groq rejected this key. Check that you copied all of it, or create a new one.' });
      return;
    }
    onSave(key);
    setDraft('');
    setReveal(false);
    if (!check.ok) setStatus({ kind: 'warn', text: 'Key saved, but Groq could not be reached to check it. It will be tried on your next task.' });
    else if (!check.visionModelListed) setStatus({ kind: 'warn', text: 'Key saved, but it cannot see the vision model AEGIS uses. Tasks may fail until your Groq account has access to it.' });
    else setStatus({ kind: 'ok' });
  }

  const inputStyle = {
    flex: 1,
    minWidth: 0,
    padding: '6px 10px',
    fontSize: T.sm,
    border: `1px solid ${C.borderMid}`,
    borderRadius: R.sm,
    background: C.white,
    color: C.strong,
    outline: 'none',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  };
  const color = status.kind === 'bad' ? C.error : status.kind === 'warn' ? C.warn : C.ok;

  return (
    <div data-testid="api-key-card" style={{ background: C.surface, border: `1px solid ${savedKey ? C.border : C.infoBorder}`, borderRadius: R.md, padding: '12px 14px', marginBottom: 12 }}>
      {heading && (
        <div style={{ fontSize: T.md, fontWeight: 700, color: C.strong, marginBottom: 4 }}>{savedKey ? 'Your Groq API key' : 'Add your Groq API key to start'}</div>
      )}
      <div style={{ fontSize: T.xs, color: C.secondary, lineHeight: 1.5, marginBottom: 10 }}>
        AEGIS plans each step with a model on Groq, using <strong>your own</strong> key, so usage is billed to (or limited by) your account, not ours. The key stays in this browser and is sent only to
        api.groq.com. Only redacted pages ever leave your device.{' '}
        <a href={KEYS_URL} target="_blank" rel="noreferrer" style={{ color: C.accent }}>
          Get a free key
        </a>
      </div>

      {savedKey && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, fontSize: T.sm }}>
          <span style={{ color: C.ok, fontWeight: 600 }}>✓ Key saved</span>
          <code style={{ color: C.body }}>{maskedKey(savedKey)}</code>
          <button type="button" onClick={onRemove} style={{ ...S.btnSecondary, marginLeft: 'auto', padding: '3px 10px', fontSize: T.xs }}>
            Remove
          </button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 6 }}>
        <input
          id="api-key-input"
          type={reveal ? 'text' : 'password'}
          value={draft}
          placeholder={savedKey ? 'Paste a new key to replace it' : 'gsk_…'}
          aria-label="Groq API key"
          autoComplete="off"
          spellcheck={false}
          onInput={(e) => {
            setDraft((e.target as HTMLInputElement).value);
            if (status.kind !== 'testing') setStatus({ kind: 'idle' });
          }}
          onKeyDown={(e) => e.key === 'Enter' && draft.trim() && void save()}
          style={inputStyle}
        />
        <button type="button" onClick={() => setReveal(!reveal)} aria-label={reveal ? 'Hide key' : 'Show key'} style={{ ...S.btnSecondary, padding: '4px 8px', fontSize: T.xs }}>
          {reveal ? 'Hide' : 'Show'}
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!draft.trim() || status.kind === 'testing'}
          style={{ ...S.btnPrimary, padding: '6px 14px', fontSize: T.sm, opacity: !draft.trim() || status.kind === 'testing' ? 0.5 : 1 }}
        >
          {status.kind === 'testing' ? 'Checking…' : 'Save key'}
        </button>
      </div>

      {(status.kind === 'ok' || status.kind === 'bad' || status.kind === 'warn') && (
        <div role="status" style={{ marginTop: 8, fontSize: T.xs, color, lineHeight: 1.4 }}>
          {status.kind === 'ok' ? '✓ Key works. You can run a task now.' : status.text}
        </div>
      )}
    </div>
  );
}
