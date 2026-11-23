import type { PlanningData, Task } from '../planning/types';
import { scheduleDate, taskSchedule } from './taskSchedule';

export interface TaskSeries {
  id: string;
  next: Task | undefined;
  remaining: Task[];
}

interface TaskListEntry {
  task: Task;
  series?: TaskSeries;
}

/** Group the filtered tasks, retaining their order by the visible representative. */
export function groupTaskSeries(tasks: Task[], data: PlanningData, today: string, blockDates: ReadonlyMap<string, string>): TaskListEntry[] {
  const recurring = new Map((data.recurrenceReceipts ?? []).map(receipt => [receipt.taskId, receipt]));
  const routines = new Map((data.morningRoutineReceipts ?? []).map(receipt => [receipt.taskId, receipt]));
  const seriesIds = new Map<string, string>();
  const members = new Map<string, Task[]>();
  for (const task of tasks) {
    const ruleId = task.ruleId ?? recurring.get(task.id)?.ruleId;
    const id = ruleId ? `rule:${ruleId}` : task.morningRoutineDate || routines.has(task.id) ? 'morning-routine' : undefined;
    if (!id) continue;
    seriesIds.set(task.id, id);
    const group = members.get(id);
    if (group) group.push(task);
    else members.set(id, [task]);
  }

  const grouped = new Map<string, TaskListEntry>();
  for (const [id, group] of members) {
    if (group.length < 2) continue;
    const date = (task: Task) => scheduleDate(taskSchedule(task, blockDates)) ?? task.occurrenceDate
      ?? task.morningRoutineDate ?? recurring.get(task.id)?.date ?? routines.get(task.id)?.date;
    const open = group.filter(task => task.status !== 'done' && !routines.get(task.id)?.skipped);
    const dated = open.flatMap(task => {
      const day = date(task);
      return day ? [{ task, day }] : [];
    }).sort((a, b) => a.day.localeCompare(b.day));
    const next = dated.find(item => item.day >= today)?.task ?? dated.at(-1)?.task ?? open[0];
    const task = next ?? group[0];
    grouped.set(id, { task, series: { id, next, remaining: group.filter(item => item.id !== task.id) } });
  }

  return tasks.flatMap(task => {
    const id = seriesIds.get(task.id);
    const entry = id ? grouped.get(id) : undefined;
    if (!entry) return [{ task }];
    return entry.task.id === task.id ? [entry] : [];
  });
}
