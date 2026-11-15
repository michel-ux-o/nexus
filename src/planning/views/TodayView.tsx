import { useEffect, useId, useState } from 'react';
import { AlertTriangle, ArrowRight, CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, Flag, Link2, Mic, Plus, Sparkles, X } from 'lucide-react';
import type { DayPlan, PlannerViewProps, Task } from '../types';
import { addDays, formatDate, isDate, startOfWeek, todayInZone } from '../dates';
import { inboxTasks, tasksForDay, weekPool } from '../selectors';
import { capacityForDay } from '../capacity';
import { TaskList } from '../components/TaskList';
import { Timeline } from '../timeline/Timeline';
import { TASK_DRAG_TYPE } from '../timeline/layout';
import './TodayView.css';

type TodayViewProps = PlannerViewProps & { date: string; onDateChange: (date: string) => void };

function durationLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const formattedRest = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(rest);
  return hours ? `${hours} Std.${rest ? ` ${formattedRest} Min.` : ''}` : `${formattedRest} Min.`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Die Änderung konnte nicht gespeichert werden. Bitte erneut versuchen.';
}

export function TodayView({ planner, notes, date, onDateChange, onEditTask, onEditAppointment, onEditBlock, onOpenNote, onDictate, onAI }: TodayViewProps) {
  const { data } = planner;
  const zone = data.settings.timeZone;
  const today = todayInZone(zone);
  const id = useId();
  const day: DayPlan = data.days.find(item => item.date === date) ?? {
    date, priorityTaskIds: [], note: '', review: '', availableMinutes: data.settings.defaultAvailableMinutes,
  };
  const dayTasks = tasksForDay(data, date);
  const dayTaskIds = new Set(dayTasks.map(task => task.id));
  const taskById = new Map(data.tasks.map(task => [task.id, task]));
  const completed = dayTasks.filter(task => task.status === 'done');
  const open = dayTasks.filter(task => task.status !== 'done');
  const inProgress = dayTasks.filter(task => task.status === 'progress');
  const capacity = capacityForDay(data, date);
  const minutes = capacity.usedMinutes;
  const blockedTaskIds = new Set(data.timeBlocks.map(block => block.taskId));
  const pool = [...dayTasks, ...weekPool(data, startOfWeek(date)), ...inboxTasks(data)]
    .filter((task, index, tasks) => task.status !== 'done' && !blockedTaskIds.has(task.id) && tasks.findIndex(item => item.id === task.id) === index);
  const overdue = data.tasks.filter(task => task.status !== 'done' && task.dueDate !== null && task.dueDate < today)
    .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!) || a.title.localeCompare(b.title, 'de'));
  const priorityIds = day.priorityTaskIds.filter(taskId => taskById.has(taskId)).slice(0, 3);
  const priorityOptions = data.tasks.filter(task => dayTaskIds.has(task.id) || priorityIds.includes(task.id));
  const linkedIds = new Set(dayTasks.flatMap(task => task.noteIds));
  const linkedNotes = notes.filter(note => linkedIds.has(note.id));

  const [availability, setAvailability] = useState(String(day.availableMinutes));
  const [availabilityError, setAvailabilityError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [moveCandidate, setMoveCandidate] = useState<Task | null>(null);
  const [recurrenceError, setRecurrenceError] = useState('');
  const [recurrenceAttempt, setRecurrenceAttempt] = useState(0);
  const rulesKey = (data.taskRules ?? []).map(rule => `${rule.id}:${rule.updatedAt}:${rule.paused}`).join('|');
  const materialize = planner.materializeRecurring;

  useEffect(() => {
    setRecurrenceError('');
    if (planner.loading || planner.loadError || date > addDays(today, 42)) return;
    let current = true;
    void materialize(date, date).catch(cause => {
      if (current) setRecurrenceError(errorMessage(cause));
    });
    return () => { current = false; };
  }, [date, today, planner.loading, planner.loadError, materialize, rulesKey, recurrenceAttempt]);

  useEffect(() => {
    setAvailability(String(day.availableMinutes));
    setAvailabilityError('');
  }, [date, day.availableMinutes]);

  useEffect(() => {
    setMoveCandidate(null);
    setActionError('');
  }, [date]);

  function updateDay(patch: Partial<DayPlan>) {
    try {
      // The shared store updates the controlled draft immediately and debounces persistence.
      planner.updateDay({ ...day, ...patch, date });
      setActionError('');
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  async function perform(key: string, action: () => Promise<unknown>) {
    setBusy(key);
    setActionError('');
    try {
      await action();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function changeDate(nextDate: string) {
    if (!isDate(nextDate) || nextDate === date || busy) return;
    await perform('date', async () => {
      if (await planner.flush()) onDateChange(nextDate);
      else throw new Error('Der aktuelle Tagesentwurf ist noch nicht gespeichert. Bitte das Speichern wiederholen, bevor du den Tag wechselst.');
    });
  }

  function changePriority(index: number, taskId: string) {
    if (taskId && priorityIds.some((existing, position) => existing === taskId && position !== index)) return;
    const next = [...priorityIds];
    if (!taskId) next.splice(index, 1);
    else if (index < next.length) next[index] = taskId;
    else next.push(taskId);
    updateDay({ priorityTaskIds: next.slice(0, 3) });
  }

  function scheduleTask(task: Task) {
    if (data.timeBlocks.some(block => block.taskId === task.id)) {
      setMoveCandidate(task);
      return;
    }
    void perform(`move-${task.id}`, () => planner.moveTask(task.id, { kind: 'day', date }));
  }

  function taskPoolRow(task: Task, source: 'pool' | 'overdue') {
    const alreadyHere = task.plan?.kind === 'day' && task.plan.date === date;
    return <li key={`${source}-${task.id}`} className="today-pool-row" draggable={!busy && planner.status !== 'error'} onDragStart={event => {
      if (busy || planner.status === 'error') { event.preventDefault(); return; }
      event.dataTransfer.setData(TASK_DRAG_TYPE, task.id); event.dataTransfer.effectAllowed = 'copyMove';
    }}>
      <div className="today-pool-copy">
        <button className="today-text-button" type="button" onClick={() => onEditTask(task)}>{task.title}</button>
        <div className="today-meta">
          {task.estimatedMinutes !== null && <span>{durationLabel(task.estimatedMinutes)}</span>}
          {task.priority === 'high' && <span className="today-priority-label">Hohe Priorität</span>}
          {task.dueDate && <span className={task.dueDate < today ? 'today-overdue-date' : ''}>Fällig {formatDate(task.dueDate, { day: 'numeric', month: 'short', year: 'numeric' })}</span>}
          {task.plan?.kind === 'week' && <span>Woche ab {formatDate(task.plan.weekStart, { day: 'numeric', month: 'short' })}</span>}
          {task.plan?.kind === 'day' && !alreadyHere && <span>Geplant {formatDate(task.plan.date, { day: 'numeric', month: 'short' })}</span>}
          {alreadyHere && <span>An diesem Tag</span>}
          {!task.plan && <span>Eingang</span>}
        </div>
      </div>
      <div className="today-pool-actions"><button type="button" className="today-button today-button-small" disabled={!!busy} onClick={() => onEditBlock(undefined, { taskId: task.id, date })} aria-label={`Zeitblock für ${task.title} anlegen`}><Plus size={14} aria-hidden="true" /> Zeit wählen</button>
        {!alreadyHere && <button type="button" className="today-text-button" disabled={!!busy} onClick={() => scheduleTask(task)} aria-label={`${task.title} ohne neue Uhrzeit für den ausgewählten Tag einplanen`}><ArrowRight size={14} aria-hidden="true" /> Einplanen</button>}</div>
    </li>;
  }

  if (planner.loading || planner.loadError) return <section className="today-view today-loading" aria-labelledby={`${id}-title`}>
    <h1 id={`${id}-title`}>Tagesplanung</h1>
    {planner.loading ? <p role="status">Deine Tagesplanung wird geladen …</p> : <>
      <p role="alert">{planner.loadError}</p>
      {actionError && <p role="alert">{actionError}</p>}
      <button className="today-button" type="button" disabled={!!busy} onClick={() => void perform('reload', planner.reload)}>Erneut laden</button>
    </>}
  </section>;

  return <section className="today-view" aria-labelledby={`${id}-title`}>
    <header className="today-header">
      <div className="today-heading">
        <p className="today-eyebrow"><span aria-hidden="true">03</span> Tagesplanung</p>
        <h1 id={`${id}-title`}><span className="today-standard-title">{date === today ? 'Heute' : formatDate(date, { weekday: 'long' })}<span className="today-title-period" aria-hidden="true">.</span></span><span className="today-horizon-title">Tagesplanung</span></h1>
        <p className="today-zone">{formatDate(date, { day: 'numeric', month: 'long', year: 'numeric' })} <span>· {completed.length} von {dayTasks.length} erledigt</span></p>
      </div>
      <time className="today-date-object" dateTime={date} aria-hidden="true"><span>{formatDate(date, { month: 'short' })}</span><strong>{date.slice(8)}</strong><span>{formatDate(date, { weekday: 'short' })}</span></time>
      <time className="today-horizon-date" dateTime={date}>{formatDate(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</time>
      <div className="today-header-actions">
        <button type="button" className="today-button" onClick={onDictate}><Mic size={16} aria-hidden="true" /> Aufgaben diktieren</button>
        <button type="button" className="today-button today-button-primary" onClick={() => onEditTask(undefined, { plan: { kind: 'day', date } })}><Plus size={16} aria-hidden="true" /> Aufgabe hinzufügen</button>
      </div>
    </header>

    <div className="today-toolbar">
      <div className="today-date-navigation" role="group" aria-label="Tag wechseln">
        <button type="button" className="today-icon-button" aria-label="Vorheriger Tag" disabled={!!busy || date === '0001-01-01'} onClick={() => void changeDate(addDays(date, -1))}><ChevronLeft size={18} aria-hidden="true" /></button>
        <label className="today-date-field"><span className="today-visually-hidden">Tag auswählen</span><CalendarDays size={15} aria-hidden="true" /><input type="date" min="0001-01-01" max="9999-12-31" value={date} disabled={!!busy} onChange={event => void changeDate(event.target.value)} /></label>
        <button type="button" className="today-icon-button" aria-label="Nächster Tag" disabled={!!busy || date === '9999-12-31'} onClick={() => void changeDate(addDays(date, 1))}><ChevronRight size={18} aria-hidden="true" /></button>
        <button type="button" className="today-button today-button-small" disabled={date === today || !!busy} onClick={() => void changeDate(today)}>Heute</button>
      </div>
      <div className={`today-save-state today-save-${planner.status}`} role="status" aria-live="polite">
        <span className="today-save-dot" aria-hidden="true" />
        {planner.status === 'saving' ? 'Planung wird gespeichert …' : planner.status === 'error' ? 'Planung nicht gespeichert' : 'Planung gespeichert'}
        {planner.status === 'error' && <button type="button" className="today-text-button" disabled={!!busy} onClick={() => void perform('retry', async () => { if (!await planner.retry()) throw new Error('Das Speichern ist weiterhin nicht möglich. Dein Entwurf bleibt geöffnet.'); })}>Erneut versuchen</button>}
      </div>
    </div>

    {(actionError || planner.error) && <div className="today-notice today-notice-error" role="alert"><AlertTriangle size={17} aria-hidden="true" /><p>{actionError || planner.error}</p></div>}
    {recurrenceError && <div className="today-notice today-notice-error" role="alert"><AlertTriangle size={17} aria-hidden="true" /><div><p>Wiederholte Aufgaben konnten nicht geladen werden: {recurrenceError}</p><button type="button" className="today-button" onClick={() => setRecurrenceAttempt(attempt => attempt + 1)}>Wiederholungen erneut laden</button></div></div>}

    {moveCandidate && <div className="today-notice today-move-confirm" role="alert">
      <AlertTriangle size={18} aria-hidden="true" />
      <div><strong>„{moveCandidate.title}“ auf diesen Tag verschieben?</strong><p>Die {data.timeBlocks.filter(block => block.taskId === moveCandidate.id).length} vorhandenen Zeitblöcke werden um dieselbe Anzahl Kalendertage mitverschoben. Uhrzeit, Dauer und Fälligkeit bleiben erhalten. Eine durch die Zeitumstellung ungültige Zielzeit muss zuerst im Blockformular angepasst werden.</p>
        <div className="today-inline-actions"><button type="button" className="today-button today-button-primary" disabled={!!busy} onClick={() => void perform(`move-${moveCandidate.id}`, async () => { await planner.moveTask(moveCandidate.id, { kind: 'day', date }); setMoveCandidate(null); })}>Verschieben</button><button type="button" className="today-button" disabled={!!busy} onClick={() => setMoveCandidate(null)}>Abbrechen</button></div>
      </div>
    </div>}

    <div className="today-content-grid">
      <div className="today-main-column">
        <div className="today-agenda"><Timeline planner={planner} date={date} onEditAppointment={onEditAppointment} onEditBlock={onEditBlock} /></div>

        <div className="today-overview">
          <section className="today-panel today-priorities" aria-labelledby={`${id}-priorities`}>
            <div className="today-section-heading"><h2 id={`${id}-priorities`}><Flag size={17} aria-hidden="true" /><span className="today-standard-label">Die wichtigsten drei</span><span className="today-horizon-label">Tagesprioritäten</span></h2><span className="today-count">{priorityIds.length}/3</span></div>
            <ol className="today-priority-list">{[0, 1, 2].map(index => {
              const task = taskById.get(priorityIds[index]);
              return <li key={index} className={task?.status === 'done' ? 'today-priority-done' : ''}>
                <span className="today-priority-number" aria-hidden="true">{task?.status === 'done' ? <Check size={15} /> : index + 1}</span>
                <label className="today-priority-select"><span className="today-visually-hidden">Tagespriorität {index + 1}</span><select value={priorityIds[index] ?? ''} disabled={index > priorityIds.length} onChange={event => changePriority(index, event.target.value)}>
                  <option value="">{index > priorityIds.length ? 'Vorherigen Fokus zuerst wählen' : dayTasks.length ? 'Aufgabe auswählen' : 'Noch keine Tagesaufgaben'}</option>
                  {priorityOptions.map(option => <option key={option.id} value={option.id} disabled={priorityIds.includes(option.id) && priorityIds[index] !== option.id}>{option.title}{option.status === 'done' ? ' · erledigt' : ''}</option>)}
                </select></label>
                {task && <><button type="button" className="today-text-button today-priority-edit" onClick={() => onEditTask(task)} aria-label={`Priorität ${index + 1}: ${task.title} bearbeiten`}>Bearbeiten</button><button type="button" className="today-icon-button" onClick={() => changePriority(index, '')} aria-label={`${task.title} aus den Tagesprioritäten entfernen`}><X size={15} aria-hidden="true" /></button></>}
              </li>;
            })}</ol>
            {priorityIds.some(taskId => !dayTaskIds.has(taskId)) && <p className="today-help">Eine Tagespriorität ist inzwischen anders eingeplant. Über „Bearbeiten“ kannst du ihre Planung anpassen.</p>}
            {!dayTasks.length && <button type="button" className="today-text-button" onClick={() => onEditTask(undefined, { plan: { kind: 'day', date } })}>Erste Tagesaufgabe anlegen <ArrowRight size={14} aria-hidden="true" /></button>}
          </section>

          <section className="today-panel today-capacity" aria-labelledby={`${id}-capacity`}>
            <div className="today-section-heading"><h2 id={`${id}-capacity`}><Clock3 size={17} aria-hidden="true" /> Zeit & Fortschritt</h2></div>
            <div className="today-capacity-totals"><strong>{durationLabel(minutes)}</strong><span>eingeplant von {durationLabel(capacity.availableMinutes)}</span></div>
            <progress className={`today-time-progress${capacity.remainingMinutes < 0 ? ' is-over' : ''}`} value={minutes} max={Math.max(minutes, capacity.availableMinutes, 1)} aria-label={`${durationLabel(minutes)} eingeplant bei ${durationLabel(capacity.availableMinutes)} verfügbarer Zeit`} />
            {capacity.remainingMinutes < 0 ? <p className="today-capacity-warning">{durationLabel(-capacity.remainingMinutes)} über deiner verfügbaren Zeit.</p> : <p className="today-capacity-remaining">{durationLabel(capacity.remainingMinutes)} verbleibend</p>}
            {!data.settings.capacity?.enabled && <form className="today-availability-form" onSubmit={event => {
              event.preventDefault();
              const value = Number(availability);
              if (!availability.trim() || !Number.isInteger(value) || value < 0 || value > 1440) { setAvailabilityError('Bitte 0 bis 1440 ganze Minuten eingeben.'); return; }
              setAvailabilityError('');
              updateDay({ availableMinutes: value });
            }}>
              <label htmlFor={`${id}-minutes`}>Verfügbare Minuten</label><div><input id={`${id}-minutes`} type="number" min="0" max="1440" step="1" inputMode="numeric" value={availability} aria-invalid={!!availabilityError} aria-describedby={availabilityError ? `${id}-minutes-error` : undefined} onChange={event => setAvailability(event.target.value)} /><button className="today-button today-button-small" type="submit">Übernehmen</button></div>
              {availabilityError && <p id={`${id}-minutes-error`} className="today-field-error" role="alert">{availabilityError}</p>}
            </form>}
            <details className="today-calculation"><summary>Wie wird die Zeit berechnet?</summary><p className="today-help today-time-explanation">{data.settings.capacity?.enabled ? 'Zeitfenster abzüglich Puffer. ' : 'Tagesbudget in Minuten. '}Termine und Zeitblöcke zählen bei Überschneidungen einmal, dazu die Schätzungen unverblockter Tagesaufgaben. Ganztägige Termine belegen keine Zeit.</p></details>
            {(capacity.outsideMinutes > 0 || capacity.unestimatedCount > 0 || capacity.conflictCount > 0) && <ul className="today-capacity-details">{capacity.outsideMinutes > 0 && <li>{durationLabel(capacity.outsideMinutes)} außerhalb des verfügbaren Zeitfensters</li>}{capacity.unestimatedCount > 0 && <li>{capacity.unestimatedCount} {capacity.unestimatedCount === 1 ? 'Aufgabe ohne Schätzung' : 'Aufgaben ohne Schätzung'}</li>}{capacity.conflictCount > 0 && <li>{capacity.conflictCount} {capacity.conflictCount === 1 ? 'Zeitkonflikt' : 'Zeitkonflikte'}</li>}</ul>}
            <div className="today-task-progress"><div><strong>{completed.length} von {dayTasks.length}</strong><span> Aufgaben erledigt</span></div><progress value={completed.length} max={Math.max(dayTasks.length, 1)} aria-label={`${completed.length} von ${dayTasks.length} Tagesaufgaben erledigt`} /></div>
          </section>
        </div>

        <section className="today-panel today-day-tasks" aria-labelledby={`${id}-tasks`}>
          <div className="today-section-heading"><h2 id={`${id}-tasks`}>Alle Tagesaufgaben</h2><span className="today-count">{dayTasks.length}</span></div>
          <TaskList tasks={dayTasks} planner={planner} onEditTask={onEditTask} emptyText="Noch keine Aufgaben für diesen Tag." />
          <button type="button" className="today-text-button today-add-block" onClick={() => onEditTask(undefined, { plan: { kind: 'day', date } })}><Plus size={15} aria-hidden="true" /> Tagesaufgabe hinzufügen</button>
        </section>

        <section className="today-panel today-note" aria-labelledby={`${id}-note`}><div className="today-section-heading"><h2 id={`${id}-note`}>Tagesnotiz</h2></div><label className="today-visually-hidden" htmlFor={`${id}-note-input`}>Tagesnotiz für {formatDate(date)}</label><textarea id={`${id}-note-input`} rows={3} maxLength={10000} value={day.note} onChange={event => updateDay({ note: event.target.value })} placeholder="Ein Gedanke für diesen Tag …" /></section>

        <section className="today-panel today-review" aria-labelledby={`${id}-review`}><div className="today-section-heading"><h2 id={`${id}-review`}>Tagesabschluss</h2></div>
          <div className="today-review-counts"><div><strong>{completed.length}</strong><span>Erledigt</span></div><div><strong>{inProgress.length}</strong><span>In Bearbeitung</span></div><div><strong>{dayTasks.filter(task => task.status === 'open').length}</strong><span>Offen</span></div></div>
          {open.length > 0 ? <details className="today-open-summary"><summary>{open.length} noch nicht erledigte {open.length === 1 ? 'Aufgabe' : 'Aufgaben'}</summary><ul>{open.map(task => <li key={task.id}><button type="button" className="today-text-button" onClick={() => onEditTask(task)}>{task.title}</button></li>)}</ul></details> : dayTasks.length > 0 && <p className="today-help">Alles erledigt.</p>}
          <label htmlFor={`${id}-review-input`} className="today-field-label">Dein kurzer Rückblick</label><textarea id={`${id}-review-input`} rows={3} maxLength={10000} value={day.review} onChange={event => updateDay({ review: event.target.value })} placeholder="Was nimmst du mit?" />
        </section>
      </div>

      <aside className="today-side-column" aria-label="Aufgabenpool und Hinweise">
        <section className="today-panel today-pool" aria-labelledby={`${id}-pool`}><div className="today-section-heading"><h2 id={`${id}-pool`}><span className="today-standard-label">Noch ohne Zeitblock</span><span className="today-horizon-label">Aufgabenpool</span></h2><span className="today-count">{pool.length}</span></div><p className="today-help">Noch ohne Zeitblock. Auf eine Uhrzeit ziehen oder „Zeit wählen“.</p>{pool.length ? <ul className="today-pool-list">{pool.map(task => taskPoolRow(task, 'pool'))}</ul> : <p className="today-empty-text">Der Pool ist leer.</p>}<button type="button" className="today-text-button" onClick={() => onEditTask(undefined, { plan: null })}><Plus size={15} aria-hidden="true" /> Aufgabe im Pool anlegen</button></section>

        <section className="today-panel today-overdue" aria-labelledby={`${id}-overdue`}><div className="today-section-heading"><h2 id={`${id}-overdue`}><AlertTriangle size={16} aria-hidden="true" /> Überfällig</h2><span className="today-count">{overdue.length}</span></div>{overdue.length ? <><p className="today-help">Einplanen ändert die Fälligkeit nicht.</p><ul className="today-pool-list">{overdue.map(task => taskPoolRow(task, 'overdue'))}</ul></> : <p className="today-empty-text">Keine überfälligen Aufgaben.</p>}</section>

        {linkedNotes.length > 0 && <section className="today-panel today-linked-notes" aria-labelledby={`${id}-links`}><div className="today-section-heading"><h2 id={`${id}-links`}><Link2 size={16} aria-hidden="true" /> Notizen zum Tag</h2></div><ul>{linkedNotes.map(note => <li key={note.id}><button type="button" className="today-text-button" onClick={() => onOpenNote(note.id)}>{note.title.trim() || 'Unbenannte Notiz'}{note.deletedAt && <span className="today-meta">Im Papierkorb</span>}</button></li>)}</ul></section>}

        <button type="button" className="today-ai-button" onClick={onAI}><Sparkles size={18} aria-hidden="true" /><span><strong>Tag mit KI planen</strong></span><ArrowRight size={16} aria-hidden="true" /></button>
      </aside>
    </div>
  </section>;
}
