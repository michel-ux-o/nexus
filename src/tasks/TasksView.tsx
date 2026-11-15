import { useId, useMemo, useState } from 'react';
import { CheckCheck, Filter, Inbox, ListTodo, Mic, Plus, Search, Sparkles, X } from 'lucide-react';
import type { WorkspaceViewProps } from '../planning/types';
import { todayInZone } from '../planning/dates';
import { TaskList } from '../planning/components/TaskList';
import { DEFAULT_TASK_FILTERS, filterTasks } from './filterTasks';
import type { TaskFilters } from './filterTasks';
import { HorizonTasksView } from './HorizonTasksView';
import './TasksView.css';
import './HorizonTasksView.css';

export interface TasksViewProps extends WorkspaceViewProps { horizon?: boolean; workspaceEpoch?: number; onFocusTask?: (id: string) => void }

export function TasksView(props: TasksViewProps) {
  return props.horizon ? <HorizonTasksView {...props} /> : <CollectionTasksView {...props} />;
}

function CollectionTasksView({ planner, onEditTask, onDictate, onAI, onQuickCapture }: WorkspaceViewProps) {
  const prefix = useId();
  const [filters, setFilters] = useState<TaskFilters>(() => ({ ...DEFAULT_TASK_FILTERS }));
  const today = todayInZone(planner.data.settings.timeZone);
  const tasks = useMemo(() => filterTasks(planner.data, filters, today), [planner.data, filters, today]);
  const counts = { active: planner.data.tasks.filter((task) => task.status !== 'done').length, done: planner.data.tasks.filter((task) => task.status === 'done').length };
  const overdue = planner.data.tasks.filter((task) => task.status !== 'done' && task.dueDate && task.dueDate < today).length;
  const filtered = filters.search !== '' || filters.planning !== 'all' || filters.status !== 'active' || filters.priority !== 'all' || filters.sort !== 'due';
  function patch(values: Partial<TaskFilters>) { setFilters((current) => ({ ...current, ...values })); }

  return <section className="tasks-view" aria-labelledby={`${prefix}-heading`}>
    <div className="tasks-content">
      <header className="tasks-heading">
        <div className="tasks-heading-copy"><p className="eyebrow"><span aria-hidden="true" />DEINE SAMMLUNG</p><h1 id={`${prefix}-heading`}>Aufgaben<span className="tasks-title-period" aria-hidden="true">.</span></h1></div>
        <div className="tasks-heading-actions">
          <button type="button" className="secondary-button" onClick={onDictate}><Mic size={16} aria-hidden="true" /><span>Diktieren</span></button>
          <button type="button" className="primary-button" onClick={() => onEditTask()} disabled={planner.loading || Boolean(planner.loadError)}><Plus size={17} aria-hidden="true" />Neue Aufgabe</button>
        </div>
      </header>

      {planner.loading && <p className="tasks-notice" role="status">Aufgaben werden geladen …</p>}
      {planner.loadError && <div className="tasks-notice is-error" role="alert"><p>Aufgaben konnten nicht geladen werden: {planner.loadError}</p><button type="button" className="secondary-button" onClick={() => void planner.reload().catch(() => undefined)}>Erneut laden</button></div>}
      {!planner.loadError && planner.error && <p className="tasks-notice is-error" role="alert">Änderungen noch nicht gespeichert: {planner.error}. Dein Entwurf bleibt erhalten.</p>}

      <div className="tasks-overview" aria-label="Aufgabenstand">
        <button type="button" className={filters.status === 'active' ? 'is-active' : ''} onClick={() => patch({ status: 'active' })} aria-pressed={filters.status === 'active'}><ListTodo size={18} aria-hidden="true" /><strong>{counts.active}</strong><span>unerledigt</span></button>
        <button type="button" className={filters.status === 'done' ? 'is-active' : ''} onClick={() => patch({ status: 'done' })} aria-pressed={filters.status === 'done'}><CheckCheck size={18} aria-hidden="true" /><strong>{counts.done}</strong><span>erledigt</span></button>
        <div className={overdue ? 'is-overdue' : ''}><Inbox size={18} aria-hidden="true" /><strong>{overdue}</strong><span>überfällig</span></div>
      </div>

      <section className="tasks-filter-panel" aria-label="Aufgaben suchen und filtern">
        <label className="tasks-search"><Search size={18} aria-hidden="true" /><span className="sr-only">Aufgaben durchsuchen</span><input type="search" value={filters.search} onChange={(event) => patch({ search: event.target.value })} placeholder="Aufgaben, Tags, Unteraufgaben …" /></label>
        <div className="tasks-filters">
          <label><span>Planung</span><select value={filters.planning} onChange={(event) => patch({ planning: event.target.value as TaskFilters['planning'] })}><option value="all">Alle Aufgaben</option><option value="inbox">Eingang · ungeplant</option><option value="planned">Eingeplant</option><option value="today">Heute</option><option value="day">Einem Tag zugeordnet</option><option value="week">Im Wochenpool</option></select></label>
          <label><span>Status</span><select value={filters.status} onChange={(event) => patch({ status: event.target.value as TaskFilters['status'] })}><option value="active">Unerledigt</option><option value="all">Alle Status</option><option value="open">Offen</option><option value="progress">In Bearbeitung</option><option value="done">Erledigt</option></select></label>
          <label><span>Priorität</span><select value={filters.priority} onChange={(event) => patch({ priority: event.target.value as TaskFilters['priority'] })}><option value="all">Alle Prioritäten</option><option value="high">Hoch</option><option value="normal">Normal</option><option value="low">Niedrig</option><option value="none">Keine Priorität</option></select></label>
          <label><span>Sortieren nach</span><select value={filters.sort} onChange={(event) => patch({ sort: event.target.value as TaskFilters['sort'] })}><option value="due">Fälligkeit</option><option value="priority">Priorität</option><option value="planning">Planung</option><option value="updated">Zuletzt bearbeitet</option><option value="title">Titel · A–Z</option></select></label>
        </div>
        <div className="tasks-results-line"><p role="status"><Filter size={13} aria-hidden="true" />{tasks.length} von {planner.data.tasks.length} {planner.data.tasks.length === 1 ? 'Aufgabe' : 'Aufgaben'}</p>{filtered && <button type="button" className="tasks-text-button" onClick={() => setFilters({ ...DEFAULT_TASK_FILTERS })}><X size={14} aria-hidden="true" />Filter zurücksetzen</button>}</div>
      </section>

      {!planner.loading && !planner.loadError && <>
        {planner.data.tasks.length === 0 ? <section className="tasks-empty"><span><ListTodo size={26} aria-hidden="true" /></span><h2>Noch keine Aufgaben.</h2><button type="button" className="primary-button" onClick={() => onEditTask()}><Plus size={16} aria-hidden="true" />Erste Aufgabe anlegen</button><button type="button" className="tasks-text-button" onClick={onQuickCapture}>Gedanken schnell erfassen</button></section>
          : <TaskList tasks={tasks} planner={planner} onEditTask={onEditTask} compact emptyText="Keine passenden Aufgaben. Filter zurücksetzen oder Suche ändern." />}
      </>}
      <footer className="tasks-footer"><button type="button" className="tasks-text-button" onClick={onAI}><Sparkles size={15} aria-hidden="true" />Mit KI ordnen</button></footer>
    </div>
  </section>;
}

export default TasksView;
