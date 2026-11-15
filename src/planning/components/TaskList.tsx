import { useRef, useState } from 'react';
import { Bell, Check, Circle, Clock3, Repeat2, RotateCcw } from 'lucide-react';
import type { Planner, Task, TaskStatus } from '../types';
import { formatDate, todayInZone } from '../dates';
import { errorMessage } from './PlanningDialog';
import { subtaskProgress } from '../subtasks';
import './PlanningComponents.css';

export interface TaskListProps { tasks: Task[]; planner: Planner; onEditTask: (task: Task) => void; emptyText?: string; compact?: boolean }

const priorityLabels = { low: 'Niedrig', normal: 'Normal', high: 'Hoch' };

function TaskCard({ task, planner, onEditTask, compact }: { task: Task; planner: Planner; onEditTask: (task: Task) => void; compact?: boolean }) {
  const menuRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const [pending, setPending] = useState<TaskStatus | null>(null);
  const [failedStatus, setFailedStatus] = useState<TaskStatus | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const overdue = task.status !== 'done' && Boolean(task.dueDate && task.dueDate < todayInZone(planner.data.settings.timeZone));
  const progress = subtaskProgress(task.subtasks);
  const rule = planner.data.taskRules?.find((item) => item.id === task.ruleId);
  const reminderCount = planner.data.reminders?.filter((item) => item.taskId === task.id && item.enabled).length ?? 0;

  async function setStatus(status: TaskStatus) {
    if (pending) return;
    setPending(status); setError(''); setMessage('');
    try {
      await planner.setTaskStatus(task.id, status);
      setFailedStatus(null);
      setMessage(status === 'done' ? 'Als erledigt gespeichert.' : status === 'progress' ? 'In Bearbeitung gespeichert.' : 'Als offen gespeichert.');
    } catch (cause) { setFailedStatus(status); setError(errorMessage(cause)); }
    finally { setPending(null); }
  }

  return <li className={`planning-task-card${compact ? ' is-compact' : ''}${task.status === 'done' ? ' is-done' : ''}`}>
    <div className="planning-task-title-row">
      <span className="planning-task-state" aria-label={task.status === 'done' ? 'Erledigt' : task.status === 'progress' ? 'In Bearbeitung' : 'Offen'}>
        {task.status === 'done' ? <Check size={19} aria-hidden="true" /> : task.status === 'progress' ? <Clock3 size={19} aria-hidden="true" /> : <Circle size={19} aria-hidden="true" />}
      </span>
      <h3><button type="button" className="planning-task-title" disabled={Boolean(pending)} onClick={() => onEditTask(task)}>{task.title}</button></h3>
    </div>
    {task.description && !compact && <p className="planning-task-description">{task.description}</p>}
    <div className="planning-task-chips">
      {task.priority && <span className={`planning-task-chip priority-${task.priority}`}>Priorität: {priorityLabels[task.priority]}</span>}
      {task.estimatedMinutes !== null && <span className="planning-task-chip">Schätzung: {task.estimatedMinutes} Min.</span>}
      {task.dueDate && <span className={`planning-task-chip${overdue ? ' is-overdue' : ''}`}>{overdue ? 'Überfällig seit' : 'Fällig am'} {formatDate(task.dueDate)}</span>}
      <span className="planning-task-chip">{task.plan?.kind === 'day' ? `Geplant: ${formatDate(task.plan.date)}` : task.plan?.kind === 'week' ? `Planungswoche ab ${formatDate(task.plan.weekStart)}` : 'Noch nicht eingeplant'}</span>
      {progress.total > 0 && <span className="planning-task-chip">Unteraufgaben: {progress.done}/{progress.total} erledigt{task.subtasks.some((item) => item.suggestion || item.children?.some(child => child.suggestion)) ? ' · enthält Vorschläge' : ''}</span>}
      {task.noteIds.length > 0 && <span className="planning-task-chip">{task.noteIds.length} {task.noteIds.length === 1 ? 'Notiz verknüpft' : 'Notizen verknüpft'}</span>}
      {(task.tags ?? []).map((tag) => <span className="planning-task-chip is-tag" key={tag}>#{tag}</span>)}
      {rule && <span className="planning-task-chip"><Repeat2 size={12} aria-hidden="true" /> {rule.paused ? 'Wiederholung pausiert' : rule.frequency === 'daily' ? 'Täglich' : rule.frequency === 'weekdays' ? 'Werktags' : 'Wöchentlich'}</span>}
      {reminderCount > 0 && <span className="planning-task-chip"><Bell size={12} aria-hidden="true" /> {reminderCount} {reminderCount === 1 ? 'Erinnerung' : 'Erinnerungen'}</span>}
    </div>
    <div className="planning-task-actions" aria-label={`Aktionen für ${task.title}`}>
      <button type="button" className="secondary-button" disabled={Boolean(pending) || planner.loading} onClick={() => void setStatus(task.status === 'done' ? 'open' : 'done')}>
        {task.status === 'done' ? <RotateCcw size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}{task.status === 'done' ? 'Wieder öffnen' : 'Erledigen'}
      </button>
      <details className="planning-task-more" ref={menuRef} onKeyDown={event => {
        if (event.key === 'Escape' && menuRef.current?.open) {
          event.preventDefault(); menuRef.current.open = false; summaryRef.current?.focus();
        }
      }}>
        <summary ref={summaryRef} aria-label={`Weitere Statusaktionen für ${task.title}`}>Status ändern</summary>
        <div className="planning-task-more-options">
          {task.status !== 'open' && <button type="button" className="secondary-button" disabled={Boolean(pending) || planner.loading} onClick={() => { if (menuRef.current) menuRef.current.open = false; summaryRef.current?.focus(); void setStatus('open'); }}><Circle size={15} aria-hidden="true" /> Als offen markieren</button>}
          {task.status !== 'progress' && <button type="button" className="secondary-button" disabled={Boolean(pending) || planner.loading} onClick={() => { if (menuRef.current) menuRef.current.open = false; summaryRef.current?.focus(); void setStatus('progress'); }}><Clock3 size={15} aria-hidden="true" /> In Bearbeitung setzen</button>}
          {task.status === 'progress' && <span>In Bearbeitung</span>}
        </div>
      </details>
    </div>
    <p className={`planning-task-feedback${message && !pending ? ' is-committed' : ''}`} role="status">{pending ? 'Status wird gespeichert …' : message}</p>
    {error && <div className="planning-task-error"><p role="alert">Status nicht gespeichert: {error}</p><button type="button" className="secondary-button" disabled={Boolean(pending)} onClick={() => { if (failedStatus) void setStatus(failedStatus); }}>Speichern erneut versuchen</button></div>}
  </li>;
}

export function TaskList({ tasks, planner, onEditTask, emptyText = 'Hier sind noch keine Aufgaben.', compact = false }: TaskListProps) {
  if (tasks.length === 0) return <p className="planning-task-empty">{emptyText}</p>;
  return <ul className={`planning-task-list${compact ? ' is-compact' : ''}`} aria-label="Aufgaben">
    {tasks.map((task) => <TaskCard key={task.id} task={task} planner={planner} onEditTask={onEditTask} compact={compact} />)}
  </ul>;
}

