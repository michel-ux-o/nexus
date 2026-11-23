import { useState, useSyncExternalStore } from 'react';
import { CURRENT_BUILD, installationIdentity } from './build';
import { applyAvailableUpdate, checkForUpdates, getUpdateSnapshot, subscribeToUpdates, type UpdatePreparation } from '../offline';
import './update.css';

export function BuildIdentity({ compact = false }: { compact?: boolean }) {
  const state = useSyncExternalStore(subscribeToUpdates, getUpdateSnapshot);
  const identity = installationIdentity(location.href);
  const builtAt = CURRENT_BUILD.builtAt ? new Date(CURRENT_BUILD.builtAt).toLocaleString('de-DE') : '';
  if (compact) return <span className="nexus-build-compact" title={`${identity.label} · ${identity.address}${builtAt ? ` · Erstellt ${builtAt}` : ''}`}>NEXUS {CURRENT_BUILD.version} · {CURRENT_BUILD.id}</span>;
  return <section className="nexus-build-identity" aria-label="Installation und Version">
    <strong>NEXUS {CURRENT_BUILD.version}</strong>
    <p>Geladener Build: <code>{CURRENT_BUILD.id}</code>{builtAt && <> · Erstellt {builtAt}</>}</p>
    <p>{identity.label} · <span className="nexus-install-address">{identity.address}</span></p>
    <p>Die Daten dieser Browser-Installation gehören zu dieser Adresse. Eine andere Adresse kann einen anderen lokalen Datenbestand anzeigen.</p>
    {state.phase === 'unsupported' ? <p>Automatische Update-Prüfung ist in dieser Umgebung nicht verfügbar.</p>
      : <><button className="secondary-button" disabled={state.phase === 'checking' || state.phase === 'applying'} onClick={() => void checkForUpdates(true)}>{state.phase === 'checking' ? 'Updates werden geprüft …' : 'Nach Updates suchen'}</button>
        {state.available && <p>Ein Update auf Build {state.available.id} ist verfügbar. „Nach Updates suchen“ öffnet den Update-Hinweis erneut.</p>}
        {state.checkedAt && !state.available && !state.error && <p role="status">Diese Installation ist aktuell. Zuletzt geprüft: {new Date(state.checkedAt).toLocaleTimeString('de-DE')}.</p>}</>}
  </section>;
}

/** The caller must include every open editor/dialog draft in its preparation guard. */
export function UpdateNotice({ prepareUpdate }: { prepareUpdate: () => Promise<UpdatePreparation> }) {
  const state = useSyncExternalStore(subscribeToUpdates, getUpdateSnapshot);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const key = `${state.available?.id ?? state.error}:${state.noticeRequest ?? 0}`;
  if ((!state.available && !state.error) || key === dismissed) return null;
  const applying = state.phase === 'applying';
  return <aside className="nexus-update-notice" aria-label="App-Update" aria-live="polite">
    <div><strong>{state.available ? `NEXUS ${state.available.version}: Update verfügbar` : 'Update-Prüfung nicht abgeschlossen'}</strong>
      <p>{state.error ?? (state.ready ? 'Die neue Version ist bereit. Vor dem Neuladen werden deine Änderungen gespeichert; offene Entwürfe müssen zuerst abgeschlossen werden.' : 'Die neue Version wird für diese Installation vorbereitet. Du kannst weiterarbeiten.')}</p>
      {state.available && <small>Neu: {state.available.id} · Geöffnet: {CURRENT_BUILD.id}</small>}
    </div>
    <div className="nexus-update-actions">
      {state.available && state.ready && <button className="primary-button" disabled={applying} onClick={() => void applyAvailableUpdate(prepareUpdate)}>{applying ? 'Update wird geöffnet …' : 'Speichern & aktualisieren'}</button>}
      {(!state.ready || state.error) && <button className="secondary-button" disabled={applying || state.phase === 'checking'} onClick={() => void checkForUpdates(true)}>Erneut prüfen</button>}
      <button className="secondary-button" disabled={applying} onClick={() => setDismissed(key)}>Später</button>
    </div>
  </aside>;
}
