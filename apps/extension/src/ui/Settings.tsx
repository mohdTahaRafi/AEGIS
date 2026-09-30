// design.md §13.5 (FR-35, T-6.11) — settings view.
// Redesigned: clean, modern settings dialog with grouped sections, consistent spacing,
// clear field descriptions, and full keyboard accessibility.

import { useState } from 'preact/hooks';
import type { EntityType } from '@aegis/recognizers';
import type { AlwaysRedactMap, BackendPref, NerProfile, Settings as SettingsValue } from '../host/settings/store';
import type { KeyCheck } from '../host/egress/model-client';
import { ApiKeyCard } from './ApiKeyCard';
import { C, R, S, T } from './design';

export interface SettingsProps {
  value: SettingsValue;
  entityTypes: readonly EntityType[];
  /** A release build: no developer endpoints, and only the NER profile whose model ships. */
  release: boolean;
  /** The key is stored the moment it is saved, not with the rest of the form. */
  onSaveKey(key: string): void;
  onTestKey(key: string): Promise<KeyCheck>;
  onSave(next: SettingsValue): void;
  onClose(): void;
}

export function Settings({ value, entityTypes, release, onSaveKey, onTestKey, onSave, onClose }: SettingsProps) {
  const [draft, setDraft] = useState<SettingsValue>(value);

  function set<K extends keyof SettingsValue>(key: K, v: SettingsValue[K]): void {
    setDraft((prev) => ({ ...prev, [key]: v }));
  }

  function setAlwaysRedact(entity: EntityType, always: boolean): void {
    const next: AlwaysRedactMap = { ...draft.alwaysRedact };
    if (always) next[entity] = true;
    else delete next[entity];
    set('alwaysRedact', next);
  }

  const inputStyle = {
    padding: '6px 10px',
    fontSize: T.sm,
    border: `1px solid ${C.borderMid}`,
    borderRadius: R.sm,
    background: C.white,
    color: C.strong,
    outline: 'none',
  };

  const selectStyle = {
    ...inputStyle,
    cursor: 'pointer',
  };

  return (
    <div
      style={{
        padding: '16px',
        fontSize: T.sm,
        maxWidth: 480,
        background: C.bg,
        minHeight: '100vh',
        boxSizing: 'border-box',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 16,
          paddingBottom: 10,
          borderBottom: `1px solid ${C.border}`,
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: T.md, fontWeight: 700, color: C.strong }}>Settings</h2>
          <div style={{ fontSize: T.xs, color: C.secondary, marginTop: 2 }}>
            AEGIS model access & local perception
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            ...S.btnSecondary,
            padding: '4px 8px',
            fontSize: T.xs,
          }}
        >
          ✕
        </button>
      </div>

      {/* Model access: the user's own key */}
      <ApiKeyCard
        heading={false}
        savedKey={draft.apiKey}
        onSave={(key) => {
          set('apiKey', key);
          onSaveKey(key);
        }}
        onRemove={() => {
          set('apiKey', '');
          onSaveKey('');
        }}
        onTest={onTestKey}
      />

      {!release && (
        <div
          style={{
            background: C.surface,
            border: `1px solid ${C.border}`,
            borderRadius: R.md,
            padding: '12px 14px',
            marginBottom: 12,
          }}
        >
          <div style={{ fontSize: T.xs, fontWeight: 600, color: C.secondary, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
            Development endpoints
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {(
              [
                ['settings-model-url', 'Model URL', 'modelUrl', 'text'],
                ['settings-model-name', 'Model', 'modelName', 'text'],
                ['settings-server-url', 'Gateway URL', 'serverUrl', 'text'],
                ['settings-access-token', 'Gateway token', 'accessToken', 'password'],
              ] as const
            ).map(([id, label, key, type]) => (
              <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <label style={{ flex: '0 0 110px', color: C.body, fontWeight: 500 }} htmlFor={id}>
                  {label}
                </label>
                <input id={id} type={type} value={draft[key]} onInput={(e) => set(key, (e.target as HTMLInputElement).value)} style={{ ...inputStyle, flex: 1 }} />
              </div>
            ))}
            <div style={{ fontSize: T.xs, color: C.muted }}>Used only by development builds. With a key saved, tasks go straight to the model URL; without one they use the gateway.</div>
          </div>
        </div>
      )}

      {/* Perception & Inference Card */}
      <div
        style={{
          background: C.surface,
          border: `1px solid ${C.border}`,
          borderRadius: R.md,
          padding: '12px 14px',
          marginBottom: 12,
        }}
      >
        <div style={{ fontSize: T.xs, fontWeight: 600, color: C.secondary, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
          Perception & Models
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <label style={{ flex: '0 0 110px', color: C.body, fontWeight: 500 }} htmlFor="settings-backend">
              Backend
            </label>
            <select
              id="settings-backend"
              value={draft.backend}
              onChange={(e) => set('backend', (e.target as HTMLSelectElement).value as BackendPref)}
              style={{ ...selectStyle, flex: 1 }}
            >
              <option value="auto">auto</option>
              <option value="webgpu">WebGPU</option>
              <option value="wasm">WASM</option>
            </select>
          </div>

          {!release && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <label style={{ flex: '0 0 110px', color: C.body, fontWeight: 500 }} htmlFor="settings-ner-profile">
                NER profile
              </label>
              <select
                id="settings-ner-profile"
                value={draft.nerProfile}
                onChange={(e) => set('nerProfile', (e.target as HTMLSelectElement).value as NerProfile)}
                style={{ ...selectStyle, flex: 1 }}
              >
                <option value="S">S (fast / lightweight)</option>
                <option value="L">L (extended / high recall)</option>
              </select>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <label style={{ flex: '0 0 110px', color: C.body, fontWeight: 500 }} htmlFor="settings-policy">
              Policy
            </label>
            <select
              id="settings-policy"
              value={draft.policyId}
              onChange={(e) => set('policyId', (e.target as HTMLSelectElement).value)}
              style={{ ...selectStyle, flex: 1 }}
            >
              <option value="default">default</option>
            </select>
          </div>
        </div>
      </div>

      {/* Developer & Debug Card */}
      <div
        style={{
          background: C.surface,
          border: `1px solid ${C.border}`,
          borderRadius: R.md,
          padding: '12px 14px',
          marginBottom: 12,
        }}
      >
        <div style={{ fontSize: T.xs, fontWeight: 600, color: C.secondary, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
          Developer & Inspection
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              id="settings-debug-overlay"
              type="checkbox"
              checked={draft.debugOverlay}
              onChange={(e) => set('debugOverlay', (e.target as HTMLInputElement).checked)}
              style={{ width: 15, height: 15, accentColor: C.accent }}
            />
            <label style={{ color: C.body, cursor: 'pointer' }} htmlFor="settings-debug-overlay">
              Debug overlay (stage timeline)
            </label>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              id="settings-show-raw-payload"
              type="checkbox"
              checked={draft.showRawPayload}
              onChange={(e) => set('showRawPayload', (e.target as HTMLInputElement).checked)}
              style={{ width: 15, height: 15, accentColor: C.accent }}
            />
            <label style={{ color: C.body, cursor: 'pointer' }} htmlFor="settings-show-raw-payload">
              Show raw payload (exact JSON and screenshot)
            </label>
          </div>
        </div>
      </div>

      {/* Per-type Redaction Policy Card */}
      <div
        style={{
          background: C.surface,
          border: `1px solid ${C.border}`,
          borderRadius: R.md,
          padding: '12px 14px',
          marginBottom: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ fontSize: T.xs, fontWeight: 600, color: C.secondary, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Per-type redaction policy
          </div>
          <span style={{ fontSize: T.xs, color: C.muted }}>
            {entityTypes.length} entity types
          </span>
        </div>

        <div
          style={{
            maxHeight: 180,
            overflowY: 'auto',
            border: `1px solid ${C.border}`,
            borderRadius: R.sm,
            padding: '6px 8px',
            background: C.bg,
          }}
        >
          {entityTypes.map((entity) => (
            <div
              key={entity}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '3px 0',
                fontSize: T.xs,
              }}
            >
              <input
                id={`settings-always-redact-${entity}`}
                type="checkbox"
                checked={draft.alwaysRedact[entity] === true}
                onChange={(e) => setAlwaysRedact(entity, (e.target as HTMLInputElement).checked)}
                style={{ width: 14, height: 14, accentColor: C.accent }}
              />
              <label htmlFor={`settings-always-redact-${entity}`} style={{ flex: 1, color: C.body, cursor: 'pointer' }}>
                {entity}
              </label>
              <span style={{ color: draft.alwaysRedact[entity] ? C.error : C.muted, fontWeight: draft.alwaysRedact[entity] ? 500 : 400 }}>
                {draft.alwaysRedact[entity] ? 'always redact' : 'follow policy'}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onClose} style={S.btnSecondary}>
          Close
        </button>
        <button onClick={() => onSave(draft)} style={S.btnPrimary}>
          Save
        </button>
      </div>
    </div>
  );
}
