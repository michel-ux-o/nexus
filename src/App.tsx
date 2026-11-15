import './note-actions.css';
import { useAccount } from './auth/AccountBoundary';
import { useAndroidMorningRequest } from './alarm';
import './layout/DashboardAtelier.css';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, CloudOff, Copy, Download, FileText, ListPlus, LoaderCircle, MoreHorizontal, Pin, Plus, RotateCcw, Settings, Sparkles, Trash2, X } from 'lucide-react';
import { useNotes } from './state/useNotes';
import { Sidebar } from './sidebar/Sidebar';
import { NoteEditor } from './editor/NoteEditor';
import { AIPanel } from './ai/AIPanel';
import { SettingsDialog } from './settings/SettingsDialog';
import { BackupReminder } from './settings/BackupReminder';
import { downloadText } from './settings/download';
import type { Selection } from './types';
import { usePlanner } from './planning/usePlanner';
import { todayInZone, startOfWeek } from './planning/dates';
import type { Appointment, BlockDefaults, Reminder, Task, TimeBlock, View, WorkspaceViewProps } from './planning/types';
import { repository } from './data/repository';
import { makeWorkspaceBackup } from './data/workspaceBackup';
import { MainMenu } from './menu/MainMenu';
import { WorkspaceHeader } from './layout/WorkspaceHeader';
import { SearchDialog } from './search/SearchDialog';
import { QuickCapture } from './capture/QuickCapture';
import { TasksView } from './tasks/TasksView';
import { CalendarView } from './calendar/CalendarView';
import { RemindersView } from './reminders/RemindersView';
import { ReminderDialog } from './reminders/ReminderDialog';
import { ReminderMonitor } from './reminders/ReminderMonitor';
import { UndoBar } from './planning/UndoBar';
import { Onboarding } from './onboarding/Onboarding';
import { createDemoWorkspace } from './onboarding/demo';
import { AppNav } from './layout/AppNav';
import { HomeView } from './home/HomeView';
import { TodayView } from './planning/views/TodayView';
import { WeekView } from './planning/views/WeekView';
import { TaskDialog } from './planning/components/TaskDialog';
import { AppointmentDialog } from './planning/components/AppointmentDialog';
import { TimeBlockDialog } from './planning/components/TimeBlockDialog';
import { PlanningAIPanel } from './ai/PlanningAIPanel';
import { VoicePanel } from './voice/VoicePanel';
import { useTheme } from './themes/useTheme';
import { HorizonHome, resetHorizonDraftIdentities } from './horizon/HorizonHome';
import { ParticleLandscape } from './horizon/ParticleLandscape';
import { HorizonDock, HorizonHeader } from './horizon/HorizonShell';
import { emitHorizonScene } from './horizon/sceneEvents';
import { committedSceneChange, type CommittedSceneSnapshot } from './horizon/committedScene';

const ROUTES: Record<View, string> = { menu: '/', home: '/dashboard', tasks: '/aufgaben', notes: '/notizen', today: '/tagesplanung', week: '/wochenplanung', calendar: '/kalender', reminders: '/erinnerungen', settings: '/einstellungen', ai: '/ki' };
function routeView(): View | undefined { return (Object.keys(ROUTES) as View[]).find(key => `#${ROUTES[key]}` === window.location.hash); }

type Overlay = null | { kind: 'settings' | 'noteAI' | 'planningAI' | 'voice' | 'search' | 'capture' }
  | { kind: 'task'; task?: Task; defaults?: Partial<Task> }
  | { kind: 'appointment'; appointment?: Appointment; date?: string; defaults?: Partial<Appointment> }
  | { kind: 'reminder'; reminder?: Reminder; defaults?: Partial<Reminder> }
  | { kind: 'block'; block?: TimeBlock; defaults?: BlockDefaults };

export default function App() {
  const account = useAccount();
  const store = useNotes();
  const planner = usePlanner();
  const theme = useTheme(planner.data.settings.theme);
  const horizon = theme === 'nexus';
  const [focusTaskId, setFocusTaskId] = useState<string | undefined>();
  const [horizonFocus, setHorizonFocus] = useState(false);
  const committedScene = useRef<CommittedSceneSnapshot | null>(null);
  const [area, setArea] = useState<View>('menu');
  const [date, setDate] = useState(() => todayInZone('Europe/Berlin'));
  const [week, setWeek] = useState(() => startOfWeek(todayInZone('Europe/Berlin')));
  const [view, setView] = useState<'notes' | 'trash'>('notes');
  const [mobileEditor, setMobileEditor] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [workspaceEpoch, setWorkspaceEpoch] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [toast, setToast] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [demoNeedsReload, setDemoNeedsReload] = useState(false);
  const [onboardingHold, setOnboardingHold] = useState(false);
  const actionLock = useRef(false);
  const initialized = useRef(false);
  const entrySet = useRef(false);
  const importing = useRef(false);
  const reloadInFlight = useRef<Promise<void> | null>(null);
  const settingsGuard = useRef<(() => boolean) | null>(null);
  const setSettingsGuard = useRef((guard: (() => boolean) | null) => { settingsGuard.current = guard; }).current;
  const navigation = useRef(0);
  const todayMaterialized = useRef('');
  const materializing = useRef('');
  const materializeFailure = useRef({ key: '', at: 0 });
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const note = store.activeNote;
  if (!store.loading && !store.loadError && !planner.loading && !planner.loadError) initialized.current = true;

  useAndroidMorningRequest(async () => {
    if (importing.current || actionLock.current || overlay || busy || store.loading || planner.loading ||
        store.loadError || planner.loadError || !planner.data.settings.onboardingDone) return false;
    // Never interrupt an open settings draft with repeated discard prompts.
    if (area === 'settings' || settingsGuard.current) return false;
    const morningNavigation = navigation.current;
    if (!await flushAll() || morningNavigation !== navigation.current || importing.current) return false;
    const current = todayInZone(planner.data.settings.timeZone);
    try {
      await planner.materializeMorningRoutine(current);
      if (morningNavigation !== navigation.current || importing.current) return false;
      setDate(current);
      setFocusTaskId(undefined);
      remember('home');
      setSelection(null);
      setActionError('');
      return true;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Die Morgenroutine konnte noch nicht geöffnet werden.');
      return false;
    }
  }, { enabled: !planner.loading && !store.loading && !planner.loadError && !store.loadError });

  useEffect(() => {
    if (planner.loading || planner.loadError || entrySet.current) return;
    entrySet.current = true;
    const initial = routeView() ?? (planner.data.settings.startView === 'last' ? planner.data.settings.lastView : planner.data.settings.startView);
    setArea(initial);
    window.history.replaceState(null, '', `#${ROUTES[initial]}`);
    const current = todayInZone(planner.data.settings.timeZone);
    setDate(current); setWeek(startOfWeek(current));
  }, [planner.loading, planner.loadError, planner.data.settings]);

  useEffect(() => {
    const changed = () => {
      const next = routeView();
      if (!next || next === area) return;
      if (importing.current || actionLock.current || overlay || (settingsGuard.current && !settingsGuard.current())) { window.history.replaceState(null, '', `#${ROUTES[area]}`); return; }
      const request = ++navigation.current;
      void flushAll().then(ok => {
        if (request !== navigation.current) return;
        if (ok && !importing.current) { setArea(next); planner.updateSettings({ lastView: next }); setSelection(null); }
        else window.history.replaceState(null, '', `#${ROUTES[area]}`);
      }).catch(error => { setActionError(String(error)); window.history.replaceState(null, '', `#${ROUTES[area]}`); });
    };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  });

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k' || event.altKey) return;
      event.preventDefault();
      if (!overlay && !document.querySelector('dialog[open]')) open({ kind: event.shiftKey ? 'capture' : 'search' });
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  });

  useEffect(() => {
    const check = () => {
      if (planner.loading || planner.loadError || importing.current || !planner.data.settings.onboardingDone) return;
      const current = todayInZone(planner.data.settings.timeZone);
      const key = `${workspaceEpoch}:${current}:${JSON.stringify(planner.data.taskRules)}:${JSON.stringify(planner.data.settings.morningRoutine)}`;
      if (key === todayMaterialized.current || key === materializing.current ||
        (materializeFailure.current.key === key && Date.now() - materializeFailure.current.at < 60_000)) return;
      materializing.current = key;
      void planner.materializeRecurring(current, current).then(() => planner.materializeMorningRoutine(current)).then(() => { todayMaterialized.current = key; })
        .catch(error => { materializeFailure.current = { key, at: Date.now() }; setActionError(String(error)); })
        .finally(() => { if (materializing.current === key) materializing.current = ''; });
    };
    check(); const timer = window.setInterval(check, 60_000);
    return () => window.clearInterval(timer);
  }, [planner, workspaceEpoch]);

  useEffect(() => { setSelection(null); }, [store.activeId]);
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(''), 4000);
    return () => window.clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    if (confirmDelete) deleteDialog.current?.showModal();
    else deleteDialog.current?.close();
  }, [confirmDelete]);

  useEffect(() => {
    if (busy || importing.current || store.loading || planner.loading || store.loadError || planner.loadError) return;
    const knownIds = new Set(store.notes.map(item => item.id));
    if (!planner.data.tasks.some(task => task.noteIds.some(id => !knownIds.has(id))) && !planner.data.taskRules?.some(rule => rule.template.noteIds.some(id => !knownIds.has(id)))) return;
    // A deferred delete can commit on the global Retry path. Reconcile only links,
    // retaining every planning draft instead of replacing it with a database reload.
    try {
      planner.update(data => ({ ...data, tasks: data.tasks.map(task => task.noteIds.some(id => !knownIds.has(id))
        ? { ...task, noteIds: task.noteIds.filter(id => knownIds.has(id)) } : task),
        taskRules: data.taskRules?.map(rule => ({ ...rule, template: { ...rule.template, noteIds: rule.template.noteIds.filter(id => knownIds.has(id)) } })) }), { recordUndo: false });
    } catch (error) { setActionError(error instanceof Error ? error.message : 'Die Notizverknüpfungen konnten nicht aktualisiert werden.'); }
  }, [busy, store.loading, store.loadError, store.notes, planner.loading, planner.loadError, planner.data.tasks, planner.data.taskRules, planner.update]);

  async function act(task: () => Promise<void>) {
    if (actionLock.current || importing.current) return;
    actionLock.current = true;
    setBusy(true);
    setActionError('');
    try { await task(); }
    catch (error) { setActionError(error instanceof Error ? error.message : 'Die Aktion konnte nicht abgeschlossen werden. Bitte erneut versuchen.'); }
    finally { actionLock.current = false; setBusy(false); }
  }

  async function flushAll() {
    const results = await Promise.all([store.flush(), planner.flush()]);
    return results.every(Boolean);
  }
  function remember(next: View) {
    setArea(next);
    if (window.location.hash !== `#${ROUTES[next]}`) window.history.pushState(null, '', `#${ROUTES[next]}`);
    if (planner.data.settings.lastView !== next) planner.updateSettings({ lastView: next });
  }
  function navigate(next: View) {
    if (importing.current || actionLock.current) return;
    if (next !== area && settingsGuard.current && !settingsGuard.current()) return;
    const request = ++navigation.current;
    void flushAll().then(ok => { if (ok && request === navigation.current && !importing.current) { remember(next); setSelection(null); setActionError(''); } }).catch(error => setActionError(String(error)));
  }
  function open(next: Exclude<Overlay, null>) { void act(async () => { if (await flushAll()) setOverlay(next); }); }
  const editTask = (task?: Task, defaults?: Partial<Task>) => open({ kind: 'task', task, defaults });
  const editAppointment = (appointment?: Appointment, chosenDate?: string, defaults?: Partial<Appointment>) => open({ kind: 'appointment', appointment, date: chosenDate, defaults });
  const editBlock = (block?: TimeBlock, defaults?: BlockDefaults) => open({ kind: 'block', block, defaults });
  const editReminder = (reminder?: Reminder, defaults?: Partial<Reminder>) => open({ kind: 'reminder', reminder, defaults });
  const closeOverlay = () => { if (!importing.current) setOverlay(null); };
  const viewProps: WorkspaceViewProps = { planner, notes: store.notes, onEditTask: editTask, onEditAppointment: editAppointment, onEditBlock: editBlock, onOpenNote: select, onDictate: () => open({ kind: 'voice' }), onAI: () => open({ kind: 'planningAI' }), onNavigate: navigate, onCreateNote: create, onEditReminder: editReminder, onQuickCapture: () => open({ kind: 'capture' }) };
  const saveStatus = store.status === 'error' || planner.status === 'error' ? 'error' : store.status === 'saving' || planner.status === 'saving' ? 'saving' : 'saved';
  useEffect(() => {
    if (saveStatus !== 'saved' || store.loading || planner.loading || store.loadError || planner.loadError || importing.current) return;
    const next = { planning: planner.data, notes: store.notes, epoch: workspaceEpoch, undoRevision: planner.undoRevision };
    const previous = committedScene.current;
    committedScene.current = next;
    if (!previous || !horizon) return;
    const change = committedSceneChange(previous, next);
    // Home emits its own exact awaited operation, including retry cleanup. The
    // global observer covers workspace actions, overlays and the common Undo bar.
    if (change && (area !== 'home' && area !== 'menu' || overlay !== null || next.undoRevision > previous.undoRevision)) emitHorizonScene(change);
  }, [saveStatus, store.loading, planner.loading, store.loadError, planner.loadError, planner.data, store.notes, workspaceEpoch, horizon, area, overlay, planner.undoRevision]);
  useEffect(() => { if (area !== 'menu' && area !== 'home') { setHorizonFocus(false); setFocusTaskId(undefined); } }, [area]);
  async function captureDayNote(title: string, content: string, chosenDate: string, operationId?: string) {
    if (importing.current) throw new Error('Der Arbeitsbereich wird gerade importiert.');
    await store.captureNote(operationId ?? crypto.randomUUID(), title, content, `tag:${chosenDate}`);
  }
  async function saveWorkspaceDraft() {
    try {
      await downloadText('nexus-entwurf.json', JSON.stringify({ format: 'nexus-workspace', version: 4, exportedAt: new Date().toISOString(), notes: store.notes, planning: planner.data }), 'application/json');
      setToast('Der aktuelle Entwurf wurde als JSON zur Dateisicherung übergeben.');
    } catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
  }

  function create() {
    if (area !== 'notes' && settingsGuard.current && !settingsGuard.current()) return;
    void act(async () => {
      if (!await planner.flush()) return;
      remember('notes');
      setView('notes');
      setMobileEditor(true);
      await store.createNote();
    });
  }
  function select(id: string) {
    if (actionLock.current || importing.current) return;
    if (area !== 'notes' && settingsGuard.current && !settingsGuard.current()) return;
    const request = ++navigation.current;
    void (async () => {
      if (area !== 'notes' && !await flushAll()) return;
      if (request !== navigation.current || importing.current) return;
      if (await store.selectNote(id) && request === navigation.current && !importing.current) { remember('notes'); setView(store.notes.find(n => n.id === id)?.deletedAt ? 'trash' : 'notes'); setSelection(null); setMobileEditor(true); }
    })().catch(error => setActionError(error instanceof Error ? error.message : 'Die Notiz konnte nicht geöffnet werden.'));
  }
  function changeView(next: 'notes' | 'trash') {
    void act(async () => {
      if (await store.selectNote(null)) { setView(next); setMobileEditor(false); }
    });
  }
  function openSettings() {
    if (area === 'notes') open({ kind: 'settings' });
    else navigate('settings');
  }

  async function captureNote(title: string, content: string, operationId?: string) {
    if (importing.current) throw new Error('Der Arbeitsbereich wird gerade importiert.');
    await store.captureNote(operationId ?? crypto.randomUUID(), title, content);
  }
  function beginImport() {
    resetHorizonDraftIdentities();
    importing.current = true; ++navigation.current; store.setBlocked(true); planner.setBlocked(true);
    setWorkspaceEpoch(epoch => epoch + 1);
  }
  function finishImport(): Promise<void> {
    if (reloadInFlight.current) return reloadInFlight.current;
    const job = (async () => {
      const results = await Promise.allSettled([store.reload(), planner.reload()]);
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      store.setBlocked(false); planner.setBlocked(false); importing.current = false;
      setView('notes'); setSelection(null); setMobileEditor(false);
      setDemoNeedsReload(false);
    })();
    reloadInFlight.current = job.finally(() => { reloadInFlight.current = null; });
    return reloadInFlight.current;
  }
  const settingsProps = { notes: store.notes, planner, onClose: closeOverlay, onFlush: flushAll, onImportStart: beginImport, onImported: finishImport };
  const isEmpty = !store.notes.length && !planner.data.tasks.length && !planner.data.appointments.length && !planner.data.timeBlocks.length && !(planner.data.reminders?.length) && !(planner.data.taskRules?.length) && !planner.data.days.length && !planner.data.weeks.length;
  const showOnboarding = onboardingHold || (!store.loading && !planner.loading && !store.loadError && !planner.loadError && isEmpty && !planner.data.settings.onboardingDone);
  async function startEmpty() {
    setOnboardingHold(true);
    planner.updateSettings({ onboardingDone: true });
    if (!await planner.flush()) throw new Error('Der Einstieg konnte nicht gespeichert werden. Bitte erneut versuchen.');
    setOnboardingHold(false);
  }
  async function startDemo() {
    if (!isEmpty) throw new Error('Beispieldaten werden nur in einen leeren Arbeitsbereich geladen.');
    if (!await flushAll()) throw new Error('Bitte zuerst die ausstehenden Änderungen speichern.');
    const demo = createDemoWorkspace();
    demo.planning.settings.onboardingDone = true;
    beginImport();
    try { await repository.importWorkspace(makeWorkspaceBackup(demo.notes, demo.planning), 'replace'); }
    catch (error) { store.setBlocked(false); planner.setBlocked(false); importing.current = false; throw error; }
    try { await finishImport(); } catch (error) { setDemoNeedsReload(true); setActionError('Die Beispiele wurden gespeichert, konnten aber nicht vollständig geladen werden. Bitte den Arbeitsbereich erneut laden.'); throw error; }
  }
  async function saveDraft() {
    if (!note) return;
    try {
      await downloadText(`${(note.title || 'Unbenannte Notiz').replace(/[<>:"/\\|?*]/g, '_')}.txt`, `${note.title}\n\n${note.content}\n\nTags: ${note.tags.join(', ')}`, 'text/plain;charset=utf-8');
      setToast('Text-Sicherung wurde zur Dateisicherung übergeben.');
    } catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
  }

  if ((store.loading || planner.loading) && !initialized.current) return <main className="startup-state" aria-live="polite"><LoaderCircle className="spin" /><h1>NEXUS</h1><p>Dein Arbeitsbereich wird geladen …</p></main>;
  if ((store.loadError || planner.loadError) && !initialized.current) return <main className="startup-state"><CloudOff size={40} /><h1>Arbeitsbereich konnte nicht geladen werden</h1><p role="alert">{store.loadError || planner.loadError}</p><p>Deine Daten werden nicht durch einen leeren Stand ersetzt.</p><button className="primary-button" onClick={() => void act(async () => { await Promise.all([store.reload(), planner.reload()]); })}>Erneut laden</button>{actionError && <p role="alert">{actionError}</p>}</main>;

  return <div className={`nexus-app${area === 'menu' ? ' nexus-menu-mode' : ' nexus-atelier'}${area === 'home' ? ' nexus-dashboard-atelier' : ''}${horizon ? ' nexus-horizon' : ''}`} data-power-saving={planner.data.settings.powerSaving} data-scene-motion={planner.data.settings.powerSaving || planner.data.settings.menuMotion === 'still' || planner.data.settings.artifactIntensity === 'still' ? 'static' : 'animated'}>
    {horizon && <ParticleLandscape key={workspaceEpoch} view={area === 'menu' ? 'home' : area} focus={horizonFocus} particleColor={planner.data.settings.particleColor} powerSaving={planner.data.settings.powerSaving} still={planner.data.settings.menuMotion === 'still' || planner.data.settings.artifactIntensity === 'still'} />}
    {horizon && <HorizonHeader view={area} onNavigate={navigate} onDictate={viewProps.onDictate} />}
    {!horizon && area !== 'menu' && <AppNav view={area} onNavigate={navigate} onCreateNote={create} onCreateTask={() => editTask()} onDictate={viewProps.onDictate} onAI={() => navigate('ai')} onSettings={openSettings} onSearch={() => open({ kind: 'search' })} onQuickCapture={viewProps.onQuickCapture} />}
    <div className="main-stage" aria-busy={busy}>
      {demoNeedsReload && <div className="save-error" role="alert"><p>Die Beispieldaten sind gespeichert. Der Arbeitsbereich bleibt bis zum vollständigen Neuladen gesperrt.</p><button onClick={() => { void finishImport().catch(error => setActionError(String(error))); }}>Arbeitsbereich erneut laden</button></div>}
      {!horizon && area !== 'menu' && <WorkspaceHeader {...viewProps} atelier noteStatus={store.status} noteLoadError={store.loadError} onSettingsPanel={openSettings} onSearch={() => open({ kind: 'search' })} />}
      {(saveStatus === 'error' || actionError) && <div className="save-error global-save-error" role="alert"><div><strong>{saveStatus === 'error' ? 'Speichern fehlgeschlagen' : 'Aktion nicht abgeschlossen'}</strong><p>{store.error || store.loadError || planner.error || planner.loadError || actionError || 'Deine Eingabe bleibt erhalten.'}</p></div><div className="error-actions"><button onClick={() => void act(async () => { if (await flushAll()) setToast('Änderungen gespeichert.'); })}><RotateCcw size={16} />Erneut speichern</button>{note && <button onClick={saveDraft}><Download size={16} />Text sichern</button>}<button onClick={saveWorkspaceDraft}><Download size={16} />Entwurf als JSON sichern</button></div></div>}
      <div className="area-content">
      {!showOnboarding && <UndoBar planner={planner} disabled={busy || importing.current || overlay !== null} />}
      {!showOnboarding && <BackupReminder planner={planner} onOpen={openSettings} />}
      <div key={area} className="nexus-view-enter">
      {!horizon && area === 'menu' && <MainMenu {...viewProps} theme={theme} onAI={() => navigate('ai')} onSearch={() => open({ kind: 'search' })} />}
      {!horizon && area === 'home' && <HomeView {...viewProps} onCaptureNote={captureNote} />}
      {horizon && (area === 'menu' || area === 'home') && <HorizonHome {...viewProps} noteStatus={store.status} workspaceEpoch={workspaceEpoch} date={date} onDateChange={setDate} onOpenCalendar={chosen => { setDate(chosen); navigate('calendar'); }} onSearch={() => open({ kind: 'search' })} onFocusChange={setHorizonFocus} initialFocusTaskId={focusTaskId} onCaptureNote={captureDayNote} />}
      {area === 'tasks' && <TasksView {...viewProps} workspaceEpoch={workspaceEpoch} horizon={horizon} onFocusTask={id => { setFocusTaskId(id); navigate('home'); }} />}
      {area === 'calendar' && <CalendarView {...viewProps} selectedDate={horizon ? date : undefined} onSelectedDateChange={horizon ? setDate : undefined} onOpenDay={horizon ? chosen => { setDate(chosen); navigate('home'); } : undefined} />}
      {area === 'reminders' && <RemindersView {...viewProps} />}
      {area === 'settings' && <SettingsDialog {...settingsProps} embedded onGuardChange={setSettingsGuard} onClose={() => navigate('menu')} />}
      {area === 'ai' && <PlanningAIPanel planner={planner} notes={store.notes} workspaceEpoch={workspaceEpoch} embedded onClose={() => navigate('menu')} />}
      {area === 'today' && <TodayView {...viewProps} date={date} onDateChange={setDate} />}
      {area === 'week' && <WeekView {...viewProps} weekStart={week} onWeekChange={setWeek} onOpenDay={chosen => { setDate(chosen); navigate('today'); }} />}
      {area === 'notes' && <div className={`app-shell${mobileEditor ? ' mobile-editor' : ''}`}>
    <div className="sidebar-pane"><Sidebar timeZone={planner.data.settings.timeZone} notes={store.notes} activeId={store.activeId} onSelect={select} onCreate={create} onSettings={openSettings} view={view} onViewChange={changeView} /></div>
    <main className="workspace" aria-busy={busy}>
      <header className="workspace-topbar">
        <div className="breadcrumb"><button className="icon-button mobile-back" aria-label="Zur Notizliste" onClick={() => void act(async () => { if (await store.flush()) setMobileEditor(false); })}><ArrowLeft size={19} /></button><strong>{view === 'trash' ? 'Papierkorb' : 'Notizen'}</strong></div>
        <div className="workspace-actions">
          <button className="icon-button mobile-new" aria-label="Neue Notiz" title="Neue Notiz" onClick={create} disabled={busy}><Plus size={20} /></button>
          {note && !note.deletedAt && <>
            <button className={`icon-button${note.pinned ? ' is-active' : ''}`} aria-label={note.pinned ? 'Loslösen' : 'Anheften'} title={note.pinned ? 'Loslösen' : 'Anheften'} aria-pressed={note.pinned} onClick={() => store.updateNote({ pinned: !note.pinned })}><Pin size={18} /></button>
            <details className="note-actions-menu" onBlur={event => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false;
            }} onKeyDown={event => {
              if (event.key === 'Escape' && event.currentTarget.open) {
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.open = false;
                event.currentTarget.querySelector('summary')?.focus();
              }
            }}>
              <summary aria-label="Weitere Notizaktionen" title="Weitere Notizaktionen"><MoreHorizontal size={18} aria-hidden="true" /></summary>
              <div className="note-actions-menu-panel">
                <button type="button" disabled={busy} onClick={event => {
                  const menu = event.currentTarget.closest('details');
                  if (menu) { menu.open = false; menu.querySelector('summary')?.focus(); }
                  void act(async () => { await store.duplicateNote(); setToast('Notiz dupliziert.'); });
                }}><Copy size={18} aria-hidden="true" /> Duplizieren</button>
              </div>
            </details>
            <button className="icon-button" aria-label="In Papierkorb" title="In Papierkorb" disabled={busy} onClick={() => void act(async () => { await store.trashNote(); setToast('Notiz in den Papierkorb verschoben.'); })}><Trash2 size={18} /></button>
            <span className="toolbar-divider" />
            <button className="ai-trigger" onClick={() => open({ kind: 'noteAI' })} title="KI-Assistent"><Sparkles size={17} /><span>KI-Assistent</span></button>
          </>}
          <button className="icon-button workspace-settings" aria-label="Einstellungen" title="Einstellungen" onClick={openSettings}><Settings size={18} /></button>
        </div>
      </header>
      {note ? <>
        {note.deletedAt && <div className="trash-banner"><span>Diese Notiz liegt im Papierkorb.</span><div><button onClick={() => void act(async () => { await store.restoreNote(); setView('notes'); setToast('Notiz wiederhergestellt.'); })}><RotateCcw size={16} />Wiederherstellen</button><button className="danger-button" onClick={() => setConfirmDelete(true)}><Trash2 size={16} />Endgültig löschen</button></div></div>}
        {!note.deletedAt && <div className="note-task-links"><button className="text-button" disabled={!selection?.text} onClick={() => { if (selection && note.content.slice(selection.start, selection.end) === selection.text) editTask(undefined, { title: selection.text.trim().split('\n')[0].slice(0, 300), description: selection.text, noteIds: [note.id] }); }}><ListPlus size={16} />Markierung als Aufgabe</button>{planner.data.tasks.filter(task => task.noteIds.includes(note.id)).map(task => <button key={task.id} className="linked-task" onClick={() => editTask(task)}>{task.title}</button>)}</div>}
        <NoteEditor timeZone={planner.data.settings.timeZone} key={note.id} note={note} onChange={store.updateNote} onSelectionChange={setSelection} onAI={() => open({ kind: 'noteAI' })} onRestoreRevision={store.restoreRevision} />
      </> : <section className="empty-state"><div className="empty-orbit" aria-hidden="true"><FileText size={36} strokeWidth={1.2} /></div><h1>{view === 'trash' ? 'Papierkorb' : 'Eine neue Seite.'}</h1><p>{view === 'trash' ? 'Wähle eine gelöschte Notiz aus, um sie wiederherzustellen oder endgültig zu löschen.' : 'Halte deinen nächsten Gedanken fest.'}</p><button className="primary-button" onClick={create}><Plus size={18} />Neue Notiz</button></section>}
    </main>
    </div>}
    </div>
    </div>
    <footer className="app-bottom-status">{account && <button disabled={busy || overlay !== null} onClick={() => void act(async () => { if (settingsGuard.current && !settingsGuard.current()) return; if (await flushAll()) await account.logout(); })}>Abmelden</button>}<span className={`save-status ${saveStatus}`} role="status">{saveStatus === 'saving' ? <LoaderCircle size={13} className="spin" /> : saveStatus === 'saved' ? <Check size={13} /> : <CloudOff size={13} />}{saveStatus === 'saving' ? 'Wird gespeichert' : saveStatus === 'saved' ? 'Gespeichert' : 'Speichern fehlgeschlagen'}</span><span>Nur auf diesem Gerät · {planner.data.settings.timeZone}</span></footer>
    </div>
    {horizon && <HorizonDock view={area} onNavigate={navigate} onSearch={() => open({ kind: 'search' })} onQuickCapture={viewProps.onQuickCapture} />}
    {overlay?.kind === 'settings' && <SettingsDialog {...settingsProps} />}
    {overlay?.kind === 'search' && <SearchDialog {...viewProps} onClose={closeOverlay} />}
    {overlay?.kind === 'capture' && <QuickCapture planner={planner} onClose={closeOverlay} onCreateNote={captureNote} />}
    {overlay?.kind === 'reminder' && <ReminderDialog planner={planner} reminder={overlay.reminder} defaults={overlay.defaults} onClose={closeOverlay} />}
    {showOnboarding && <Onboarding planner={planner} onEmpty={startEmpty} onDemo={startDemo} />}
    {!showOnboarding && <ReminderMonitor planner={planner} onOpen={() => navigate('reminders')} />}
    {overlay?.kind === 'task' && <TaskDialog planner={planner} notes={store.notes} task={overlay.task} defaults={overlay.defaults} onClose={closeOverlay} />}
    {overlay?.kind === 'appointment' && <AppointmentDialog planner={planner} appointment={overlay.appointment} date={overlay.date} defaults={overlay.defaults} onClose={closeOverlay} />}
    {overlay?.kind === 'block' && <TimeBlockDialog planner={planner} block={overlay.block} defaults={overlay.defaults} onClose={closeOverlay} />}
    {overlay?.kind === 'voice' && <VoicePanel planner={planner} workspaceEpoch={workspaceEpoch} onClose={closeOverlay} onEditTask={editTask} />}
    {overlay?.kind === 'planningAI' && <PlanningAIPanel planner={planner} notes={store.notes} workspaceEpoch={workspaceEpoch} onClose={closeOverlay} />}
    {overlay?.kind === 'noteAI' && note && !note.deletedAt && <AIPanel note={note} selection={selection} consent={planner.data.settings.aiConsent} onConsent={() => planner.updateSettings({ aiConsent: true })} workspaceEpoch={workspaceEpoch} onClose={closeOverlay} onApply={(content, range, metadata) => { if (importing.current) throw new Error('Der Arbeitsbereich wird gerade importiert.'); store.applyAI(content, range, metadata); setOverlay(null); setSelection(null); setToast('Vorschlag übernommen. Das Original findest du im Verlauf.'); }} />}
    <dialog ref={deleteDialog} className="dialog confirm-dialog" aria-labelledby="delete-title" onCancel={() => setConfirmDelete(false)} onClose={() => setConfirmDelete(false)}><div className="dialog-header"><h2 id="delete-title">Notiz endgültig löschen?</h2><button aria-label="Schließen" className="icon-button" onClick={() => setConfirmDelete(false)}><X size={20} /></button></div><div className="dialog-body"><p>„{note?.title || 'Unbenannte Notiz'}“ und ihr Verlauf werden dauerhaft von diesem Gerät entfernt. Verknüpfte Aufgaben bleiben erhalten; ihre Verbindung zu dieser Notiz wird gelöst.</p></div><div className="dialog-footer"><button autoFocus className="secondary-button" onClick={() => setConfirmDelete(false)}>Abbrechen</button><button className="danger-button" disabled={busy} onClick={() => void act(async () => { planner.setBlocked(true); try { if (!await flushAll()) return; await store.permanentlyDelete(); await planner.reload(); setConfirmDelete(false); setToast('Notiz endgültig gelöscht.'); } finally { planner.setBlocked(false); } })}>Endgültig löschen</button></div></dialog>
    {toast && <div className="toast" role="status"><Check size={16} />{toast}</div>}
  </div>;
}
