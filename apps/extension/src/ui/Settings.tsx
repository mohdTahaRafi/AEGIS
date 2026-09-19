// design.md §13.5 (FR-35, T-6.11) — every row in that table, one control each, no more and no
// less. `entityTypes` is passed in (from `defaultPolicy`'s own `entityClass` keys) rather than a
// second hardcoded entity-type list living here — the base policy is already this project's one
// real source for "every entity type that exists."

import { useState } from 'preact/hooks';
import type { EntityType } from '@aegis/recognizers';
import type { AlwaysRedactMap, BackendPref, NerProfile, Settings as SettingsValue } from '../host/settings/store';

export interface SettingsProps {
  value: SettingsValue;
  entityTypes: readonly EntityType[];
  onSave(next: SettingsValue): void;
  onClose(): void;
}

const ROW_STYLE = { display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0' };
const LABEL_STYLE = { flex: '0 0 140px', color: '#333' };

export function Settings({ value, entityTypes, onSave, onClose }: SettingsProps) {
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

  return (
    <div style={{ padding: 12, fontSize: 13, maxWidth: 480 }}>
      <h3 style={{ margin: '0 0 8px' }}>Settings</h3>

      <div style={ROW_STYLE}>
        <label style={LABEL_STYLE} htmlFor="settings-server-url">
          Server URL
        </label>
        <input
          id="settings-server-url"
          type="text"
          value={draft.serverUrl}
          onInput={(e) => set('serverUrl', (e.target as HTMLInputElement).value)}
          style={{ flex: 1 }}
        />
      </div>

      <div style={ROW_STYLE}>
        <label style={LABEL_STYLE} htmlFor="settings-access-token">
          Access token
        </label>
        <input
          id="settings-access-token"
          type="password"
          value={draft.accessToken}
          onInput={(e) => set('accessToken', (e.target as HTMLInputElement).value)}
          style={{ flex: 1 }}
        />
      </div>

      <div style={ROW_STYLE}>
        <label style={LABEL_STYLE} htmlFor="settings-backend">
          Backend
        </label>
        <select
          id="settings-backend"
          value={draft.backend}
          onChange={(e) => set('backend', (e.target as HTMLSelectElement).value as BackendPref)}
        >
          <option value="auto">auto</option>
          <option value="webgpu">WebGPU</option>
          <option value="wasm">WASM</option>
        </select>
      </div>

      <div style={ROW_STYLE}>
        <label style={LABEL_STYLE} htmlFor="settings-ner-profile">
          NER profile
        </label>
        <select
          id="settings-ner-profile"
          value={draft.nerProfile}
          onChange={(e) => set('nerProfile', (e.target as HTMLSelectElement).value as NerProfile)}
        >
          <option value="S">S</option>
          <option value="L">L</option>
        </select>
      </div>

      <div style={ROW_STYLE}>
        <label style={LABEL_STYLE} htmlFor="settings-policy">
          Policy
        </label>
        <select id="settings-policy" value={draft.policyId} onChange={(e) => set('policyId', (e.target as HTMLSelectElement).value)}>
          <option value="default">default</option>
        </select>
      </div>

      <div style={ROW_STYLE}>
        <label style={LABEL_STYLE} htmlFor="settings-debug-overlay">
          Debug overlay
        </label>
        <input
          id="settings-debug-overlay"
          type="checkbox"
          checked={draft.debugOverlay}
          onChange={(e) => set('debugOverlay', (e.target as HTMLInputElement).checked)}
        />
      </div>

      <div style={ROW_STYLE}>
        <label style={LABEL_STYLE} htmlFor="settings-show-raw-payload">
          Show raw payload
        </label>
        <input
          id="settings-show-raw-payload"
          type="checkbox"
          checked={draft.showRawPayload}
          onChange={(e) => set('showRawPayload', (e.target as HTMLInputElement).checked)}
        />
      </div>

      <div style={{ margin: '10px 0 4px', color: '#333' }}>Per-type redaction policy</div>
      <div style={{ maxHeight: 180, overflow: 'auto', border: '1px solid #ddd', padding: 6, borderRadius: 4 }}>
        {entityTypes.map((entity) => (
          <div key={entity} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <input
              id={`settings-always-redact-${entity}`}
              type="checkbox"
              checked={draft.alwaysRedact[entity] === true}
              onChange={(e) => setAlwaysRedact(entity, (e.target as HTMLInputElement).checked)}
            />
            <label htmlFor={`settings-always-redact-${entity}`} style={{ flex: 1 }}>
              {entity}
            </label>
            <span style={{ color: '#888' }}>{draft.alwaysRedact[entity] ? 'always redact' : 'follow policy'}</span>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
        <button onClick={() => onSave(draft)}>Save</button>
        <button onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
