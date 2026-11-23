import { ChevronDown, ListTodo } from 'lucide-react';
import { useMemo } from 'react';
import { addDays, dateInZone, dayBounds, formatDate } from '../planning/dates';
import type { Task, TimeBlock } from '../planning/types';

interface LinkedNoteTasksProps {
  noteId: string;
  tasks: readonly Task[];
  blocks: readonly TimeBlock[];
  timeZone: string;
  onEditTask: (task: Task) => void;
}

interface TaskGroup {
  date?: string;
  week?: boolean;
  tasks: Task[];
}

function groupByPlan(tasks: Task[], blocks: readonly TimeBlock[], timeZone: string): TaskGroup[] {
  const datesByTask = new Map(tasks.map(task => [task.id, new Set(task.plan?.kind === 'day' ? [task.plan.date] : [])]));
  for (const block of blocks) {
    const dates = datesByTask.get(block.taskId);
    if (!dates) continue;
    const start = dateInZone(block.startAt, timeZone);
    // The block's end is exclusive, including when it ends exactly at midnight.
    const last = dateInZone(new Date(Date.parse(block.startAt) + block.durationMinutes * 60_000 - 1), timeZone);
    dates.add(start);
    for (let date = start; date < last;) {
      date = addDays(date, 1);
      const [from, until] = dayBounds(date, timeZone);
      if (from < until) dates.add(date);
    }
  }

  const byDay = new Map<string, Task[]>();
  const byWeek = new Map<string, Task[]>();
  const unplanned: Task[] = [];
  const add = (groups: Map<string, Task[]>, date: string, task: Task) => {
    const group = groups.get(date);
    if (group) group.push(task);
    else groups.set(date, [task]);
  };
  for (const task of tasks) {
    const dates = datesByTask.get(task.id);
    if (dates?.size) for (const date of dates) add(byDay, date, task);
    else if (task.plan?.kind === 'week') add(byWeek, task.plan.weekStart, task);
    else unplanned.push(task);
  }

  return [
    ...[...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([date, group]) => ({ date, tasks: group })),
    ...[...byWeek].sort(([a], [b]) => a.localeCompare(b)).map(([date, group]) => ({ date, week: true, tasks: group })),
    ...(unplanned.length ? [{ tasks: unplanned }] : []),
  ];
}

export function LinkedNoteTasks({ noteId, tasks, blocks, timeZone, onEditTask }: LinkedNoteTasksProps) {
  const { count, groups } = useMemo(() => {
    const linked = tasks.filter(task => task.noteIds.includes(noteId));
    return { count: linked.length, groups: linked.length ? groupByPlan(linked, blocks, timeZone) : [] };
  }, [blocks, noteId, tasks, timeZone]);
  if (!count) return null;

  return <details className="note-linked-tasks">
    <summary><ListTodo size={16} aria-hidden="true" /> Verknüpfte Aufgaben <span>({count})</span><ChevronDown size={15} aria-hidden="true" /></summary>
    <div className="note-linked-groups">
      {groups.map(({ date, week, tasks }) => <div className="note-linked-group" key={date ? `${week ? 'week' : 'day'}-${date}` : 'unplanned'}>
        <h2>{date ? <>{week && 'Woche ab '}<time dateTime={date}>{formatDate(date, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })}</time></> : 'Ohne Planung'}</h2>
        <ul>{tasks.map(task => <li key={task.id}><button type="button" className="linked-task" onClick={() => onEditTask(task)}>{task.title}{task.status === 'done' && <span className="note-linked-status">Erledigt</span>}</button></li>)}</ul>
      </div>)}
    </div>
  </details>;
}
