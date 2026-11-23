import { createContext, useContext, useState } from 'react';
import type { SyncController, SyncState } from './types';
import { downloadText } from '../settings/download';
import './sync.css';

export const LOCAL_SYNC: SyncState = { status: 'local', error: null, conflict: null, lastSyncedAt: null, revision: null };
export const SyncContext = createContext<{ state: SyncState; controller: SyncController | null; openStart: () => void }>({ state: LOCAL_SYNC, controller: null, openStart: () => {} });
const labels = { local: 'Nur auf diesem Gerät', offline: 'Offline · Änderungen bleiben gespeichert', pending: 'Abgleich ausstehend', syncing: 'Wird synchronisiert', synced: 'Synchronisiert', conflict: 'Konflikt prüfen', error: 'Abgleich nicht abgeschlossen' };

export function SyncStatus() {
  const { state, openStart } = useContext(SyncContext);
  return <button type="button" className={`sync-status sync-${state.status}`} onClick={openStart} title="Synchronisierungsstand und Konflikte anzeigen">{labels[state.status]}</button>;
}

export function SyncPanel({ settings = false }: { settings?: boolean }) {
  const { state, controller, openStart } = useContext(SyncContext);
  const [choice, setChoice] = useState<'local' | 'remote' | null>(null);
  const [error, setError] = useState('');
  async function downloadCopies() {
    try {
      const copies = state.conflict ?? await controller?.getRecoveryBackup();
      if (copies) await downloadText('nexus-sync-konflikt.json', JSON.stringify(copies), 'application/json');
    } catch (cause) { setError(String(cause)); }
  }
  return <section className="sync-panel" aria-label="Gerätesynchronisierung">
    <strong role="status">{labels[state.status]}</strong>
    <p>{controller ? 'Gespeicherte Änderungen werden mit demselben Konto auf deinen Geräten abgeglichen. Offene Eingaben warten bis zum sicheren Abschluss.' : 'Dieser lokale Arbeitsbereich verwendet keine Cloud. Für den Geräteabgleich verwende die Web- oder Android-App mit deinem Konto.'}</p>
    {state.lastSyncedAt && <small>Letzter bestätigter Abgleich: {new Date(state.lastSyncedAt).toLocaleString('de-DE')}</small>}
    {state.error && <p role="alert">{state.error}</p>}
    {settings && controller && <button type="button" onClick={openStart}>Zum Abgleichen zur Startseite</button>}
    {!settings && controller && <button type="button" disabled={state.status === 'syncing'} onClick={() => void controller.syncNow()}>Jetzt abgleichen</button>}
    {state.conflict && <div className="sync-conflict">
      <p>Diese Änderungen überschneiden sich. Beide Fassungen bleiben erhalten. Wähle bewusst, welcher <strong>gesamte Arbeitsbereich</strong> weiterverwendet wird.</p>
      <ul>{state.conflict.items.slice(0, 8).map(item => <li key={item.path}>{item.label}</li>)}</ul>
      <button type="button" onClick={() => void downloadCopies()}>Beide Fassungen sichern</button>
      {!settings && <><button type="button" onClick={() => setChoice('local')}>Diesen Gerätestand wählen</button><button type="button" onClick={() => setChoice('remote')}>Cloud-Stand wählen</button>
      {choice && <div><p>{choice === 'local' ? 'Der Gerätestand ersetzt den Cloud-Stand' : 'Der Cloud-Stand ersetzt den Gerätestand'}. Die beiden bisherigen Fassungen werden zusätzlich lokal gesichert.</p><button type="button" onClick={() => { void controller?.resolveConflict(choice).catch(cause => setError(String(cause))); setChoice(null); }}>Auswahl bestätigen</button><button type="button" onClick={() => setChoice(null)}>Abbrechen</button></div>}</>}
    </div>}
    {controller && <details><summary>Wiederherstellung nach einem Konflikt</summary><p>Die letzte Konfliktentscheidung bewahrt beide bisherigen Fassungen zusätzlich in diesem Browser. Sichere sie als Datei, bevor du Browserdaten entfernst.</p><button type="button" onClick={() => void downloadCopies()}>Letzte Konfliktfassungen sichern</button></details>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
