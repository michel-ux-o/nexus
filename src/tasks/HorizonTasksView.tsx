import { useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ArrowRight, Bell, CalendarDays, Check, ChevronDown, ChevronRight, Clock3, Filter, ListTodo, Mic, Pencil, Plus, Repeat2, RotateCcw, Search, Sparkles, X } from 'lucide-react';
import { formatDate, todayInZone } from '../planning/dates';
import { errorMessage } from '../planning/components/PlanningDialog';
import type { Task, TaskStatus } from '../planning/types';
import { DEFAULT_TASK_FILTERS, filterTasks } from './filterTasks';
import type { TaskFilters } from './filterTasks';
import type { TasksViewProps } from './TasksView';
import { focusTaskWithDraft, getSubtaskDraftStore, saveSubtaskDraft } from './subtaskDrafts';
import type { SubtaskDraft } from './subtaskDrafts';
import { subtaskProgress } from '../planning/subtasks';
import { SubtaskChecklist } from '../planning/components/SubtaskChecklist';
import { firstTaskBlockDates, scheduleDate, shortScheduleDate, taskSchedule } from './taskSchedule';
import { groupTaskSeries } from './taskSeries';
import type { TaskSeries } from './taskSeries';

const statusLabels: Record<TaskStatus, string> = { open: 'Offen', progress: 'In Bearbeitung', done: 'Erledigt' };
const priorityLabels = { low: 'Niedrig', normal: 'Normal', high: 'Hoch' };
const shortDate = (date: string) => formatDate(date, { day: '2-digit', month: '2-digit', year: 'numeric' });

function HorizonTaskSeries({ series, selectedId, children, renderTask }: { series: TaskSeries; selectedId?: string; children: ReactNode; renderTask: (task: Task) => ReactNode }) {
  const tasksId = useId();
  const [expanded, setExpanded] = useState(false);
  const hasHiddenSelection = !expanded && series.remaining.some(task => task.id === selectedId);
  return <li className="horizon-task-series">
    {children}
    <button type="button" className={`horizon-task-series-toggle${hasHiddenSelection ? ' has-selection' : ''}`} aria-expanded={expanded} aria-controls={tasksId} onClick={() => setExpanded(value => !value)}>
      <Repeat2 size={15} aria-hidden="true" />{series.remaining.length} {series.remaining.length === 1 ? 'weiterer Serientermin' : 'weitere Serientermine'}<ChevronDown size={15} aria-hidden="true" />
    </button>
    <ul id={tasksId} className="horizon-task-series-list" hidden={!expanded}>
      {expanded && series.remaining.map(task => <li key={task.id}>{renderTask(task)}</li>)}
    </ul>
  </li>;
}

export function HorizonTasksView({ planner, notes, workspaceEpoch, onEditTask, onOpenNote, onDictate, onAI, onQuickCapture, onFocusTask }: TasksViewProps) {
  const prefix = useId();
  const [filters, setFilters] = useState<TaskFilters>(() => ({ ...DEFAULT_TASK_FILTERS }));
  const [selectedId, setSelectedId] = useState<string>();
  const draftStore = getSubtaskDraftStore(planner.saveTask, workspaceEpoch);
  const drafts = useSyncExternalStore(draftStore.subscribe, draftStore.getSnapshot, draftStore.getSnapshot);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const today = todayInZone(planner.data.settings.timeZone);
  const blockDates = useMemo(() => firstTaskBlockDates(planner.data), [planner.data]);
  const tasks = useMemo(() => filterTasks(planner.data, filters, today, blockDates), [planner.data, filters, today, blockDates]);
  const entries = useMemo(() => groupTaskSeries(tasks, planner.data, today, blockDates), [tasks, planner.data, today, blockDates]);
  const task = tasks.find(item => item.id === selectedId) ?? entries[0]?.task;
  const selectedSchedule = task ? taskSchedule(task, blockDates) : null;
  const selectedDate = scheduleDate(selectedSchedule);
  const progress = subtaskProgress(task?.subtasks ?? []);
  const draft = task ? drafts[task.id] : undefined;
  const unavailable = busy || planner.loading || Boolean(planner.loadError);
  const filtered = filters.search !== '' || filters.planning !== 'all' || filters.status !== 'active' || filters.priority !== 'all' || filters.sort !== 'due';
  const rule = planner.data.taskRules?.find(item => item.id === task?.ruleId);
  const reminders = task ? planner.data.reminders?.filter(item => item.taskId === task.id && item.enabled).length ?? 0 : 0;
  function patch(values: Partial<TaskFilters>) { setFilters(current => ({ ...current, ...values })); }

  async function run(action: () => Promise<unknown>, success: string): Promise<boolean> {
    if (locked.current || planner.loading || planner.loadError) return false;
    locked.current = true; setBusy(true); setError(''); setMessage('');
    try { await action(); setMessage(success); return true; }
    catch (cause) { setError(errorMessage(cause)); return false; }
    finally { locked.current = false; setBusy(false); }
  }
  function setStatus(target: Task, status: TaskStatus) {
    void run(() => planner.setTaskStatus(target.id, status), `${target.title}: ${statusLabels[status]} gespeichert.`);
  }
  function renderTask(item: Task, next = false) {
    const plan = taskSchedule(item, blockDates);
    const dateLabel = plan ? shortScheduleDate(plan, today) : null;
    const steps = subtaskProgress(item.subtasks);
    return <div className={`horizon-task-item${item.id === task?.id ? ' is-selected' : ''}${item.status === 'done' ? ' is-done' : ''}`}>
      <label className="horizon-task-complete">
        <input type="checkbox" checked={item.status === 'done'} disabled={unavailable} onChange={() => setStatus(item, item.status === 'done' ? 'open' : 'done')} aria-label={`${item.title}: ${item.status === 'done' ? 'wieder öffnen' : 'erledigen'}${dateLabel ? `, ${dateLabel}` : ''}`} />
        <span aria-hidden="true">{item.status === 'done' && <Check size={16} />}</span>
      </label>
      <button type="button" className="horizon-task-select" aria-pressed={item.id === task?.id} aria-controls={`${prefix}-detail`} disabled={busy} onClick={() => setSelectedId(item.id)}>
        <span><strong>{item.title}</strong>
          {(dateLabel || steps.total > 0) && <span className="horizon-task-row-meta">{dateLabel && <time dateTime={scheduleDate(plan)}>{dateLabel}</time>}{steps.total > 0 && <span>{steps.done}/{steps.total} Schritte</span>}</span>}
          {(next || item.status === 'progress') && <span className="horizon-task-row-status">{next && <span>Nächster offener Termin</span>}{item.status === 'progress' && <span>In Bearbeitung</span>}</span>}
        </span><ChevronRight size={20} aria-hidden="true" />
      </button>
    </div>;
  }
  function startSubtask(target: Task) {
    draftStore.start(target.id);
  }
  function clearDraft(id: string) {
    draftStore.discard(id);
  }
  async function addSubtask(event: FormEvent<HTMLFormElement>, target: Task, input: SubtaskDraft) {
    event.preventDefault();
    if (!input.title.trim()) return;
    if (await run(() => saveSubtaskDraft(target, input, planner.saveTask), 'Unteraufgabe hinzugefügt und gespeichert.')) draftStore.discard(target.id, input);
  }

  return <section className="tasks-view horizon-tasks-view" aria-labelledby={`${prefix}-heading`}>
    <div className="horizon-tasks-content">
      <header className="horizon-tasks-heading"><h1 id={`${prefix}-heading`}>Aufgaben</h1><div className="horizon-tasks-heading-actions"><button type="button" className="tasks-text-button" onClick={onDictate}><Mic size={17} aria-hidden="true" />Diktieren</button><button type="button" className="tasks-text-button horizon-task-primary-action" onClick={() => onEditTask()} disabled={unavailable}><Plus size={20} aria-hidden="true" />Neue Aufgabe</button></div></header>
      {planner.loading && <p className="tasks-notice" role="status">Aufgaben werden geladen …</p>}
      {planner.loadError && <div className="tasks-notice is-error" role="alert"><p>Aufgaben konnten nicht geladen werden: {planner.loadError}</p><button type="button" onClick={() => { void planner.reload().catch(cause => setError(errorMessage(cause))); }}>Erneut laden</button></div>}
      {(error || planner.error) && <div className="tasks-notice is-error"><p role="alert">Änderung noch nicht gespeichert: {error || planner.error}. Dein Entwurf bleibt erhalten.</p><button type="button" className="tasks-text-button" disabled={unavailable} onClick={() => { void run(async () => { if (!await planner.retry()) throw new Error(planner.error || 'Bitte erneut versuchen.'); }, 'Änderungen gespeichert.'); }}><RotateCcw size={16} aria-hidden="true" />Erneut speichern</button></div>}
      <div className="horizon-tasks-workspace">
        <section className="horizon-task-collection" aria-label="Aufgaben suchen und auswählen">
          <label className="tasks-search"><Search size={20} aria-hidden="true" /><span className="sr-only">Aufgaben durchsuchen</span><input type="search" value={filters.search} onChange={event => patch({ search: event.target.value })} placeholder="Aufgaben suchen" /></label>
          <div className="horizon-task-tabs" role="group" aria-label="Statusfilter">
            <button type="button" aria-pressed={filters.status === 'all'} onClick={() => patch({ status: 'all' })}>Alle <span>{planner.data.tasks.length}</span></button>
            <button type="button" aria-pressed={filters.status === 'active' || filters.status === 'open' || filters.status === 'progress'} onClick={() => patch({ status: 'active' })}>Offen</button>
            <button type="button" aria-pressed={filters.status === 'done'} onClick={() => patch({ status: 'done' })}>Erledigt</button>
          </div>
          <div className="horizon-task-controls">
            <label className="horizon-task-sort"><span>Sortieren nach</span><select value={filters.sort} onChange={event => patch({ sort: event.target.value as TaskFilters['sort'] })}><option value="due">Fälligkeit</option><option value="planning">Geplantem Datum</option><option value="priority">Priorität</option><option value="updated">Zuletzt bearbeitet</option><option value="title">Titel · A–Z</option></select></label>
            <details className="horizon-task-filters"><summary><Filter size={16} aria-hidden="true" />Weitere Filter</summary><div className="tasks-filters">
              <label><span>Planung</span><select value={filters.planning} onChange={event => patch({ planning: event.target.value as TaskFilters['planning'] })}><option value="all">Alle Aufgaben</option><option value="inbox">Eingang · ungeplant</option><option value="planned">Eingeplant</option><option value="today">Heute</option><option value="day">Einem Tag zugeordnet</option><option value="week">Im Wochenpool</option></select></label>
              <label><span>Status</span><select value={filters.status} onChange={event => patch({ status: event.target.value as TaskFilters['status'] })}><option value="active">Unerledigt</option><option value="all">Alle Status</option><option value="open">Offen</option><option value="progress">In Bearbeitung</option><option value="done">Erledigt</option></select></label>
              <label><span>Priorität</span><select value={filters.priority} onChange={event => patch({ priority: event.target.value as TaskFilters['priority'] })}><option value="all">Alle Prioritäten</option><option value="high">Hoch</option><option value="normal">Normal</option><option value="low">Niedrig</option><option value="none">Keine Priorität</option></select></label>
            </div></details>
          </div>
          <div className="tasks-results-line"><p role="status">{tasks.length} von {planner.data.tasks.length} Aufgaben</p>{filtered && <button type="button" className="tasks-text-button" onClick={() => setFilters({ ...DEFAULT_TASK_FILTERS })}><X size={14} aria-hidden="true" />Zurücksetzen</button>}</div>
          {!planner.loading && !planner.loadError && (tasks.length ? <ul className="horizon-task-list" aria-label="Aufgaben">
            {entries.map(({ task: item, series }) => series ? <HorizonTaskSeries key={series.id} series={series} selectedId={task?.id} renderTask={renderTask}>{renderTask(item, series.next === item)}</HorizonTaskSeries>
              : <li key={`task:${item.id}`}>{renderTask(item)}</li>)}
          </ul> : <div className="horizon-tasks-empty"><ListTodo size={26} aria-hidden="true" /><h2>{planner.data.tasks.length ? 'Keine passenden Aufgaben' : 'Noch keine Aufgaben'}</h2><p>{planner.data.tasks.length ? 'Ändere deine Suche oder setze die Filter zurück.' : 'Halte fest, was du als Nächstes angehen möchtest.'}</p><button type="button" className="tasks-text-button" onClick={planner.data.tasks.length ? () => setFilters({ ...DEFAULT_TASK_FILTERS }) : () => onEditTask()}>{planner.data.tasks.length ? 'Filter zurücksetzen' : 'Erste Aufgabe anlegen'}</button>{!planner.data.tasks.length && <button type="button" className="tasks-text-button" onClick={onQuickCapture}>Gedanken schnell erfassen</button>}</div>)}
        </section>
        <section id={`${prefix}-detail`} className="horizon-task-detail" aria-labelledby={task ? `${prefix}-task-title` : undefined} aria-label={task ? undefined : 'Aufgabendetails'} aria-busy={busy}>
          {!planner.loading && !planner.loadError && task && <>
            <p className="horizon-task-detail-label">Ausgewählte Aufgabe</p><h2 id={`${prefix}-task-title`}>{task.title}</h2>
            <div className="horizon-task-toolbar"><label className="horizon-task-status"><span className={`horizon-status-dot is-${task.status}`} aria-hidden="true" /><span className="sr-only">Aufgabenstatus</span><select value={task.status} disabled={unavailable} onChange={event => setStatus(task, event.target.value as TaskStatus)}><option value="open">Offen</option><option value="progress">In Bearbeitung</option><option value="done">Erledigt</option></select></label><button type="button" className="tasks-text-button" disabled={unavailable} onClick={() => onEditTask(task)}><Pencil size={17} aria-hidden="true" />Bearbeiten</button></div>
            {task.description && <p className="horizon-task-description">{task.description}</p>}
            <dl className="horizon-task-metadata"><div><dt><CalendarDays size={18} aria-hidden="true" />{selectedSchedule?.kind === 'week' ? 'Planungswoche ab' : 'Planung'}</dt><dd>{selectedDate ? shortDate(selectedDate) : 'Noch nicht eingeplant'}</dd></div><div className={task.status !== 'done' && task.dueDate && task.dueDate < today ? 'is-overdue' : ''}><dt><CalendarDays size={18} aria-hidden="true" />Fällig am</dt><dd>{task.dueDate ? shortDate(task.dueDate) : 'Keine Fälligkeit'}</dd></div>{task.estimatedMinutes !== null && <div><dt><Clock3 size={18} aria-hidden="true" />Schätzung</dt><dd>{task.estimatedMinutes} Min.</dd></div>}</dl>
            {(task.priority || task.tags?.length || rule || reminders > 0) && <div className="horizon-task-attributes">{task.priority && <span>Priorität: {priorityLabels[task.priority]}</span>}{(task.tags ?? []).map(tag => <span key={tag}>#{tag}</span>)}{rule && <span><Repeat2 size={14} aria-hidden="true" />{rule.paused ? 'Wiederholung pausiert' : rule.frequency === 'daily' ? 'Täglich' : rule.frequency === 'weekdays' ? 'Werktags' : 'Wöchentlich'}</span>}{reminders > 0 && <span><Bell size={14} aria-hidden="true" />{reminders} {reminders === 1 ? 'Erinnerung' : 'Erinnerungen'}</span>}</div>}
            <div className="horizon-subtasks-heading"><h3>Unteraufgaben</h3><span>{progress.done} von {progress.total} erledigt</span></div>
            {task.subtasks.length ? <SubtaskChecklist value={task.subtasks} disabled={unavailable} onChange={subtasks => { void run(() => planner.saveTask({ ...task, subtasks }), 'Unteraufgaben gespeichert.'); }} /> : <p className="horizon-subtasks-empty">Teile die Aufgabe in kleine Schritte auf.</p>}
            {draft ? <form className="horizon-subtask-form" onSubmit={event => { void addSubtask(event, task, draft); }}><label><span>Neue Unteraufgabe</span><input autoFocus required maxLength={500} value={draft.title} disabled={unavailable} onChange={event => draftStore.setTitle(task.id, event.target.value)} /></label><div><button type="submit" className="tasks-text-button" disabled={unavailable || !draft.title.trim()}><Check size={17} aria-hidden="true" />Hinzufügen</button><button type="button" className="tasks-text-button" disabled={busy} onClick={() => clearDraft(task.id)}>Abbrechen</button></div></form> : <button type="button" className="tasks-text-button" disabled={unavailable} onClick={() => startSubtask(task)}><Plus size={19} aria-hidden="true" />Unteraufgabe</button>}
            {task.noteIds.length > 0 && <div className="horizon-task-notes"><h3>Verknüpfte Notizen</h3>{task.noteIds.map(id => { const note = notes.find(item => item.id === id); return note && !note.deletedAt ? <button type="button" key={id} className="tasks-text-button" onClick={() => onOpenNote(id)}>{note.title || 'Unbenannte Notiz'}<ArrowRight size={15} aria-hidden="true" /></button> : <span key={id}>Nicht verfügbare Notiz</span>; })}</div>}
            {onFocusTask && <div className="horizon-task-focus"><button type="button" className="tasks-text-button" disabled={unavailable} onClick={() => { void run(() => focusTaskWithDraft(planner, task, onFocusTask, draftStore), ''); }}>Im Fokus öffnen<ArrowRight size={20} aria-hidden="true" /></button></div>}
          </>}
        </section>
      </div>
      <footer className="horizon-tasks-footer"><p role="status">{busy ? 'Änderung wird gespeichert …' : message}</p><button type="button" className="tasks-text-button" onClick={onAI}><Sparkles size={15} aria-hidden="true" />Mit KI ordnen</button></footer>
    </div>
  </section>;
}
