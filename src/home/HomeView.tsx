import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Bell, CalendarDays, CalendarPlus, Check, CheckCheck, ChevronDown, Clock3, FilePlus2, ListPlus, LoaderCircle, Mic, NotebookPen, Pin, RotateCcw, SlidersHorizontal, Sparkles, Square } from 'lucide-react';
import type { Note } from '../types';
import { DEFAULT_DASHBOARD, type DashboardSection, type PlannerViewProps, type Reminder, type Task, type View } from '../planning/types';
import { addDays, dateInZone, formatDate, formatTime, todayInZone } from '../planning/dates';
import { tasksForDay } from '../planning/selectors';
import { capacityForDay } from '../planning/capacity';
import { reminderOccurrences, reminderOverdueSummary } from '../planning/reminders';
import { HomeCapture } from './HomeCapture';
import { minutesLabel, notePreview, shortDate, upcomingItems, type UpcomingItem } from './dashboard';
import './HomeView.css';

export interface HomeViewProps extends PlannerViewProps {
  onNavigate: (view: View) => void;
  onCreateNote: () => void;
  onCaptureNote?: (title: string, content: string, operationId: string) => Promise<void>;
  onEditReminder?: (reminder?: Reminder, defaults?: Partial<Reminder>) => void;
  onQuickCapture?: () => void;
}

const sectionLabels: Record<DashboardSection, string> = {
  priority: 'Heute wichtig', tasks: 'Überfällige & erledigte Aufgaben', progress: 'Kennzahlen & Kapazität',
  upcoming: 'Als Nächstes', notes: 'Notizen', capture: 'Schnellerfassung', ai: 'KI & Sprache',
};

function NoteLinks({ notes, timeZone, today, onOpenNote }: { notes: Note[]; timeZone: string; today: string; onOpenNote: (id: string) => void }) {
  return <ul className="home-note-list">
    {notes.map(note => {
      const date = dateInZone(note.updatedAt, timeZone);
      const title = note.title.trim() || 'Unbenannte Notiz';
      const relativeDate = date === today ? 'Heute' : date === addDays(today, -1) ? 'Gestern' : shortDate(date, today);
      return <li key={note.id}><button className="home-note-link" type="button" onClick={() => onOpenNote(note.id)} aria-label={'Notiz öffnen: ' + title}>
        <span className="home-note-icon" aria-hidden="true">{note.pinned ? <Pin size={15} /> : <NotebookPen size={16} />}</span>
        <span className="home-note-copy"><span className="home-note-title">{title}</span><span className="home-note-preview">{notePreview(note.content) || 'Noch kein Text'}</span>
          <span className="home-note-meta"><time dateTime={note.updatedAt} title={formatDate(date) + ', ' + formatTime(note.updatedAt, timeZone) + ' (' + timeZone + ')'}>{relativeDate}, {formatTime(note.updatedAt, timeZone)}</time>{note.tags.slice(0, 2).map(tag => <span className="home-note-tag" key={tag}>#{tag}</span>)}</span>
        </span><ArrowUpRight className="home-note-arrow" size={14} aria-hidden="true" />
      </button></li>;
    })}
  </ul>;
}

function TaskMeta({ task, today }: { task: Task; today: string }) {
  return <span className="home-task-meta">
    {(task.tags ?? []).slice(0, 2).map(tag => <span className="home-tag" key={tag}>{tag}</span>)}
    {task.status === 'progress' && <span>In Bearbeitung</span>}
    {task.estimatedMinutes !== null && <span><Clock3 size={11} aria-hidden="true" />{minutesLabel(task.estimatedMinutes)}</span>}
    {task.dueDate && <span className={task.status !== 'done' && task.dueDate < today ? 'is-overdue' : ''}>Fällig {task.dueDate === today ? 'heute' : shortDate(task.dueDate, today)}</span>}
    {task.noteIds.length > 0 && <span><NotebookPen size={11} aria-hidden="true" />{task.noteIds.length} {task.noteIds.length === 1 ? 'Notiz' : 'Notizen'}</span>}
  </span>;
}

function TaskList({ tasks, today, busy, onEditTask, onToggle, numbered = false }: { tasks: Task[]; today: string; busy: string | null; onEditTask: (task: Task) => void; onToggle: (task: Task) => void; numbered?: boolean }) {
  return <ul className={'home-task-list' + (numbered ? ' home-focus-list' : '')}>{tasks.map((task, index) => <li key={task.id} className={task.status === 'done' ? 'is-done' : ''}>
    {numbered && <span className="home-task-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>}
    <button className={'home-task-check' + (task.status === 'done' ? ' is-checked' : '')} type="button" disabled={busy !== null} aria-label={(task.status === 'done' ? 'Wieder öffnen: ' : 'Als erledigt markieren: ') + task.title} onClick={() => onToggle(task)}>
      {busy === task.id ? <LoaderCircle size={17} className="spin" aria-hidden="true" /> : task.status === 'done' ? <Check size={17} aria-hidden="true" /> : <Square size={17} strokeWidth={1.2} aria-hidden="true" />}
    </button>
    <button className="home-task-open" type="button" onClick={() => onEditTask(task)} aria-label={'Aufgabe bearbeiten: ' + task.title}><span className="home-task-title">{task.title}</span><TaskMeta task={task} today={today} /><ArrowUpRight className="home-task-arrow" size={14} aria-hidden="true" /></button>
    {task.priority && <span className={'home-priority-dot is-' + task.priority} role="img" aria-label={'Priorität: ' + (task.priority === 'high' ? 'Hoch' : task.priority === 'normal' ? 'Normal' : 'Niedrig')} />}
  </li>)}</ul>;
}

function UpcomingList({ items, today, onOpen }: { items: UpcomingItem[]; today: string; onOpen: (item: UpcomingItem) => void }) {
  return <ol className="home-upcoming-list">{items.map(item => <li key={item.id} className={'home-upcoming-' + item.kind}><button type="button" onClick={() => onOpen(item)} aria-label={item.label + ' öffnen: ' + item.title}>
    <span className="home-upcoming-time"><time dateTime={item.dateTime}>{!item.time ? 'Ganztägig' : item.ongoing ? 'Jetzt' : item.time}</time><span>{item.date === today ? 'Heute' : item.date === addDays(today, 1) ? 'Morgen' : shortDate(item.date, today)}</span></span>
    <span className="home-upcoming-copy"><strong>{item.title}</strong><span>{item.kind === 'appointment' ? <CalendarDays size={11} aria-hidden="true" /> : item.kind === 'reminder' ? <Bell size={11} aria-hidden="true" /> : <Clock3 size={11} aria-hidden="true" />}{item.label}{item.ongoing && ' · läuft'}{item.adjusted && ' · Zeitumstellung angepasst'}</span></span>
  </button></li>)}</ol>;
}

export function HomeView({ planner, notes, onNavigate, onCreateNote, onCaptureNote, onEditTask, onEditAppointment, onEditBlock, onEditReminder, onOpenNote, onDictate, onAI, onQuickCapture }: HomeViewProps) {
  const [now, setNow] = useState(() => new Date());
  const [actionError, setActionError] = useState('');
  const [actionStatus, setActionStatus] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const actionLock = useRef(false);
  const retryAction = useRef<{ key: string; run: () => Promise<void>; success: string } | null>(null);
  const viewMenu = useRef<HTMLDetailsElement>(null);
  const { data } = planner;
  const timeZone = data.settings.timeZone;
  const today = todayInZone(timeZone, now);
  const through = addDays(today, 13);
  const ready = !planner.loading && !planner.loadError;
  const sections = data.settings.dashboardSections ?? DEFAULT_DASHBOARD;
  const visible = (section: DashboardSection) => sections.includes(section);

  useEffect(() => {
    const update = () => setNow(new Date());
    const timer = window.setInterval(update, 30_000);
    const onVisible = () => { if (document.visibilityState === 'visible') update(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', update);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', update); };
  }, []);

  const day = data.days.find(item => item.date === today);
  const todayTasks = useMemo(() => tasksForDay(data, today), [data, today]);
  const openTasks = todayTasks.filter(task => task.status !== 'done');
  const doneTasks = todayTasks.filter(task => task.status === 'done');
  const focusTasks = useMemo(() => {
    const open = todayTasks.filter(task => task.status !== 'done');
    const byId = new Map(open.map(task => [task.id, task]));
    const chosen = [...new Set(day?.priorityTaskIds ?? [])].map(id => byId.get(id)).filter((task): task is Task => task !== undefined);
    const chosenIds = new Set(chosen.map(task => task.id));
    const priorityRank = { high: 0, normal: 1, low: 2 };
    const remaining = open.filter(task => !chosenIds.has(task.id)).sort((left, right) =>
      Number(!(left.dueDate && left.dueDate <= today)) - Number(!(right.dueDate && right.dueDate <= today))
      || priorityRank[left.priority ?? 'normal'] - priorityRank[right.priority ?? 'normal']
      || (left.dueDate ?? '9999-12-31').localeCompare(right.dueDate ?? '9999-12-31')
      || Number(right.status === 'progress') - Number(left.status === 'progress')
      || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    return [...chosen, ...remaining].slice(0, 3);
  }, [todayTasks, day?.priorityTaskIds, today]);
  const showFocus = visible('priority');
  const focusIds = new Set(showFocus ? focusTasks.map(task => task.id) : []);
  const overdue = data.tasks.filter(task => task.status !== 'done' && task.dueDate !== null && task.dueDate < today)
    .sort((left, right) => left.dueDate!.localeCompare(right.dueDate!) || left.createdAt.localeCompare(right.createdAt));
  const otherOverdue = overdue.filter(task => !focusIds.has(task.id));
  const focusOverdueCount = overdue.length - otherOverdue.length;
  const capacity = useMemo(() => capacityForDay(data, today), [data, today]);
  const occurrences = useMemo(() => reminderOccurrences(data, addDays(today, -28), through, now), [data, today, through, now]);
  const olderReminders = useMemo(() => reminderOverdueSummary(data, now), [data, now]);
  const olderReminderCount = olderReminders.reduce((count, item) => count + item.count, 0);
  const overdueReminderCount = olderReminderCount + occurrences.filter(item => item.status === 'pending' && Date.parse(item.effectiveAt) < now.getTime()).length;
  const upcoming = useMemo(() => upcomingItems(data, today, through, now, occurrences), [data, today, through, now, occurrences]);
  const nextAppointment = useMemo(() => upcomingItems(data, today, '9999-12-31', now, [])
    .filter((item): item is Extract<UpcomingItem, { kind: 'appointment' }> => item.kind === 'appointment')
    .sort((left, right) => left.date.localeCompare(right.date)
      || Number(Boolean(right.appointment.allDay)) - Number(Boolean(left.appointment.allDay))
      || Date.parse(left.dateTime) - Date.parse(right.dateTime) || left.id.localeCompare(right.id))[0], [data, today, now]);
  const outlook = upcoming.filter(item => item.id !== nextAppointment?.id);
  const activeNotes = useMemo(() => notes.filter(note => !note.deletedAt)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id)), [notes]);
  const pinnedNotes = activeNotes.filter(note => note.pinned);
  const recentNotes = activeNotes.filter(note => !note.pinned).slice(0, 3);
  const hasDetails = visible('tasks') || visible('upcoming') || visible('progress') || visible('notes') || visible('ai');

  async function perform(key: string, action: () => Promise<void>, success = '') {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(key);
    setActionError('');
    setActionStatus('');
    retryAction.current = { key, run: action, success };
    try { await action(); retryAction.current = null; setActionStatus(success); }
    catch (error) { setActionError(error instanceof Error ? error.message : 'Die Änderung konnte nicht gespeichert werden. Dein Entwurf bleibt erhalten.'); }
    finally { actionLock.current = false; setBusy(null); }
  }

  function toggleTask(task: Task) {
    const status = task.status === 'done' ? 'open' : 'done';
    void perform(task.id, () => planner.setTaskStatus(task.id, status), status === 'done' ? 'Aufgabe als erledigt gespeichert.' : 'Aufgabe wieder geöffnet und gespeichert.');
  }

  function saveSections(next: DashboardSection[]) {
    void perform('sections', async () => {
      planner.updateSettings({ dashboardSections: next });
      if (!await planner.flush()) throw new Error('Die Ansicht konnte noch nicht gespeichert werden. Deine Auswahl bleibt erhalten; bitte erneut versuchen.');
    }, 'Ansicht gespeichert.');
  }

  function openUpcoming(item: UpcomingItem) {
    if (item.kind === 'appointment') onEditAppointment(item.appointment);
    else if (item.kind === 'block') onEditBlock(item.block);
    else if (onEditReminder) onEditReminder(item.occurrence.reminder);
    else onNavigate('reminders');
  }

  return <section className="home-view" aria-labelledby="home-title">
    <div className="home-content">
      <header className="home-heading">
        <div className="home-intro"><span className="home-eyebrow"><span aria-hidden="true" />Dein persönlicher Raum</span><h1 id="home-title">Dein Tag <span>im Blick<span className="home-title-period">.</span></span></h1>
          <p>{ready ? openTasks.length + ' geplante ' + (openTasks.length === 1 ? 'Aufgabe offen' : 'Aufgaben offen') + ' · ' + minutesLabel(capacity.usedMinutes) + ' eingeplant' : 'Dein persönlicher Überblick.'}</p>
        </div>
        <div className="home-heading-aside">
          <svg className="home-dimension" viewBox="0 0 180 180" fill="none" aria-hidden="true"><path className="home-dimension-outer" d="M25 43 98 12 159 48 159 126 87 167 25 131Z" /><path d="m25 43 62 38 72-33M87 81v86M98 12v76l-73 43m73-43 61 38" /><path className="home-dimension-inner" d="m57 61 42-19 32 19v44l-40 23-34-21Zm0 0 34 22 40-22M91 83v45M99 42v42l-42 23m42-23 32 21" /><path className="home-dimension-guide" d="M7 148h105M141 11v134" /><circle cx="87" cy="81" r="3" /></svg>
          <time className="home-date" dateTime={today} aria-label={formatDate(today, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}><span className="home-date-weekday">{formatDate(today, { weekday: 'long' })}</span><span className="home-date-day">{Number(today.slice(8, 10))}</span><span className="home-date-month">{formatDate(today, { month: 'long', year: 'numeric' })}</span></time>
        <details className="home-view-menu" ref={viewMenu} onKeyDown={event => { if (event.key === 'Escape' && viewMenu.current?.open) { viewMenu.current.open = false; viewMenu.current.querySelector('summary')?.focus(); event.preventDefault(); } }}>
          <summary><SlidersHorizontal size={15} aria-hidden="true" />Ansicht</summary>
          <div className="home-view-options"><p>Auf deinem Dashboard</p>
            {DEFAULT_DASHBOARD.map(section => <label key={section}><input type="checkbox" checked={visible(section)} disabled={!ready || busy !== null} onChange={() => saveSections(visible(section) ? sections.filter(value => value !== section) : [...sections, section])} />{sectionLabels[section]}</label>)}
            <button className="home-text-button" type="button" disabled={!ready || busy !== null} onClick={() => saveSections([...DEFAULT_DASHBOARD])}><RotateCcw size={13} aria-hidden="true" />Standard wiederherstellen</button>
          </div>
        </details>
        </div>
      </header>

      {actionError && <div className="home-error" role="alert"><span>{actionError}</span><button className="home-quiet-button" type="button" disabled={busy !== null} onClick={() => { const failed = retryAction.current; if (failed) void perform(failed.key, failed.run, failed.success); }}><RotateCcw size={15} aria-hidden="true" />Erneut speichern</button></div>}
      <div className="home-action-status" role="status">{busy === 'sections' ? 'Ansicht wird gespeichert …' : actionStatus}</div>

      {planner.loading ? <div className="home-loading" role="status"><LoaderCircle size={18} className="spin" aria-hidden="true" />Deine Tagesplanung wird geladen …</div> : planner.loadError ? <div className="home-error" role="alert"><span>Die Planung konnte nicht geladen werden: {planner.loadError}</span><button className="home-quiet-button" type="button" disabled={busy !== null} onClick={() => void perform('reload', planner.reload)}><RotateCcw size={15} aria-hidden="true" />Erneut laden</button></div> : <>
        {(showFocus || visible('upcoming')) && <div className={'home-dashboard-grid' + (!showFocus || !visible('upcoming') ? ' is-single-column' : '')}>
          {showFocus && <section className="home-panel home-next-step" aria-labelledby="home-focus-title">
            <div className="home-focus-heading"><h2 id="home-focus-title"><span className="home-section-index" aria-hidden="true">01</span>Heute wichtig</h2><button className="home-text-button" type="button" onClick={() => onNavigate('today')}>Prioritäten wählen<ArrowUpRight size={14} aria-hidden="true" /></button></div>
            {focusTasks.length ? <TaskList tasks={focusTasks} today={today} busy={busy} onEditTask={onEditTask} onToggle={toggleTask} numbered /> : <div className="home-focus-empty"><h3>{doneTasks.length ? 'Deine Tagesaufgaben sind erledigt.' : 'Was möchtest du heute angehen?'}</h3><p>{doneTasks.length ? 'Du hast alle für heute geplanten Aufgaben geschafft.' : 'Für heute ist noch keine Aufgabe eingeplant. Lege eine Aufgabe an oder wähle sie in der Tagesplanung.'}</p></div>}
            <div className="home-panel-footer"><button className="home-text-button" type="button" onClick={() => onNavigate('today')}>{openTasks.length > focusTasks.length ? 'Alle ' + openTasks.length + ' offenen Tagesaufgaben' : 'Tagesplanung öffnen'}<ArrowRight size={14} aria-hidden="true" /></button><button className="home-icon-button" type="button" onClick={() => onEditTask(undefined, { plan: { kind: 'day', date: today } })} aria-label="Neue Aufgabe für heute"><ListPlus size={18} aria-hidden="true" /></button></div>
          </section>}

          {visible('upcoming') && <section className="home-panel home-upcoming" aria-labelledby="home-upcoming-title"><div className="home-panel-heading"><h2 id="home-upcoming-title"><span className="home-section-index" aria-hidden="true">02</span>Nächster Termin</h2><button className="home-icon-button" type="button" aria-label="Kalender öffnen" onClick={() => onNavigate('calendar')}><ArrowUpRight size={16} aria-hidden="true" /></button></div>
            {nextAppointment ? <UpcomingList items={[nextAppointment]} today={today} onOpen={openUpcoming} /> : <div className="home-empty home-upcoming-empty"><CalendarDays size={24} strokeWidth={1.2} aria-hidden="true" /><p>Kein kommender Termin.</p><button className="home-text-button" type="button" onClick={() => onEditAppointment(undefined, today)}><CalendarPlus size={15} aria-hidden="true" />Termin anlegen</button></div>}
            <div className="home-panel-footer"><button className="home-text-button" type="button" onClick={() => onNavigate('calendar')}>Kalender<ArrowRight size={14} aria-hidden="true" /></button><button className="home-text-button" type="button" onClick={() => onNavigate('reminders')}>Erinnerungen<ArrowRight size={14} aria-hidden="true" /></button></div>
          </section>}
        </div>}

        {visible('tasks') && overdue.length > 0 && <details className="home-panel home-overdue"><summary id="home-overdue-title"><Clock3 size={16} aria-hidden="true" /><span>Überfällig</span><span className="home-count">{overdue.length}</span><ChevronDown className="home-disclosure-arrow" size={16} aria-hidden="true" /></summary>
          {focusOverdueCount > 0 && <p className="home-overdue-hint">{otherOverdue.length ? focusOverdueCount + ' davon stehen bereits oben unter „Heute wichtig“.' : 'Alle überfälligen Aufgaben stehen bereits oben unter „Heute wichtig“.'}</p>}
          {otherOverdue.length > 0 && <TaskList tasks={otherOverdue.slice(0, 3)} today={today} busy={busy} onEditTask={onEditTask} onToggle={toggleTask} />}
          <div className="home-panel-footer"><button className="home-text-button" type="button" onClick={() => onNavigate('tasks')}>Alle Aufgaben<ArrowUpRight size={14} aria-hidden="true" /></button>{otherOverdue.length > 3 && <span>{otherOverdue.length - 3} weitere überfällige Aufgaben in der Aufgabenübersicht</span>}</div>
        </details>}

        {visible('upcoming') && overdueReminderCount > 0 && <button className="home-reminder-notice home-overview-notice" type="button" onClick={() => onNavigate('reminders')}><Bell size={16} aria-hidden="true" /><span><strong>{overdueReminderCount} {overdueReminderCount === 1 ? 'Erinnerung ausstehend' : 'Erinnerungen ausstehend'}</strong>{olderReminderCount > 0 && <small>Davon {olderReminderCount} älter als 28 Tage</small>}</span><ArrowRight size={15} aria-hidden="true" /></button>}
        {visible('progress') && (capacity.conflictCount > 0 || capacity.outsideMinutes > 0 || capacity.remainingMinutes < 0) && <button className="home-day-notice" type="button" onClick={() => onNavigate('today')}><Clock3 size={16} aria-hidden="true" /><span>{[capacity.conflictCount > 0 && capacity.conflictCount + (capacity.conflictCount === 1 ? ' zeitliche Überschneidung' : ' zeitliche Überschneidungen'), capacity.outsideMinutes > 0 && minutesLabel(capacity.outsideMinutes) + ' außerhalb deiner Zeitfenster', capacity.remainingMinutes < 0 && minutesLabel(capacity.remainingMinutes) + ' über deiner Kapazität'].filter(Boolean).join(' · ')}<small>In der Tagesplanung prüfen</small></span><ArrowRight size={15} aria-hidden="true" /></button>}

        <HomeCapture planner={planner} today={today} hidden={!visible('capture')} onCreateNote={onCreateNote} onCaptureNote={onCaptureNote} onDictate={onDictate} onQuickCapture={onQuickCapture} />

        {hasDetails && <details className="home-details"><summary id="home-details-summary">Weitere Dashboard-Details<ChevronDown className="home-disclosure-arrow" size={17} aria-hidden="true" /></summary><div className="home-details-content">
          {visible('progress') && <section className="home-stats home-panel" aria-label="Dein Tagesstand">
            <div><span>Geplant für heute</span><p><strong>{todayTasks.length}</strong><span>Aufgaben</span></p></div>
            <div><span>Bereits erledigt</span><p><strong>{doneTasks.length}</strong><span>von {todayTasks.length}</span></p></div>
            <div><span>Eingeplante Zeit</span><p><strong>{Math.round(capacity.usedMinutes)}</strong><span>Minuten</span></p></div>
          </section>}

          {visible('tasks') && <section className="home-panel home-daily-tasks" aria-labelledby="home-tasks-title"><div className="home-panel-heading"><h2 id="home-tasks-title"><CheckCheck size={16} aria-hidden="true" />Erledigte Tagesaufgaben<span className="home-count">{doneTasks.length}</span></h2></div>
            {doneTasks.length ? <TaskList tasks={doneTasks.slice(0, 6)} today={today} busy={busy} onEditTask={onEditTask} onToggle={toggleTask} /> : <div className="home-empty"><p>Hier erscheinen deine heute eingeplanten, erledigten Aufgaben.</p></div>}
            <div className="home-panel-footer"><button className="home-text-button" type="button" onClick={() => onNavigate('today')}>{doneTasks.length > 6 ? 'Alle ' + doneTasks.length + ' erledigten Tagesaufgaben' : 'Tagesplanung öffnen'}<ArrowRight size={14} aria-hidden="true" /></button></div>
          </section>}

          {visible('upcoming') && <section className="home-panel home-outlook" aria-labelledby="home-outlook-title"><div className="home-panel-heading"><h2 id="home-outlook-title">14-Tage-Ausblick</h2><button className="home-icon-button" type="button" aria-label="Kalender öffnen" onClick={() => onNavigate('calendar')}><ArrowUpRight size={16} aria-hidden="true" /></button></div>
            {outlook.length ? <UpcomingList items={outlook.slice(0, 6)} today={today} onOpen={openUpcoming} /> : <div className="home-empty"><p>{upcoming.some(item => item.id === nextAppointment?.id) ? 'Keine weiteren Termine, Zeitblöcke oder Erinnerungen in den nächsten 14 Tagen.' : 'Keine kommenden Termine, Zeitblöcke oder Erinnerungen in den nächsten 14 Tagen.'}</p><button className="home-text-button" type="button" onClick={() => onEditAppointment(undefined, today)}><CalendarPlus size={15} aria-hidden="true" />Termin anlegen</button></div>}
            {outlook.length > 6 && <p className="home-upcoming-more">{outlook.length - 6} weitere Einträge im Kalender und in den Erinnerungen</p>}
            <div className="home-panel-footer"><button className="home-text-button" type="button" onClick={() => onNavigate('calendar')}>Kalender<ArrowRight size={14} aria-hidden="true" /></button><button className="home-text-button" type="button" onClick={() => onNavigate('reminders')}>Erinnerungen<ArrowRight size={14} aria-hidden="true" /></button></div>
          </section>}

          {visible('notes') && <section className="home-panel home-notes" aria-labelledby="home-notes-title"><div className="home-panel-heading"><h2 id="home-notes-title"><NotebookPen size={16} aria-hidden="true" />Deine Notizen<span className="home-count">{activeNotes.length}</span></h2><button className="home-text-button" type="button" onClick={() => onNavigate('notes')}>Alle Notizen<ArrowUpRight size={14} aria-hidden="true" /></button></div>
            {pinnedNotes.length > 0 && <><h3 className="home-note-group"><Pin size={13} aria-hidden="true" />Angeheftet<span>{pinnedNotes.length}</span></h3><NoteLinks notes={pinnedNotes.slice(0, 3)} timeZone={timeZone} today={today} onOpenNote={onOpenNote} /></>}
            {recentNotes.length > 0 && <><h3 className="home-note-group">Zuletzt bearbeitet</h3><NoteLinks notes={recentNotes} timeZone={timeZone} today={today} onOpenNote={onOpenNote} /></>}
            {!activeNotes.length && <div className="home-empty"><NotebookPen size={24} strokeWidth={1.2} aria-hidden="true" /><p>Noch keine Notizen. Halte deinen ersten Gedanken fest.</p><button className="home-text-button" type="button" onClick={onCreateNote}><FilePlus2 size={16} aria-hidden="true" />Erste Notiz erstellen</button></div>}
            {activeNotes.length > 0 && !pinnedNotes.length && <p className="home-note-hint">Hefte wichtige Notizen im Editor an, um sie hier griffbereit zu halten.</p>}
            {pinnedNotes.length > 3 && <div className="home-panel-footer"><button className="home-text-button" type="button" onClick={() => onNavigate('notes')}>Alle {pinnedNotes.length} angehefteten Notizen<ArrowRight size={14} aria-hidden="true" /></button></div>}
          </section>}

          {visible('progress') && <section className="home-panel home-capacity" aria-labelledby="home-capacity-title"><div className="home-panel-heading"><h2 id="home-capacity-title"><Clock3 size={16} aria-hidden="true" />Deine Kapazität</h2><button className="home-icon-button" type="button" aria-label="Kapazität einstellen" onClick={() => onNavigate('settings')}><SlidersHorizontal size={16} aria-hidden="true" /></button></div>
            <div className="home-capacity-body"><p className={'home-capacity-remaining' + (capacity.remainingMinutes < 0 ? ' is-over-budget' : '')}><strong>{minutesLabel(capacity.remainingMinutes)}</strong><span>{capacity.remainingMinutes < 0 ? 'über deiner Kapazität' : 'heute noch frei'}</span></p>
              <progress className="home-progress-bar" value={Math.min(capacity.usedMinutes, capacity.availableMinutes || 1)} max={capacity.availableMinutes || 1} aria-label={minutesLabel(capacity.usedMinutes) + ' von ' + minutesLabel(capacity.availableMinutes) + ' Kapazität eingeplant'} />
              <div className="home-capacity-labels"><span>{minutesLabel(capacity.usedMinutes)} eingeplant</span><span>{minutesLabel(capacity.availableMinutes)} verfügbar</span></div>
              <p className="home-capacity-explanation">{data.settings.capacity?.enabled ? 'Verfügbare Zeitfenster abzüglich Puffer; überlappende Belegungen zählen einmal.' : 'Dein Tagesbudget mit Terminen, Zeitblöcken und unverblockten Aufgabenschätzungen.'}</p>
              {(capacity.outsideMinutes > 0 || capacity.unestimatedCount > 0 || capacity.conflictCount > 0) && <ul className="home-capacity-hints">{capacity.outsideMinutes > 0 && <li>{minutesLabel(capacity.outsideMinutes)} außerhalb deiner Zeitfenster</li>}{capacity.unestimatedCount > 0 && <li>{capacity.unestimatedCount} {capacity.unestimatedCount === 1 ? 'Aufgabe ohne Zeitschätzung' : 'Aufgaben ohne Zeitschätzung'}</li>}{capacity.conflictCount > 0 && <li>{capacity.conflictCount} {capacity.conflictCount === 1 ? 'zeitliche Überschneidung' : 'zeitliche Überschneidungen'}</li>}</ul>}
              <button className="home-text-button" type="button" onClick={() => onNavigate('today')}>Tag planen<ArrowRight size={14} aria-hidden="true" /></button>
            </div>
          </section>}

          {visible('ai') && <section className="home-panel home-ai" aria-labelledby="home-ai-title"><div className="home-panel-heading"><h2 id="home-ai-title"><Sparkles size={16} aria-hidden="true" />Gedanken ordnen</h2></div><div className="home-ai-body"><p>Aus Gedanken einen klaren nächsten Schritt machen.</p><button className="home-quiet-button" type="button" onClick={onAI}><Sparkles size={16} aria-hidden="true" />Mit KI planen<ArrowUpRight size={14} aria-hidden="true" /></button><button className="home-text-button" type="button" onClick={onDictate}><Mic size={16} aria-hidden="true" />Aufgaben diktieren</button></div></section>}
        </div></details>}

        {sections.length === 0 && <div className="home-panel home-empty"><SlidersHorizontal size={24} strokeWidth={1.2} aria-hidden="true" /><p>Dein Dashboard ist gerade leer. Unter „Ansicht“ wählst du deine Bausteine.</p><button className="home-quiet-button" type="button" disabled={busy !== null} onClick={() => saveSections([...DEFAULT_DASHBOARD])}>Standardansicht wiederherstellen</button></div>}
      </>}
      <footer className="home-footer"><span>Dein Überblick aus deinen eigenen Einträgen.</span><span>Zeiten in {timeZone}</span></footer>
    </div>
  </section>;
}
