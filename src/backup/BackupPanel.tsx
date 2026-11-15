import { useEffect, useId, useState, type ChangeEvent } from 'react';
import { MAX_WORKSPACE_BACKUP_BYTES } from '../data/workspaceBackup';
import { repository } from '../data/repository';
import type { WorkspaceBackup } from '../planning/types';
import { externalBackup } from './externalBackup';
import { probeWorkspaceRestore, type RestoreProbeResult } from './restoreProbe';
import './BackupPanel.css';

interface BackupPanelProps {
  disabled: boolean;
  timeZone: string;
  begin: () => boolean;
  finish: () => void;
  onFlush: () => Promise<boolean>;
  onVerifiedSave: (backup: WorkspaceBackup, verifiedAt: string) => Promise<void>;
  onImportPreview: (name: string, backup: WorkspaceBackup) => void;
}
type BackupFile = { name: string; lastModified: number; size: number };
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Bitte versuche es erneut.';

export function BackupPanel({ disabled, timeZone, begin, finish, onFlush, onVerifiedSave, onImportPreview }: BackupPanelProps) {
  const id = useId();
  const [directory, setDirectory] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [files, setFiles] = useState<BackupFile[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<{ name: string; result: RestoreProbeResult } | null>(null);
  const available = externalBackup.supported();
  const formatDate = (value: number | string) => new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23', timeZone }).format(new Date(value));
  useEffect(() => {
    let active = true;
    if (available) void externalBackup.restoreDirectory().then(name => { if (active) setDirectory(name); }).catch(() => { if (active) setError('Der gespeicherte Ordner konnte nicht geladen werden.'); }).finally(() => { if (active) setRestoring(false); });
    else setRestoring(false);
    return () => { active = false; };
  }, [available]);
  function start(): boolean {
    if (!begin()) return false;
    setError(null); setMessage(null); setProbe(null);
    return true;
  }
  async function refresh(): Promise<void> { setFiles(await externalBackup.listBackups()); }
  async function choose(): Promise<void> {
    if (!start()) return;
    try {
      // Picker must be called directly in the user gesture, before any await.
      const pending = externalBackup.chooseDirectory();
      const name = await pending;
      setDirectory(name); setFiles([]);
      await refresh();
      setMessage(`Ordner „${name}“ ist verbunden.`);
    } catch (cause) { setError(`Der Ordner konnte nicht verbunden werden. ${errorText(cause)}`); }
    finally { finish(); }
  }
  async function reconnect(): Promise<void> {
    if (!start()) return;
    try {
      // Permission request must retain the click's transient activation.
      const pending = externalBackup.authorizeDirectory();
      await pending; await refresh();
      setMessage('Der Ordner ist wieder verbunden.');
    } catch (cause) { setError(`Der Ordner konnte nicht verbunden werden. ${errorText(cause)}`); }
    finally { finish(); }
  }
  async function disconnect(): Promise<void> {
    if (!start()) return;
    try { await externalBackup.forgetDirectory(); setDirectory(null); setFiles([]); setMessage('Die Ordnerverbindung wurde getrennt. Die Sicherungsdateien bleiben erhalten.'); }
    catch (cause) { setError(`Die Verbindung konnte nicht getrennt werden. ${errorText(cause)}`); }
    finally { finish(); }
  }
  async function save(): Promise<void> {
    if (!start()) return;
    let saved = false;
    try {
      if (!await onFlush()) throw new Error('Aktuelle Änderungen konnten nicht gespeichert werden.');
      const backup = await repository.exportWorkspace();
      const result = await externalBackup.saveBackup(backup);
      saved = true;
      await onVerifiedSave(backup, result.verifiedAt);
      await refresh();
      setMessage(`„${result.filename}“ wurde im Ordner gespeichert und durch erneutes Lesen geprüft.`);
    } catch (cause) { setError(`${saved ? 'Die Ordnersicherung wurde geprüft, aber Historie oder Liste konnten nicht aktualisiert werden.' : 'Die Ordnersicherung konnte nicht bestätigt werden.'} ${errorText(cause)}`); }
    finally { finish(); }
  }
  async function inspect(file: BackupFile, action: 'check' | 'probe' | 'import'): Promise<void> {
    if (!start()) return;
    try {
      const backup = await externalBackup.readBackup(file.name);
      if (action === 'probe') {
        const result = await probeWorkspaceRestore(backup);
        setProbe({ name: file.name, result });
      } else if (action === 'import') {
        onImportPreview(file.name, backup);
        setMessage('Die Sicherung wurde für die Importvorschau ausgewählt. Bestätige dort ausdrücklich die gewünschte Übernahme.');
      } else setMessage(`„${file.name}“ wurde gelesen und auf gültige Struktur und Beziehungen geprüft.`);
    } catch (cause) { setError(`„${file.name}“ konnte nicht ${action === 'probe' ? 'probeweise wiederhergestellt' : 'geprüft'} werden. Der aktuelle Datenbestand bleibt erhalten. ${errorText(cause)}`); }
    finally { finish(); }
  }
  async function probeFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || !start()) return;
    try {
      if (file.size > MAX_WORKSPACE_BACKUP_BYTES) throw new Error('Die Datei ist zu groß. Erlaubt sind höchstens 50 MiB.');
      const result = await probeWorkspaceRestore(await file.text());
      setProbe({ name: file.name, result });
    } catch (cause) { setError(`Die Wiederherstellungsprobe ist fehlgeschlagen. Der aktuelle Datenbestand bleibt erhalten. ${errorText(cause)}`); }
    finally { finish(); }
  }
  return <section className="settings-section backup-panel" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>Sicherungsordner & Wiederherstellungsprobe</h3>
    <p>Speichere mehrere geprüfte Stände in einem selbst gewählten Ordner. Eine Wiederherstellungsprobe lädt eine Sicherung in eine isolierte Prüfdatenbank und verändert deinen Arbeitsbereich nicht.</p>
    {available ? <>
      <p>{directory ? <>Gewählter Ordner: <strong>{directory}</strong></> : 'Noch kein Sicherungsordner verbunden.'}</p>
      <div className="backup-panel-actions">
        <button type="button" className="secondary-button" disabled={disabled || restoring} onClick={() => { void choose(); }}>{directory ? 'Anderen Ordner wählen' : 'Ordner wählen'}</button>
        {directory && <><button type="button" className="secondary-button" disabled={disabled || restoring} onClick={() => { void reconnect(); }}>Ordner neu verbinden</button><button type="button" className="secondary-button" disabled={disabled || restoring} onClick={() => { void disconnect(); }}>Verbindung trennen</button><button type="button" className="primary-button" disabled={disabled || restoring} onClick={() => { void save(); }}>Jetzt im Ordner sichern</button></>}
      </div>
      {directory && <><p className="settings-muted">Nach erneutem Öffnen kann „Ordner neu verbinden“ erforderlich sein, bevor die Stände angezeigt oder gespeichert werden können.</p>
        <h4>Gesicherte Stände</h4>
        {files.length === 0 ? <p className="settings-muted">Keine Stände angezeigt. Verbinde den Ordner erneut, um vorhandene Dateien zu laden.</p> : <ul className="backup-panel-list">{files.map(file => <li key={file.name}><div><strong>{file.name}</strong><small>{formatDate(file.lastModified)} · {Math.ceil(file.size / 1024)} KiB</small></div><div className="backup-panel-actions"><button type="button" className="secondary-button" disabled={disabled || restoring} onClick={() => { void inspect(file, 'check'); }}>Datei prüfen</button><button type="button" className="secondary-button" disabled={disabled || restoring} onClick={() => { void inspect(file, 'probe'); }}>Wiederherstellung proben</button><button type="button" className="secondary-button" disabled={disabled || restoring} onClick={() => { void inspect(file, 'import'); }}>Für Import auswählen</button></div></li>)}</ul>}
      </>}
    </> : <p>Die direkte Ordnersicherung ist in diesem Browser nicht verfügbar. Nutze den JSON-Download und prüfe die heruntergeladene Datei hier.</p>}
    <label className="field settings-file" htmlFor={`${id}-probe`}><span>JSON-Datei für Wiederherstellungsprobe auswählen</span><input id={`${id}-probe`} type="file" accept=".json,application/json" disabled={disabled || restoring} onChange={event => { void probeFile(event); }} /></label>
    {probe && <div className="backup-panel-result" role="status"><strong>Wiederherstellungsprobe erfolgreich: {probe.name}</strong><p>{probe.result.notes} Notizen · {probe.result.tasks} Aufgaben · {probe.result.appointments} Termine · {probe.result.timeBlocks} Zeitblöcke · {probe.result.reminders} Erinnerungen · {probe.result.rules} Regeln</p><p>Geprüft am {formatDate(probe.result.checkedAt)}. Der aktuelle Arbeitsbereich wurde nicht verändert.</p>{probe.result.cleanupWarning && <p className="settings-warning">{probe.result.cleanupWarning}</p>}</div>}
    {message && <p role="status">{message}</p>}{error && <p className="settings-error" role="alert">{error}</p>}
  </section>;
}
