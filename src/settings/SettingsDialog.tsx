import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { ArchiveRestore, ArrowLeft, Bell, CalendarDays, ChevronRight, Download, FileJson, Globe2, HardDrive, Monitor, Pause, ShieldCheck, Sparkles, Sunrise, Trash2, Upload, UserRound, X } from 'lucide-react';
import { MAX_WORKSPACE_BACKUP_BYTES, parseWorkspaceBackup } from '../data/workspaceBackup';
import { repository } from '../data/repository';
import { emptyPlanning, type AppSettings, type CapacityWindow, type Planner, type TaskRule, type WorkspaceBackup } from '../planning/types';
import { api, type AIStatus } from '../services/ai';
import type { ImportMode, Note } from '../types';
import { downloadText } from './download';
import { appendExportHistory, backupIsDue, draftFrom, sameSettings, settingsPatch, WEEKDAYS, type SettingsDraft } from './preferences';
import { BackupPanel } from '../backup/BackupPanel';
import { ThemeSettings } from './ThemeSettings';
import { ParticleColorSettings } from './ParticleColorSettings';
import { MorningRoutineSettings } from './MorningRoutineSettings';
import { AndroidAlarmSettings } from '../alarm';
import { useAccount } from '../auth/AccountBoundary';
import { setThemePreview } from '../themes/useTheme';
import './SettingsDialog.css';

interface SettingsDialogProps {
  notes: Note[];
  planner: Planner;
  onClose: () => void;
  onFlush: () => Promise<boolean>;
  onImported: () => Promise<void>;
  onImportStart: () => void;
  embedded?: boolean;
  onGuardChange?: (guard: (() => boolean) | null) => void;
}
type Operation = 'settings' | 'export' | 'file' | 'import' | 'backup' | 'reload' | 'permission' | 'storage' | 'rule' | 'reset';
type SettingsTopic = 'display' | 'planning' | 'morning' | 'ai' | 'account' | 'data';
type DataTopic = 'backup' | 'import' | 'restore' | 'storage' | 'reset';
const SETTINGS_TOPICS = [
  { key: 'display', label: 'Darstellung', description: 'Farben, Theme und Bewegung', icon: Monitor },
  { key: 'planning', label: 'Alltag & Planung', description: 'Start, Zeitfenster und Erinnerungen', icon: CalendarDays },
  { key: 'morning', label: 'Morgenroutine', description: 'Dein Start von Montag bis Sonntag', icon: Sunrise },
  { key: 'ai', label: 'KI & Sprache', description: 'Freigabe, Prüfmodus und Verbindung', icon: Sparkles },
  { key: 'account', label: 'Konto & Synchronisierung', description: 'Anmeldung und Gerätestand', icon: UserRound },
  { key: 'data', label: 'Daten & Sicherungen', description: 'Sichern, übertragen und wiederherstellen', icon: HardDrive },
] as const;
interface ImportPreview { filename: string; backup: WorkspaceBackup; legacy: boolean; version: number }
interface ReloadContext { committed: boolean; legacy: boolean; reset?: boolean }
const COMMON_ZONES = ['Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich', 'Europe/London', 'UTC', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'Australia/Sydney'];

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Bitte versuche es erneut.';
}
async function downloadBackup(backup: WorkspaceBackup, prefix = 'nexus-workspace'): Promise<void> {
  await downloadText(`${prefix}-${backup.exportedAt.replace(/[:.]/g, '-')}.json`, JSON.stringify(backup), 'application/json;charset=utf-8');
}
function formatDate(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23', timeZone }).format(new Date(value));
}
function revisionCount(notes: Note[]): number {
  return notes.reduce((count, note) => count + note.revisions.length, 0);
}
function planningCounts(backup: WorkspaceBackup): string {
  return `${backup.planning.tasks.length} Aufgaben · ${backup.planning.appointments.length} Termine · ${backup.planning.timeBlocks.length} Zeitblöcke`;
}

export function SettingsDialog({ notes, planner, onClose, onFlush, onImported, onImportStart, embedded = false, onGuardChange }: SettingsDialogProps) {
  const account = useAccount();
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const busyRef = useRef(false);
  const needsReloadRef = useRef(false);
  const reloadContextRef = useRef<ReloadContext | null>(null);
  const mountedRef = useRef(true);
  const backendController = useRef<AbortController | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mode, setMode] = useState<ImportMode>('merge');
  const [confirmed, setConfirmed] = useState(false);
  const [lastBackup, setLastBackup] = useState<WorkspaceBackup | null>(null);
  const [backupLoading, setBackupLoading] = useState(true);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [migrationBackup, setMigrationBackup] = useState<WorkspaceBackup | null>(null);
  const [migrationError, setMigrationError] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [draft, setDraft] = useState(() => draftFrom(planner.data.settings));
  const [draftEdited, setDraftEdited] = useState(false);
  const [unconfirmedSettings, setUnconfirmedSettings] = useState(false);
  const unconfirmedSettingsRef = useRef(false);
  const settingsBeforeSaveRef = useRef<AppSettings | null>(null);
  const [themePreviewing, setThemePreviewing] = useState(false);
  const [customZone, setCustomZone] = useState(() => !COMMON_ZONES.includes(planner.data.settings.timeZone));
  const [backendStatus, setBackendStatus] = useState<AIStatus | null>(null);
  const [backendLoading, setBackendLoading] = useState(true);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | 'unsupported'>(() => typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const [persistent, setPersistent] = useState<boolean | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetConfirmed, setResetConfirmed] = useState(false);
  const [resetPhrase, setResetPhrase] = useState('');
  const [topic, setTopic] = useState<SettingsTopic>('display');
  const [mobileDetail, setMobileDetail] = useState(false);
  const [dataTopic, setDataTopic] = useState<DataTopic>('backup');
  const panelHeadingRef = useRef<HTMLHeadingElement>(null);
  const topicButtonRefs = useRef<Partial<Record<SettingsTopic, HTMLButtonElement | null>>>({});
  const busy = operation !== null;
  const disabled = busy || needsReload;
  const dirty = unconfirmedSettings || (draftEdited && !sameSettings(draft, planner.data.settings));

  useEffect(() => {
    onGuardChange?.(() => {
      if (busyRef.current || needsReloadRef.current) return false;
      if (unconfirmedSettingsRef.current) {
        setError('Das Speichern wurde nicht bestätigt. Bitte versuche es erneut oder verwirf die Änderungen ausdrücklich, bevor du die Einstellungen verlässt.');
        return false;
      }
      return !dirty || window.confirm('Ungespeicherte Einstellungen verwerfen?');
    });
    return () => onGuardChange?.(null);
  }, [dirty, onGuardChange]);

  useEffect(() => {
    mountedRef.current = true;
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    if (!embedded && dialog && !dialog.open) dialog.showModal();
    return () => {
      mountedRef.current = false;
      setThemePreview(null);
      backendController.current?.abort();
      if (dialog?.open) dialog.close();
      if (!embedded && previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [embedded]);
  useEffect(() => {
    if (!draftEdited) {
      setDraft(draftFrom(planner.data.settings));
      setCustomZone(!COMMON_ZONES.includes(planner.data.settings.timeZone));
    }
  }, [planner.data.settings, draftEdited]);
  useEffect(() => {
    let cancelled = false;
    repository.getLastWorkspaceBackup().then((backup) => {
      if (!cancelled) setLastBackup(backup);
    }).catch((cause: unknown) => {
      if (!cancelled) setBackupError(`Die letzte lokale Sicherung konnte nicht gelesen werden. ${describeError(cause)}`);
    }).finally(() => { if (!cancelled) setBackupLoading(false); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { void checkBackend(); return () => backendController.current?.abort(); }, []);
  useEffect(() => {
    let cancelled = false;
    repository.getLastMigrationBackup().then((backup) => { if (!cancelled) setMigrationBackup(backup); }).catch((cause: unknown) => { if (!cancelled) setMigrationError(`Die Migrationssicherung konnte nicht gelesen werden. ${describeError(cause)}`); });
    if (navigator.storage?.persisted) navigator.storage.persisted().then((value) => { if (!cancelled) setPersistent(value); }).catch(() => { if (!cancelled) setStorageError('Der Speicherstatus konnte nicht ermittelt werden.'); });
    const readPermission = () => setNotificationPermission(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
    window.addEventListener('focus', readPermission);
    return () => { cancelled = true; window.removeEventListener('focus', readPermission); };
  }, []);

  async function checkBackend(): Promise<void> {
    backendController.current?.abort();
    const controller = new AbortController();
    backendController.current = controller;
    setBackendLoading(true);
    setBackendStatus(null);
    setBackendError(null);
    try {
      const status = await api.getStatus(controller.signal);
      if (mountedRef.current && !controller.signal.aborted) setBackendStatus(status);
    } catch (cause) {
      if (mountedRef.current && !controller.signal.aborted) setBackendError(describeError(cause));
    } finally {
      if (mountedRef.current && !controller.signal.aborted) setBackendLoading(false);
    }
  }
  function start(next: Operation): boolean {
    if (busyRef.current || (needsReloadRef.current && next !== 'reload')) return false;
    busyRef.current = true;
    setOperation(next);
    setError(null);
    setMessage(null);
    return true;
  }
  function finish(): void {
    busyRef.current = false;
    if (mountedRef.current) setOperation(null);
  }
  function close(): void {
    if (busyRef.current || needsReloadRef.current) return;
    if (!embedded && unconfirmedSettingsRef.current) {
      setError('Das Speichern wurde nicht bestätigt. Bitte versuche es erneut oder verwirf die Änderungen ausdrücklich, bevor du die Einstellungen verlässt.');
      return;
    }
    if (!embedded && dirty && !window.confirm('Ungespeicherte Einstellungen verwerfen?')) return;
    onClose();
  }
  function markNeedsReload(value: boolean): void {
    needsReloadRef.current = value;
    if (mountedRef.current) setNeedsReload(value);
  }
  function editSettings(patch: Partial<SettingsDraft>): void {
    setDraft((current) => ({ ...current, ...patch }));
    setDraftEdited(true);
    setMessage(null);
  }
  function selectTopic(next: SettingsTopic): void {
    setTopic(next);
    setMobileDetail(true);
    requestAnimationFrame(() => panelHeadingRef.current?.focus({ preventScroll: true }));
  }
  function showCategories(): void {
    setMobileDetail(false);
    requestAnimationFrame(() => topicButtonRefs.current[topic]?.focus({ preventScroll: true }));
  }
  function editWindow(weekday: number, patch: Partial<CapacityWindow>): void {
    editSettings({ windows: draft.windows.map((window) => window.weekday === weekday ? { ...window, ...patch } : window) });
  }
  async function resetSettings(): Promise<void> {
    if (unconfirmedSettingsRef.current) {
      if (!start('settings')) return;
      try {
        const previous = settingsBeforeSaveRef.current;
        if (!previous) throw new Error('Der vorherige Einstellungsstand ist nicht verfügbar.');
        planner.updateSettings(settingsPatch(draftFrom(previous)));
        if (!await planner.flush()) throw new Error('Der vorherige Stand konnte nicht gespeichert werden. Bitte versuche es erneut.');
        unconfirmedSettingsRef.current = false;
        setUnconfirmedSettings(false);
        settingsBeforeSaveRef.current = null;
        setDraft(draftFrom(previous));
        setCustomZone(!COMMON_ZONES.includes(previous.timeZone));
        setDraftEdited(false);
        setThemePreview(null);
        setThemePreviewing(false);
        setMessage('Die Änderungen wurden verworfen und der vorherige Einstellungsstand gespeichert.');
      } catch (cause) {
        setError(`Die Änderungen konnten noch nicht verworfen werden. ${describeError(cause)}`);
      } finally { finish(); }
      return;
    }
    setThemePreview(null);
    setThemePreviewing(false);
    setDraft(draftFrom(planner.data.settings));
    setDraftEdited(false);
    setCustomZone(!COMMON_ZONES.includes(planner.data.settings.timeZone));
  }
  async function saveSettings(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!start('settings')) return;
    try {
      const patch = settingsPatch(draft);
      const previous = settingsBeforeSaveRef.current ?? structuredClone(planner.data.settings);
      planner.updateSettings(patch);
      settingsBeforeSaveRef.current = previous;
      unconfirmedSettingsRef.current = true;
      setUnconfirmedSettings(true);
      if (!await planner.flush()) throw new Error('Die Änderungen konnten nicht gespeichert werden. Deine Eingaben bleiben erhalten. Versuche es erneut.');
      unconfirmedSettingsRef.current = false;
      setUnconfirmedSettings(false);
      settingsBeforeSaveRef.current = null;
      setThemePreview(null);
      setThemePreviewing(false);
      setDraftEdited(false);
      setMessage('Die Einstellungen wurden gespeichert.');
    } catch (cause) {
      setError(`Die Einstellungen wurden nicht als gespeichert bestätigt. ${describeError(cause)}`);
    } finally { finish(); }
  }
  function allowTransfer(): boolean {
    if (!dirty) return true;
    setError('Übernimm oder verwirf zuerst deine geänderten Einstellungen. Danach kannst du den vollständigen Arbeitsbereich sichern oder importieren.');
    return false;
  }
  async function exportCurrent(): Promise<void> {
    if (!allowTransfer() || !start('export')) return;
    let handedOff = false;
    try {
      if (!await onFlush()) throw new Error('Aktuelle Änderungen konnten nicht gespeichert werden. Deine Eingaben bleiben erhalten. Schließe den Dialog und versuche das Speichern erneut.');
      // Read after flush; props may still belong to an earlier React render.
      const backup = await repository.exportWorkspace();
      await downloadBackup(backup);
      handedOff = true;
      planner.updateSettings({ exportHistory: appendExportHistory(backup.planning.settings.exportHistory) });
      if (!await planner.flush()) throw new Error('Der Download wurde angestoßen, sein Eintrag in der Exporthistorie konnte aber noch nicht gespeichert werden.');
      setMessage('Die vollständige JSON-Sicherung wurde dem Browser als Download übergeben. Prüfe die Datei im Download-Ordner.');
    } catch (cause) {
      setError(`${handedOff ? 'Die JSON-Sicherung wurde dem Browser übergeben. Die Exporthistorie ist noch nicht als gespeichert bestätigt.' : 'Die Sicherung konnte nicht exportiert werden.'} ${describeError(cause)}`);
    } finally { finish(); }
  }
  async function readFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || !allowTransfer() || !start('file')) return;
    setPreview(null);
    setConfirmed(false);
    try {
      if (file.size > MAX_WORKSPACE_BACKUP_BYTES) throw new Error(`Die Datei ist zu groß. Erlaubt sind höchstens ${MAX_WORKSPACE_BACKUP_BYTES / 1024 / 1024} MiB.`);
      const text = await file.text();
      const backup = parseWorkspaceBackup(text);
      const version = (JSON.parse(text) as { version: number }).version;
      setPreview({ filename: file.name, backup, legacy: version === 1, version });
      setMode('merge');
    } catch (cause) {
      setError(`Die Datei wurde nicht übernommen. ${describeError(cause)}`);
    } finally { finish(); }
  }
  async function refreshBackup(): Promise<void> {
    try {
      setLastBackup(await repository.getLastWorkspaceBackup());
      setBackupError(null);
    } catch (cause) {
      setBackupError(`Die letzte lokale Sicherung konnte nicht gelesen werden. ${describeError(cause)}`);
    }
  }
  async function importPreview(): Promise<void> {
    if (!preview || !confirmed || !allowTransfer() || !start('import')) return;
    const incoming = preview;
    const importMode = mode;
    let lockStarted = false;
    let committed = false;
    try {
      if (!await onFlush()) {
        setError('Der Import wurde angehalten, weil aktuelle Änderungen nicht gespeichert werden konnten. Deine Daten wurden nicht ersetzt oder ergänzt. Schließe den Dialog und versuche das Speichern erneut.');
        return;
      }
      if (importMode === 'replace') await downloadBackup(await repository.exportWorkspace(), 'nexus-workspace-vor-import');
      // App synchronously blocks both stores and invalidates old async callbacks.
      lockStarted = true;
      reloadContextRef.current = { committed: false, legacy: incoming.legacy };
      markNeedsReload(true);
      onImportStart();
      await repository.importWorkspace(incoming.backup, importMode);
      committed = true;
      reloadContextRef.current = { committed: true, legacy: incoming.legacy };
      setPreview(null);
      setConfirmed(false);
      await onImported();
      markNeedsReload(false);
      setDraftEdited(false);
      const noteCount = incoming.backup.notes.length;
      setMessage(`${noteCount === 1 ? 'Eine Notiz wurde' : `${noteCount} Notizen wurden`} ${importMode === 'replace' ? 'übernommen' : 'hinzugefügt'}. ${planningCounts(incoming.backup)} ${importMode === 'replace' ? 'wurden übernommen. Der vorherige vollständige Stand ist als letzte lokale Sicherung verfügbar.' : 'wurden zusammengeführt. Bestehende Einträge und Einstellungen bleiben erhalten.'}`);
      await refreshBackup();
    } catch (cause) {
      if (committed) {
        setError(`Der Import wurde gespeichert, aber die Ansicht konnte nicht aktualisiert werden. Bitte aktualisiere die Ansicht unten. ${describeError(cause)}`);
      } else if (lockStarted) {
        // Rollback must also reload both stores before App releases the blocker.
        try {
          await onImported();
          markNeedsReload(false);
          setDraftEdited(false);
          setError(`Der Import ist fehlgeschlagen. Der bisherige Datenbestand bleibt erhalten und wurde wieder geladen. ${describeError(cause)}`);
        } catch (reloadCause) {
          setError(`Der Import ist fehlgeschlagen. Der bisherige Datenbestand bleibt erhalten, konnte aber nicht erneut geladen werden. Aktualisiere zuerst die Ansicht. ${describeError(cause)} ${describeError(reloadCause)}`);
        }
      } else {
        setError(`Der Import wurde vor der Übernahme angehalten. Der bisherige Datenbestand bleibt erhalten. ${describeError(cause)}`);
      }
    } finally { finish(); }
  }
  async function exportLastBackup(): Promise<void> {
    if (!start('backup')) return;
    try {
      const backup = await repository.getLastWorkspaceBackup();
      setLastBackup(backup);
      if (!backup) throw new Error('Es gibt noch keine lokale Sicherung vor einem Import.');
      await downloadBackup(backup, 'nexus-workspace-wiederherstellung');
      setBackupError(null);
      setMessage('Die vorherige Sicherung wurde als Download bereitgestellt. Um sie wiederherzustellen, wähle diese Datei im Import aus und bestätige „Ersetzen“.');
    } catch (cause) {
      setError(`Die vorherige Sicherung konnte nicht exportiert werden. ${describeError(cause)}`);
    } finally { finish(); }
  }
  async function reloadImported(): Promise<void> {
    if (!start('reload')) return;
    try {
      await onImported();
      markNeedsReload(false);
      setDraftEdited(false);
      setMessage(reloadContextRef.current?.reset
        ? reloadContextRef.current.committed ? 'Der leere Arbeitsbereich wurde geladen. Deine vorherigen Daten liegen in der lokalen Sicherung und im angestoßenen Download.' : 'Der bisherige Arbeitsbereich wurde wieder geladen. Das Zurücksetzen wurde nicht übernommen.'
        : reloadContextRef.current?.committed
        ? reloadContextRef.current.legacy ? 'Die Ansicht wurde mit den importierten Notizen aktualisiert. Die Planung wurde ebenfalls neu geladen.' : 'Die Ansicht wurde mit dem importierten Arbeitsbereich aktualisiert.'
        : 'Der bisherige Arbeitsbereich wurde wieder geladen. Der fehlgeschlagene Import wurde nicht übernommen.');
      await refreshBackup();
    } catch (cause) {
      setError(`Die Ansicht konnte nicht aktualisiert werden. ${describeError(cause)}`);
    } finally { finish(); }
  }

  async function requestNotifications(): Promise<void> {
    if (typeof Notification === 'undefined' || !start('permission')) return;
    try {
      // This is the only permission request, invoked directly by this button.
      const permission = await Notification.requestPermission();
      setNotificationPermission(permission);
      if (permission === 'granted') {
        editSettings({ notifications: true });
        setMessage('Browsermeldungen sind erlaubt. Übernimm die aktivierte Option mit „Einstellungen speichern“.');
      } else setMessage(permission === 'denied' ? 'Der Browser hat Meldungen gesperrt. Du kannst die Berechtigung in seinen Website-Einstellungen ändern. Die Erinnerungszentrale bleibt verfügbar.' : 'Es wurde keine Berechtigung erteilt. Die Erinnerungszentrale bleibt verfügbar.');
    } catch (cause) { setError(`Die Benachrichtigungsberechtigung konnte nicht angefragt werden. ${describeError(cause)}`); }
    finally { finish(); }
  }
  async function requestStorage(): Promise<void> {
    if (!navigator.storage?.persist || !start('storage')) return;
    try {
      const granted = await navigator.storage.persist();
      setPersistent(granted);
      setStorageError(null);
      setMessage(granted ? 'Der Browser hat beständigen Speicher für diese App zugesagt. Externe Sicherungsdateien bleiben weiterhin sinnvoll.' : 'Der Browser hat beständigen Speicher nicht zugesagt. Deine vorhandenen Daten bleiben erhalten; exportiere regelmäßig eine Sicherung.');
    } catch (cause) { setError(`Beständiger Speicher konnte nicht angefragt werden. ${describeError(cause)}`); }
    finally { finish(); }
  }
  async function toggleRule(rule: TaskRule): Promise<void> {
    if (!start('rule')) return;
    try {
      await planner.saveTaskRule({ ...rule, paused: !rule.paused, updatedAt: new Date().toISOString() });
      setMessage(rule.paused ? `„${rule.template.title}“ ist wieder aktiv. Bereits angelegte Aufgaben bleiben erhalten.` : `„${rule.template.title}“ wurde pausiert. Bereits angelegte Aufgaben bleiben erhalten.`);
    } catch (cause) { setError(`Die Wiederholungsregel konnte nicht geändert werden. ${describeError(cause)}`); }
    finally { finish(); }
  }
  async function exportMigrationBackup(): Promise<void> {
    if (!start('backup')) return;
    try {
      const backup = await repository.getLastMigrationBackup();
      setMigrationBackup(backup);
      if (!backup) throw new Error('Es ist keine Sicherung vor einer Datenmigration vorhanden.');
      await downloadBackup(backup, 'nexus-workspace-vor-migration');
      setMigrationError(null);
      setMessage('Die Sicherung vor der Datenmigration wurde dem Browser als Download übergeben. Zum Wiederherstellen wähle die Datei im Import aus.');
    } catch (cause) { setError(`Die Migrationssicherung konnte nicht exportiert werden. ${describeError(cause)}`); }
    finally { finish(); }
  }
  async function resetWorkspace(): Promise<void> {
    if (!resetConfirmed || resetPhrase !== 'ZURÜCKSETZEN' || !allowTransfer() || !start('reset')) return;
    let lockStarted = false;
    let committed = false;
    try {
      if (!await onFlush()) throw new Error('Aktuelle Änderungen konnten nicht gespeichert werden. Der Arbeitsbereich wurde nicht zurückgesetzt.');
      const current = await repository.exportWorkspace();
      await downloadBackup(current, 'nexus-workspace-vor-reset');
      const planning = emptyPlanning();
      planning.settings.onboardingDone = true;
      const empty: WorkspaceBackup = { format: 'nexus-workspace', version: 4, exportedAt: new Date().toISOString(), notes: [], planning };
      lockStarted = true;
      reloadContextRef.current = { committed: false, legacy: false, reset: true };
      markNeedsReload(true);
      onImportStart();
      // Backup and replacement share the existing atomic import transaction.
      await repository.importWorkspace(empty, 'replace');
      committed = true;
      reloadContextRef.current = { committed: true, legacy: false, reset: true };
      setResetOpen(false); setResetConfirmed(false); setResetPhrase('');
      await onImported();
      markNeedsReload(false);
      setDraftEdited(false);
      setMessage('Der Arbeitsbereich wurde zurückgesetzt. Der bisherige vollständige Stand ist als letzte lokale Sicherung verfügbar; sein Download wurde angestoßen. Prüfe die Datei im Download-Ordner.');
      await refreshBackup();
    } catch (cause) {
      if (committed) setError(`Der Arbeitsbereich wurde zurückgesetzt, aber die Ansicht konnte nicht aktualisiert werden. Aktualisiere zuerst die Ansicht unten. ${describeError(cause)}`);
      else if (lockStarted) {
        try {
          await onImported(); markNeedsReload(false); setDraftEdited(false);
          setError(`Das Zurücksetzen ist fehlgeschlagen. Der bisherige Datenbestand bleibt erhalten und wurde wieder geladen. ${describeError(cause)}`);
        } catch (reloadCause) { setError(`Das Zurücksetzen ist fehlgeschlagen. Der bisherige Datenbestand bleibt erhalten, konnte aber nicht erneut geladen werden. Aktualisiere zuerst die Ansicht. ${describeError(cause)} ${describeError(reloadCause)}`); }
      } else setError(`Das Zurücksetzen wurde angehalten. ${describeError(cause)}`);
    } finally { finish(); }
  }

  const deletedCount = notes.filter((note) => note.deletedAt !== null).length;
  const importedNotes = preview?.backup.notes ?? [];
  const importedDeletedCount = importedNotes.filter((note) => note.deletedAt !== null).length;
  const settingsStatus = planner.loading ? 'Einstellungen werden geladen …' : planner.loadError ? 'Einstellungen konnten nicht geladen werden' : operation === 'settings' ? 'Einstellungen werden gespeichert …' : unconfirmedSettings ? 'Speichern fehlgeschlagen – Eingaben bleiben erhalten' : dirty ? 'Noch nicht übernommene Änderungen' : planner.status === 'saving' ? 'Planung wird gespeichert …' : planner.status === 'error' ? 'Speichern fehlgeschlagen – Eingaben bleiben erhalten' : 'Einstellungen gespeichert';
  const Container = embedded ? 'section' : 'dialog';
  const exportHistory = [...(planner.data.settings.exportHistory ?? [])].reverse();
  const rules = planner.data.taskRules ?? [];

  return (
    <Container ref={embedded ? undefined : dialogRef} className={embedded ? 'settings-page settings-dialog settings-atelier' : 'dialog settings-dialog settings-atelier'} data-settings-topic={topic} data-settings-detail={mobileDetail} aria-labelledby={`${id}-title`} onCancel={(event) => { event.preventDefault(); close(); }}>
      <header className="dialog-header">
        <div><p className="eyebrow">NEXUS / Arbeitsbereich</p><h2 id={`${id}-title`}>Einstellungen<span className="settings-title-mark" aria-hidden="true">.</span></h2></div>
        <button type="button" className="icon-button" aria-label="Einstellungen schließen" title="Einstellungen schließen" onClick={close} disabled={disabled} autoFocus><X size={20} aria-hidden="true" /></button>
      </header>
      <div className="dialog-body settings-body">
        {error && <p className="settings-error" role="alert">{error}</p>}
        {message && <p className="info-box" role="status">{message}</p>}
        {busy && <p className="settings-progress" role="status">{operation === 'file' ? 'Datei wird geprüft …' : operation === 'import' ? 'Import wird gespeichert und die Ansicht geladen …' : operation === 'reload' ? 'Ansicht wird aktualisiert …' : operation === 'settings' ? 'Einstellungen werden gespeichert …' : operation === 'permission' || operation === 'storage' ? 'Browseranfrage läuft …' : operation === 'rule' ? 'Wiederholungsregel wird gespeichert …' : operation === 'reset' ? 'Sicherung und Zurücksetzen laufen …' : 'Sicherung wird vorbereitet …'} Bitte lasse die Einstellungen geöffnet.</p>}
        {needsReload && <div className="settings-warning"><p>{reloadContextRef.current?.committed ? 'Der Import ist bereits gespeichert.' : 'Der Datenbestand muss erneut geladen werden.'} Aktualisiere zuerst die Ansicht, bevor du weiterarbeitest. Bis dahin bleibt dieser Dialog geöffnet. Falls die Aktualisierung wiederholt fehlschlägt, lade die App im Browser neu.</p><button type="button" className="secondary-button" onClick={() => { void reloadImported(); }} disabled={busy}>Importierte Ansicht aktualisieren</button></div>}

        <div className="settings-category-layout">
        <nav className="settings-topics" aria-label="Einstellungsthemen">
          {SETTINGS_TOPICS.map(({ key, label, description, icon: Icon }) => <button key={key} type="button" ref={(button) => { topicButtonRefs.current[key] = button; }} aria-current={topic === key ? 'page' : undefined} aria-controls={`${id}-category-panel`} disabled={busy || needsReload} onClick={() => selectTopic(key)}><Icon size={19} aria-hidden="true" /><span><strong>{label}</strong><small>{description}</small></span><ChevronRight size={16} className="settings-topic-chevron" aria-hidden="true" /></button>)}
        </nav>
        <div className="settings-category-content" id={`${id}-category-panel`} aria-labelledby={`${id}-category-title`}>
          <button type="button" className="settings-categories-back secondary-button" onClick={showCategories} disabled={busy || needsReload}><ArrowLeft size={17} aria-hidden="true" />Alle Einstellungen</button>
          <h3 className="settings-category-title" id={`${id}-category-title`} tabIndex={-1} ref={panelHeadingRef}>{SETTINGS_TOPICS.find((item) => item.key === topic)?.label}</h3>
          <nav className="settings-data-topics" aria-label="Datenaktionen" hidden={topic !== 'data'}>
            {([{ key: 'backup', label: 'Sichern' }, { key: 'import', label: 'Importieren' }, { key: 'restore', label: 'Wiederherstellen' }, { key: 'storage', label: 'Browserspeicher' }, { key: 'reset', label: 'Zurücksetzen' }] as const).map(({ key, label }) => <button key={key} type="button" aria-current={dataTopic === key ? 'page' : undefined} disabled={disabled} onClick={() => setDataTopic(key)}>{label}</button>)}
          </nav>
        <section className="settings-section settings-personal" hidden={topic === 'account' || (topic === 'data' && dataTopic !== 'backup')} aria-label="Persönliche Einstellungen">
          <form id={`${id}-preferences-form`} noValidate onSubmit={(event) => { void saveSettings(event); }}>
            <fieldset className="settings-preferences" disabled={disabled || planner.loading || !!planner.loadError}>
              <legend className="sr-only">Persönliche Einstellungen</legend>
              <div id={`${id}-planning`} className="settings-preference-group" data-topic-group="planning" hidden={topic !== 'planning'}>
              <label className="field" htmlFor={`${id}-zone`}><span><Globe2 size={16} aria-hidden="true" /> Zeitzone</span><select id={`${id}-zone`} value={customZone ? 'custom' : draft.timeZone} onChange={(event) => { const value = event.currentTarget.value; setCustomZone(value === 'custom'); if (value !== 'custom') editSettings({ timeZone: value }); }}>
                {COMMON_ZONES.map((zone) => <option key={zone} value={zone}>{zone}</option>)}<option value="custom">Andere IANA-Zeitzone …</option>
              </select></label>
              {customZone && <label className="field" htmlFor={`${id}-custom-zone`}><span>Eigene IANA-Zeitzone</span><input id={`${id}-custom-zone`} value={draft.timeZone} maxLength={100} onChange={(event) => editSettings({ timeZone: event.currentTarget.value })} placeholder="Zum Beispiel Europe/Berlin" autoComplete="off" spellCheck={false} /></label>}
              <p className="settings-muted">Zeitzone für Termine und Zeitblöcke. Planungstage und Fälligkeiten bleiben unverändert.</p>
              <div className="settings-preferences-grid">
                <label className="field" htmlFor={`${id}-start`}><span>Startansicht</span><select id={`${id}-start`} value={draft.startView} onChange={(event) => editSettings({ startView: event.currentTarget.value as AppSettings['startView'] })}><option value="menu">Hauptmenü · Standard</option><option value="home">Dashboard</option><option value="last">Zuletzt verwendete Ansicht</option></select></label>
                <label className="field" htmlFor={`${id}-minutes`}><span>Tagesverfügbarkeit in Minuten</span><input id={`${id}-minutes`} type="number" min={0} max={1440} step={1} value={draft.availableMinutes} onChange={(event) => editSettings({ availableMinutes: event.currentTarget.value })} aria-describedby={`${id}-minutes-help`} /><small id={`${id}-minutes-help`}>0–1440 Minuten. Gilt für neue Tagespläne; vorhandene Tagesbudgets bleiben erhalten.</small></label>
              </div>
              </div>
              <div id={`${id}-display`} className="settings-preference-group" data-topic-group="display" hidden={topic !== 'display'}>
              <ThemeSettings id={id} choice={draft.theme} previewing={themePreviewing} onChange={(theme) => { editSettings({ theme }); setThemePreview(theme); setThemePreviewing(true); }} />
              <ParticleColorSettings id={id} color={draft.particleColor} onChange={(particleColor) => editSettings({ particleColor })} />
              <label className="field" htmlFor={`${id}-artifact-intensity`}><span>Artefakt-Intensität</span><select id={`${id}-artifact-intensity`} value={draft.artifactIntensity} onChange={(event) => editSettings({ artifactIntensity: event.currentTarget.value as SettingsDraft['artifactIntensity'] })}><option value="still">Still</option><option value="atmospheric">Atmosphärisch</option><option value="intense">Intensiv</option></select></label>
              <label className="field" htmlFor={`${id}-motion`}><span>Bewegung im Hauptmenü</span><select id={`${id}-motion`} value={draft.menuMotion} onChange={(event) => editSettings({ menuMotion: event.currentTarget.value as SettingsDraft['menuMotion'] })}><option value="still">Still</option><option value="float">Sanft schweben</option><option value="orbit">Umkreisen</option></select></label>
              <label className="settings-check"><input type="checkbox" checked={draft.matrixBackground} onChange={(event) => editSettings({ matrixBackground: event.currentTarget.checked })} /><span><strong>Matrix-Hintergrund anzeigen</strong></span></label>
              <label className="settings-check"><input type="checkbox" checked={draft.powerSaving} onChange={(event) => editSettings({ powerSaving: event.currentTarget.checked })} /><span><strong>Stromsparmodus</strong><small>Reduziert Effekte und Animationen. Die Systemeinstellung für reduzierte Bewegung gilt zusätzlich.</small></span></label>
              </div>
              <div className="settings-preference-group" data-topic-group="morning" hidden={topic !== 'morning'}>
                <MorningRoutineSettings value={draft.morningRoutine} onChange={(morningRoutine) => editSettings({ morningRoutine })} disabled={disabled || planner.loading || !!planner.loadError} />
                <AndroidAlarmSettings />
              </div>
              <div className="settings-preference-group" data-topic-group="planning" hidden={topic !== 'planning'}>
              <details className="settings-help settings-capacity-details"><summary>Verfügbare Zeit und Puffer</summary>
              <h4 className="settings-subheading">Verfügbare Zeit</h4>
              <label className="settings-check"><input type="checkbox" checked={draft.capacityEnabled} onChange={(event) => editSettings({ capacityEnabled: event.currentTarget.checked })} /><span><strong>Zeitfenster statt Tagesbudget verwenden</strong><small>Kapazität = Zeitfenster minus Puffer. Sonst gelten deine Tagesbudgets.</small></span></label>
              <div className={`settings-windows${draft.capacityEnabled ? '' : ' settings-windows-inactive'}`} aria-label="Verfügbare Zeitfenster je Wochentag">
                {draft.windows.map((window) => <div className="settings-window" key={window.weekday}>
                  <label className="settings-window-day"><input type="checkbox" checked={window.enabled} disabled={!draft.capacityEnabled} onChange={(event) => editWindow(window.weekday, { enabled: event.currentTarget.checked })} /><span>{WEEKDAYS[window.weekday - 1]}</span></label>
                  <label className="field"><span>Von<span className="sr-only"> am {WEEKDAYS[window.weekday - 1]}</span></span><input type="time" value={window.start} step={60} disabled={!draft.capacityEnabled || !window.enabled} onChange={(event) => editWindow(window.weekday, { start: event.currentTarget.value })} /></label>
                  <label className="field"><span>Bis<span className="sr-only"> am {WEEKDAYS[window.weekday - 1]}</span></span><input type="time" value={window.end} step={60} disabled={!draft.capacityEnabled || !window.enabled} onChange={(event) => editWindow(window.weekday, { end: event.currentTarget.value })} /></label>
                </div>)}
              </div>
              <label className="field" htmlFor={`${id}-buffer`}><span>Täglicher Puffer in Minuten</span><input id={`${id}-buffer`} type="number" min={0} max={1440} step={1} disabled={!draft.capacityEnabled} value={draft.bufferMinutes} onChange={(event) => editSettings({ bufferMinutes: event.currentTarget.value })} /><small>Termine und Blöcke werden gemeinsam betrachtet. Nicht verblockte Schätzungen und fehlende Schätzungen werden gesondert berücksichtigt.</small></label>
              </details>
              <h4 className="settings-subheading">Erinnerungen</h4>
              <label className="settings-check"><input type="checkbox" checked={draft.notifications} disabled={notificationPermission !== 'granted' && !draft.notifications} onChange={(event) => editSettings({ notifications: event.currentTarget.checked })} /><span><strong>Erinnerungen als Browsermeldung anzeigen</strong><small>Nur bei geöffneter App. Die Erinnerungszentrale funktioniert auch ohne Browserberechtigung.</small></span></label>
              <p className="settings-muted">Browserberechtigung: {notificationPermission === 'granted' ? 'erlaubt' : notificationPermission === 'denied' ? 'gesperrt – in den Website-Einstellungen des Browsers änderbar' : notificationPermission === 'unsupported' ? 'in diesem Browser nicht verfügbar' : 'noch nicht angefragt'}.</p>
              {notificationPermission === 'default' && <button type="button" className="secondary-button settings-permission-button" onClick={() => { void requestNotifications(); }}><Bell size={17} aria-hidden="true" /> Browsermeldungen erlauben</button>}
              </div>
              <div className="settings-preference-group" data-topic-group="data" hidden={topic !== 'data' || dataTopic !== 'backup'}>
              <label className="field" htmlFor={`${id}-backup-interval`}><span>Sicherungserinnerung nach Tagen</span><input id={`${id}-backup-interval`} type="number" min={0} max={365} step={1} value={draft.backupIntervalDays} onChange={(event) => editSettings({ backupIntervalDays: event.currentTarget.value })} /><small>0 deaktiviert die Erinnerung. 1–365 Tage seit dem letzten vollständigen Export oder der geprüften Ordnersicherung. Eine Sicherung musst du selbst starten.</small></label>
              </div>
              <div id={`${id}-ai-preferences`} className="settings-preference-group" data-topic-group="ai" hidden={topic !== 'ai'}>
              <label className="settings-check"><input type="checkbox" checked={draft.voiceReview} onChange={(event) => editSettings({ voiceReview: event.currentTarget.checked })} /><span><strong>Diktierte Aufgaben vor dem Speichern prüfen</strong><small>Auch eindeutig erkannte neue Aufgaben werden zuerst zur Bestätigung angezeigt. Unklare Angaben werden immer nachgefragt.</small></span></label>
              <label className="settings-check"><input type="checkbox" checked={draft.aiConsent} onChange={(event) => editSettings({ aiConsent: event.currentTarget.checked })} /><span><strong>OpenAI-Nutzung erlauben</strong><small>Ich erlaube das Senden ausdrücklich ausgewählter Texte und von mir gestarteter Sprachaufnahmen an OpenAI. API-Nutzung kann Kosten verursachen. Eine Aufnahme beginnt erst mit meinem Klick im Sprachdialog.</small></span></label>
              </div>
            </fieldset>
          </form>
        </section>

        <section className="settings-section settings-planning-section" hidden={topic !== 'planning'} aria-labelledby={`${id}-rules-title`}>
          <div className="settings-section-heading"><Pause size={19} aria-hidden="true" /><h3 id={`${id}-rules-title`}>Wiederkehrende Aufgaben</h3></div>
          <p>Pause stoppt neue Vorkommen; vorhandene Aufgaben und Fristen bleiben erhalten. Änderungen werden direkt gespeichert.</p>
          {rules.length === 0 ? <p className="settings-muted">Keine Regeln. Wiederholungen legst du in den Aufgabendetails an.</p> : <ul className="settings-rule-list">{rules.map((rule) => <li key={rule.id}><div><strong>{rule.template.title}</strong><small>{rule.frequency === 'daily' ? 'Täglich' : rule.frequency === 'weekdays' ? 'Werktags' : 'Wöchentlich'} · ab {rule.startDate}{rule.endDate ? ` bis ${rule.endDate}` : ''} · {rule.paused ? 'Pausiert' : 'Aktiv'}</small></div><button type="button" className="secondary-button" onClick={() => { void toggleRule(rule); }} disabled={disabled || planner.loading || !!planner.loadError} aria-label={`${rule.paused ? 'Fortsetzen' : 'Pausieren'}: ${rule.template.title}`}>{rule.paused ? 'Fortsetzen' : 'Pausieren'}</button></li>)}</ul>}
        </section>

        <section className="settings-section settings-data-section" hidden={topic !== 'data' || dataTopic !== 'backup'} aria-labelledby={`${id}-export-title`}>
          <div className="settings-section-heading"><Download size={19} aria-hidden="true" /><h3 id={`${id}-export-title`}>Sicherung exportieren</h3></div>
          <details className="settings-help"><summary>Was enthält die Sicherung?</summary><p>Notizen, Tags, Pins, Papierkorb, frühere Versionen sowie Aufgaben, Unteraufgaben, Termine, Zeitblöcke, Tages- und Wochenpläne, Beziehungen und Einstellungen. Audioaufnahmen und API-Schlüssel sind nicht enthalten.</p></details>
          <p className="settings-count">{notes.length - deletedCount} aktive Notizen · {deletedCount} im Papierkorb · {revisionCount(notes)} frühere Versionen<br />{planner.data.tasks.length} Aufgaben · {planner.data.appointments.length} Termine · {planner.data.timeBlocks.length} Zeitblöcke</p>
          <button type="button" className="secondary-button" onClick={() => { void exportCurrent(); }} disabled={disabled || dirty}><Download size={17} aria-hidden="true" /> JSON exportieren</button>
          {backupIsDue(planner.data.settings) && <p className="settings-warning settings-backup-due">Zeit für eine externe Sicherung. Prüfe nach dem Export die Datei in deinem Download-Ordner.</p>}
          <details className="settings-import-details settings-export-history"><summary>Exporte / Dateiübergaben · {exportHistory.length} Einträge</summary><p className="settings-muted">Vollständige Exporte und geprüfte Ordnersicherungen des aktuellen Arbeitsbereichs, höchstens 100 Einträge. Bei Downloads bestätigt die Historie nur die Übergabe an den Browser, nicht das Speichern einer Datei. Bei Ordnersicherungen wird das erneute Lesen separat bestätigt. Die Historie unterscheidet die Arten nicht; Downloads alter Wiederherstellungsstände werden nicht gezählt.</p>{exportHistory.length === 0 ? <p className="settings-muted">Noch keine vollständige Sicherung aus den Einstellungen verzeichnet.</p> : <ol>{exportHistory.map((at, index) => <li key={`${at}-${index}`}><time dateTime={at}>{formatDate(at, planner.data.settings.timeZone)}</time><span>Export / Dateiübergabe</span></li>)}</ol>}</details>
        </section>

        <div className="settings-folder-backup" hidden={topic !== 'data' || dataTopic !== 'backup'}><BackupPanel disabled={disabled || dirty} timeZone={planner.data.settings.timeZone} begin={() => allowTransfer() && start('backup')} finish={finish} onFlush={onFlush}
          onVerifiedSave={async (backup, verifiedAt) => {
            planner.updateSettings({ exportHistory: appendExportHistory(backup.planning.settings.exportHistory, verifiedAt) });
            if (!await planner.flush()) throw new Error('Die Sicherungshistorie konnte nicht gespeichert werden.');
          }}
          onImportPreview={(filename, backup) => { setPreview({ filename, backup, legacy: false, version: backup.version }); setMode('merge'); setConfirmed(false); setDataTopic('import'); }} /></div>

        <section className="settings-section settings-data-section" hidden={topic !== 'data' || dataTopic !== 'import'} aria-labelledby={`${id}-import-title`}>
          <div className="settings-section-heading"><Upload size={19} aria-hidden="true" /><h3 id={`${id}-import-title`}>Sicherung importieren</h3></div>
          <p>Wähle eine NEXUS-Arbeitsbereichssicherung oder eine bisherige Notizsicherung. Vor der Übernahme werden Format, Struktur und Beziehungen geprüft.</p>
          <details className="settings-help"><summary>Dateigrößen und ältere Sicherungen</summary><p>Höchstens 50 MiB insgesamt, davon höchstens 20 MiB Notizdaten. Unterstützte ältere Formate werden beim Lesen in den aktuellen Datenstand überführt.</p></details>
          <label className="field settings-file" htmlFor={`${id}-file`}><span><FileJson size={17} aria-hidden="true" /> JSON-Datei auswählen</span><input id={`${id}-file`} type="file" accept=".json,application/json" onChange={(event) => { void readFile(event); }} disabled={disabled || dirty} /></label>
          {preview && <section className="settings-import-preview" aria-labelledby={`${id}-preview-title`}>
            <h4 id={`${id}-preview-title`}>Importvorschau</h4>
            <p className="settings-filename">{preview.filename}</p>
            <p className="settings-muted">Sicherung vom {formatDate(preview.backup.exportedAt, planner.data.settings.timeZone)} · Formatversion {preview.version}</p>
            <dl className="settings-import-counts">
              <div><dt>Notizen gesamt</dt><dd>{importedNotes.length}</dd></div><div><dt>Im Papierkorb</dt><dd>{importedDeletedCount}</dd></div><div><dt>Frühere Versionen</dt><dd>{revisionCount(importedNotes)}</dd></div>
              <div><dt>Aufgaben</dt><dd>{preview.backup.planning.tasks.length}</dd></div><div><dt>Termine</dt><dd>{preview.backup.planning.appointments.length}</dd></div><div><dt>Zeitblöcke</dt><dd>{preview.backup.planning.timeBlocks.length}</dd></div>
              <div><dt>Tagespläne</dt><dd>{preview.backup.planning.days.length}</dd></div><div><dt>Wochenpläne</dt><dd>{preview.backup.planning.weeks.length}</dd></div><div><dt>Erfassungsprotokolle</dt><dd>{preview.backup.planning.operations.length}</dd></div>
              <div><dt>Wiederholungsregeln</dt><dd>{preview.backup.planning.taskRules?.length ?? 0}</dd></div><div><dt>Erinnerungen</dt><dd>{preview.backup.planning.reminders?.length ?? 0}</dd></div>
            </dl>
            {importedNotes.length > 0 ? <details className="settings-import-details"><summary>Notiztitel ansehen ({importedNotes.length})</summary><ul className="settings-import-notes">{importedNotes.map((note) => <li key={note.id}><span>{note.title.trim() || 'Ohne Titel'}</span><small>{note.deletedAt !== null ? 'Im Papierkorb · ' : ''}{note.revisions.length} frühere Versionen</small></li>)}</ul></details> : <p className="settings-warning">Diese Sicherung enthält keine Notizen. „Ersetzen“ würde deinen aktuellen Notizbestand leeren.</p>}
            {preview.backup.planning.tasks.length > 0 && <details className="settings-import-details"><summary>Aufgabentitel ansehen ({preview.backup.planning.tasks.length})</summary><ul className="settings-import-notes">{preview.backup.planning.tasks.map((task) => <li key={task.id}>{task.title}</li>)}</ul></details>}
            {preview.legacy && <p className="settings-warning" id={`${id}-legacy-warning`}>Version 1 enthält ausschließlich Notizen. Bei „Zusammenführen“ bleibt deine Planung erhalten. Bei „Ersetzen“ werden alle bestehenden Aufgaben, Termine, Zeitblöcke und Tages-/Wochenpläne entfernt und die Einstellungen auf die Standardwerte zurückgesetzt.</p>}
            <fieldset className="settings-import-mode" disabled={disabled || dirty}>
              <legend>Wie sollen die Daten übernommen werden?</legend>
              <label><input type="radio" name={`${id}-mode`} value="merge" checked={mode === 'merge'} onChange={() => { setMode('merge'); setConfirmed(false); }} /><span><strong>Zusammenführen</strong><small>Vorhandene Daten und Einstellungen bleiben erhalten. Importierte Einträge erhalten bei ID-Kollisionen neue IDs; Beziehungen werden angepasst. Tages-/Wochentexte werden mit Trenner ergänzt, vorhandene Top 3 werden bis höchstens drei Aufgaben ergänzt. Bestehende Tagesbudgets bleiben erhalten.</small></span></label>
              <label><input type="radio" name={`${id}-mode`} value="replace" checked={mode === 'replace'} onChange={() => { setMode('replace'); setConfirmed(false); }} /><span><strong>Ersetzen</strong><small>Der gesamte Arbeitsbereich einschließlich Notizen, Papierkorb, Versionen, Planung und Einstellungen wird durch den angezeigten Bestand ersetzt.</small></span></label>
            </fieldset>
            {mode === 'replace' && <p className="settings-warning">Vor dem Ersetzen wird eine vollständige Sicherung zum Download übergeben. Zusätzlich speichert NEXUS den bisherigen Arbeitsbereich in derselben Transaktion wie den Import als letzte lokale Sicherung. Bewahre den Download auf.</p>}
            <label className="settings-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.currentTarget.checked)} disabled={disabled || dirty} aria-describedby={preview.legacy ? `${id}-legacy-warning` : undefined} /><span>{preview.legacy ? mode === 'replace' ? 'Ich bestätige das Ersetzen meines gesamten aktuellen Notizbestands.' : 'Ich bestätige das Hinzufügen der angezeigten Notizen.' : mode === 'replace' ? 'Ich bestätige das Ersetzen meines gesamten aktuellen Arbeitsbereichs einschließlich Planung und Einstellungen.' : 'Ich bestätige das Zusammenführen der angezeigten Notizen und Planungsdaten.'}</span></label>
            <div className="settings-import-actions"><button type="button" className="secondary-button" onClick={() => { setPreview(null); setConfirmed(false); }} disabled={disabled}>Verwerfen</button><button type="button" className="primary-button" onClick={() => { void importPreview(); }} disabled={disabled || dirty || !confirmed}>Import bestätigen</button></div>
          </section>}
        </section>

        <section className="settings-section settings-data-section" hidden={topic !== 'data' || dataTopic !== 'restore'} aria-labelledby={`${id}-restore-title`}>
          <div className="settings-section-heading"><ArchiveRestore size={19} aria-hidden="true" /><h3 id={`${id}-restore-title`}>Vorherigen Stand sichern</h3></div>
          <p>Vor einem Import wird der vorherige vollständige Arbeitsbereich zusätzlich lokal gesichert. Jeder weitere Import erneuert diese Sicherung. Sie liegt im selben Browserspeicher und ersetzt keine externe Sicherungsdatei.</p>
          {backupLoading ? <p className="settings-muted">Lokale Sicherung wird geprüft …</p> : lastBackup ? <p className="settings-count">{lastBackup.notes.length} Notizen · {planningCounts(lastBackup)}<br />Gesichert am {formatDate(lastBackup.exportedAt, planner.data.settings.timeZone)}</p> : <p className="settings-muted">Noch keine vollständige Sicherung vor einem Import vorhanden.</p>}
          {backupError && <p className="settings-error" role="alert">{backupError}</p>}
          <button type="button" className="secondary-button" onClick={() => { void exportLastBackup(); }} disabled={disabled || backupLoading || (!lastBackup && !backupError)}><ArchiveRestore size={17} aria-hidden="true" /> Vorherige Sicherung herunterladen</button>
          <p className="settings-muted">Zum Wiederherstellen lädst du diese Datei herunter, wählst sie oben aus und bestätigst den Import.</p>
          {migrationBackup && <div className="settings-migration-backup"><h4 className="settings-subheading">Sicherung vor Datenmigration</h4><p className="settings-muted">Automatisch vor der Aktualisierung des Datenmodells gesichert: {formatDate(migrationBackup.exportedAt, planner.data.settings.timeZone)} · {migrationBackup.notes.length} Notizen · {planningCounts(migrationBackup)}. Diese separate Sicherung wird durch weitere Importe nicht ersetzt.</p><button type="button" className="secondary-button" onClick={() => { void exportMigrationBackup(); }} disabled={disabled}><ArchiveRestore size={17} aria-hidden="true" /> Migrationssicherung herunterladen</button></div>}
          {migrationError && <p className="settings-error" role="alert">{migrationError}</p>}
        </section>

        <section className="settings-section settings-ai-section" hidden={topic !== 'ai'} aria-labelledby={`${id}-ai-title`}>
          <div className="settings-section-heading"><Sparkles size={19} aria-hidden="true" /><h3 id={`${id}-ai-title`}>KI & Sprache</h3></div>
          <p className="settings-backend-state">{backendLoading ? 'Lokales KI-Backend wird geprüft …' : backendStatus?.configured ? 'Lokales KI-Backend ist eingerichtet.' : backendStatus ? 'Lokales KI-Backend ist erreichbar, OpenAI ist noch nicht eingerichtet.' : 'Lokales KI-Backend ist derzeit nicht erreichbar.'}</p>
          {backendError && <p className="settings-muted">{backendError}</p>}
          {backendStatus && <dl className="settings-models"><div><dt>Transkription</dt><dd>{backendStatus.transcriptionModel}</dd></div><div><dt>Text & Planung</dt><dd>{backendStatus.textModel}</dd></div></dl>}
          {backendStatus?.configured ? <p>Eine Konfiguration bestätigt keinen erfolgreichen OpenAI-Aufruf. Erst eine gestartete KI-Anfrage oder Sprachaufnahme prüft den Dienst. API-Nutzung wird separat abgerechnet.</p> : <><p>Notizen, Planung und manueller KI-Web-Modus bleiben verfügbar. API-Schlüssel werden ausschließlich im lokalen Backend eingerichtet.</p><details className="settings-help"><summary>Direkte KI einrichten</summary><p>Lokales Backend mit <code>npm run api</code> starten und den OpenAI-Zugang dort über <code>OPENAI_API_KEY</code> einrichten. In NEXUS wird kein Schlüssel eingegeben oder gespeichert.</p></details></>}
          <button type="button" className="secondary-button" onClick={() => { void checkBackend(); }} disabled={disabled || backendLoading}>Backend erneut prüfen</button>
          <p className="settings-muted">Eine Statusprüfung sendet keine Notizen oder Sprachaufnahmen an OpenAI. Audio wird nur vorübergehend für die Verarbeitung gehalten und ist in keiner Sicherung enthalten.</p>
        </section>

        <section className="settings-section settings-account-section" hidden={topic !== 'account'} aria-labelledby={`${id}-account-title`}>
          <div className="settings-section-heading"><UserRound size={19} aria-hidden="true" /><h4 id={`${id}-account-title`}>Dein Zugang</h4></div>
          <p>{account ? <>Angemeldet{account.email ? <> als <strong>{account.email}</strong></> : ''}.</> : 'Du verwendest den lokalen Arbeitsbereich ohne Cloud-Anmeldung.'}</p>
          <p className="settings-muted">Die Anmeldung allein synchronisiert keine Daten. Aufgaben, Notizen und Routinen liegen derzeit im Browserspeicher dieses Geräts.</p>
          <div className="settings-account-state"><span>Automatische Gerätesynchronisierung</span><strong>Noch nicht eingerichtet</strong></div>
          <button type="button" className="secondary-button" disabled={disabled} onClick={() => selectTopic('data')}><HardDrive size={17} aria-hidden="true" />Daten manuell übertragen</button>
        </section>

        <section className="settings-section settings-storage-info" hidden={topic !== 'data' || dataTopic !== 'storage'} aria-labelledby={`${id}-storage-title`}>
          <div className="settings-section-heading"><HardDrive size={19} aria-hidden="true" /><h3 id={`${id}-storage-title`}>Lokal. Bewusst einfach.</h3></div>
          <p>Notizen und Planung werden in IndexedDB in diesem Browser auf diesem Gerät gespeichert. Der Browserspeicher ist begrenzt. Browserdaten löschen, privater Modus oder automatische Speicherbereinigung können Daten entfernen.</p>
          <p>Exportiere regelmäßig und bewahre Sicherungen außerhalb des Browsers auf.</p>
          <details className="settings-help"><summary>Browserwechsel, Datentransfer und Offlinebetrieb</summary>
          <p>Die Daten gehören zur jeweiligen Adresse mit Protokoll, Host und Port. Ein anderer Browser, ein anderes Profil oder eine andere App-Adresse hat einen eigenen Datenbestand.</p>
          <p>Es gibt keine automatische Gerätesynchronisation. Übertrage Änderungen manuell per Export und Import. Zusammenführen behält bei kollidierenden IDs beide Fassungen und ihre Beziehungen bei.</p>
          <p>Die lokalen Notiz- und Planungsfunktionen benötigen keinen KI-Dienst oder API-Schlüssel. Nach dem vollständigen Laden der Produktionsversion kann die App auch offline genutzt werden.</p></details>
          <div className="settings-persistent-storage"><p><strong>Beständiger Browserspeicher</strong><br />{persistent === true ? 'Vom Browser zugesagt.' : !navigator.storage?.persist ? 'In diesem Browser nicht verfügbar.' : persistent === false ? 'Bisher nicht zugesagt.' : 'Speicherstatus wird geprüft …'} Eine Zusage schützt vor automatischer Speicherbereinigung, nicht vor manuellem Löschen der Browserdaten.</p>{storageError && <p className="settings-muted">{storageError}</p>}<button type="button" className="secondary-button" onClick={() => { void requestStorage(); }} disabled={disabled || persistent === true || !navigator.storage?.persist}><ShieldCheck size={17} aria-hidden="true" /> Beständigen Speicher anfragen</button></div>
        </section>

        <section className="settings-section settings-danger" hidden={topic !== 'data' || dataTopic !== 'reset'} aria-labelledby={`${id}-reset-title`}>
          <div className="settings-section-heading"><Trash2 size={19} aria-hidden="true" /><h3 id={`${id}-reset-title`}>Arbeitsbereich zurücksetzen</h3></div>
          <p>Entfernt alle Notizen einschließlich Papierkorb und Verlauf sowie Aufgaben, Termine, Zeitblöcke, Erinnerungen und Einstellungen aus dem aktiven Arbeitsbereich. Vorher wird eine vollständige Sicherung zum Download übergeben und zusätzlich lokal aufbewahrt.</p>
          {!resetOpen ? <button type="button" className="secondary-button" disabled={disabled || dirty} onClick={() => setResetOpen(true)}>Zurücksetzen vorbereiten</button> : <div className="settings-reset-confirmation">
            <label className="settings-confirm"><input type="checkbox" checked={resetConfirmed} disabled={disabled || dirty} onChange={(event) => setResetConfirmed(event.currentTarget.checked)} /><span>Ich möchte meinen gesamten Arbeitsbereich leeren. Ich bewahre die vorherige Sicherung außerhalb des Browsers auf.</span></label>
            <label className="field" htmlFor={`${id}-reset-phrase`}><span>Zum Bestätigen ZURÜCKSETZEN eingeben</span><input id={`${id}-reset-phrase`} autoComplete="off" spellCheck={false} value={resetPhrase} disabled={disabled || dirty} onChange={(event) => setResetPhrase(event.currentTarget.value)} /></label>
            <div className="settings-import-actions"><button type="button" className="secondary-button" disabled={disabled} onClick={() => { setResetOpen(false); setResetConfirmed(false); setResetPhrase(''); }}>Abbrechen</button><button type="button" className="secondary-button settings-reset-button" disabled={disabled || dirty || !resetConfirmed || resetPhrase !== 'ZURÜCKSETZEN'} onClick={() => { void resetWorkspace(); }}>Sichern und endgültig zurücksetzen</button></div>
          </div>}
        </section>
        </div>
        </div>
      </div>
      <footer className="dialog-footer settings-persistent-actions">
        <div className="settings-action-state"><p className="settings-save-state" role="status">{settingsStatus}</p>{(planner.error || planner.loadError) && <p className="settings-error">{planner.error || planner.loadError}</p>}{dirty && <p className="settings-muted">Änderungen bleiben beim Kategorienwechsel erhalten.</p>}</div>
        <div className="settings-import-actions"><button type="button" className="secondary-button" onClick={() => { void resetSettings(); }} disabled={!dirty || disabled}>Änderungen verwerfen</button><button type="submit" form={`${id}-preferences-form`} className="primary-button" disabled={disabled || planner.loading || !!planner.loadError}>Einstellungen speichern</button><button type="button" className="secondary-button settings-close-action" onClick={close} disabled={disabled}>Schließen</button></div>
      </footer>
    </Container>
  );
}

