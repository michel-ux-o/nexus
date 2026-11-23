import type { PlanningData, Priority, Task, TaskStatus } from '../planning/types';
import { tasksForDay } from '../planning/selectors';
import { firstTaskBlockDates, scheduleDate, taskSchedule } from './taskSchedule';

export interface TaskFilters {
  search: string;
  planning: 'all' | 'inbox' | 'planned' | 'today' | 'day' | 'week';
  status: 'all' | 'active' | TaskStatus;
  priority: 'all' | 'none' | Exclude<Priority, null>;
  sort: 'due' | 'priority' | 'planning' | 'updated' | 'title';
}
export const DEFAULT_TASK_FILTERS: TaskFilters = { search: '', planning: 'all', status: 'active', priority: 'all', sort: 'due' };

function searchable(value: string): string { return value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('de'); }
function rank(task: Task): number { return task.priority === 'high' ? 0 : task.priority === 'normal' ? 1 : task.priority === 'low' ? 2 : 3; }
/** All filters compose; sorting copies the array and never changes stored tasks. */
export function filterTasks(data: PlanningData, filters: TaskFilters, today: string, blockDates?: ReadonlyMap<string, string>): Task[] {
  const blocked = new Set(data.timeBlocks.map((block) => block.taskId));
  const dates = filters.sort === 'planning' ? blockDates ?? firstTaskBlockDates(data) : null;
  const plannedDate = (task: Task) => dates ? scheduleDate(taskSchedule(task, dates)) ?? '9999-99-99' : '9999-99-99';
  const todayIds = filters.planning === 'today' ? new Set(tasksForDay(data, today).map((task) => task.id)) : null;
  const words = searchable(filters.search.trim()).split(/\s+/).filter(Boolean);
  return data.tasks.filter((task) => {
    if (filters.status === 'active' ? task.status === 'done' : filters.status !== 'all' && task.status !== filters.status) return false;
    if (filters.priority === 'none' ? task.priority !== null : filters.priority !== 'all' && task.priority !== filters.priority) return false;
    if (filters.planning === 'inbox' && (task.plan !== null || blocked.has(task.id))) return false;
    if (filters.planning === 'planned' && task.plan === null && !blocked.has(task.id)) return false;
    if (filters.planning === 'today' && !todayIds?.has(task.id)) return false;
    if (filters.planning === 'day' && task.plan?.kind !== 'day') return false;
    if (filters.planning === 'week' && task.plan?.kind !== 'week') return false;
    const haystack = searchable([task.title, task.description, ...(task.tags ?? []), ...task.subtasks.flatMap((item) => [item.title, ...(item.children ?? []).map(child => child.title)])].join(' '));
    return words.every((word) => haystack.includes(word));
  }).sort((a, b) => {
    let difference = 0;
    if (filters.sort === 'due') difference = (a.dueDate ?? '9999-99-99').localeCompare(b.dueDate ?? '9999-99-99');
    if (filters.sort === 'priority') difference = rank(a) - rank(b);
    if (filters.sort === 'planning') difference = plannedDate(a).localeCompare(plannedDate(b));
    if (filters.sort === 'updated') difference = b.updatedAt.localeCompare(a.updatedAt);
    return difference || a.title.localeCompare(b.title, 'de') || a.id.localeCompare(b.id);
  });
}
