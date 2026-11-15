import { addDays, daysBetween, isDate, todayInZone } from './dates';
import { cloneSubtasks } from './subtasks';
import type { PlanningData, Task, TaskRule } from './types';

export function ruleOccursOn(rule: TaskRule, date: string): boolean {
  if (date < rule.startDate || (rule.endDate !== null && date > rule.endDate)) return false;
  const weekday = new Date(`${date}T12:00:00.000Z`).getUTCDay();
  return rule.frequency === 'daily' || (rule.frequency === 'weekdays' ? weekday !== 0 && weekday !== 6 : daysBetween(rule.startDate, date) % 7 === 0);
}

/** A calendar occurrence and its receipt are always prepared in the same snapshot. */
export function materializeRecurring(data: PlanningData, from: string, to: string, now = new Date()): PlanningData {
  if (!isDate(from) || !isDate(to) || to < from || daysBetween(from, to) >= 42) {
    throw new Error('Wiederholungen können für höchstens 42 aufeinanderfolgende Tage angelegt werden.');
  }
  if (to > addDays(todayInZone(data.settings.timeZone, now), 42)) {
    throw new Error('Wiederholungen können höchstens 42 Tage im Voraus angelegt werden.');
  }
  const receipts = [...(data.recurrenceReceipts ?? [])];
  const known = new Set(receipts.map((receipt) => `${receipt.ruleId}\u0000${receipt.date}`));
  const tasks = [...data.tasks];
  const stamp = now.toISOString();
  for (const rule of data.taskRules ?? []) {
    if (rule.paused) continue;
    for (let offset = 0, length = daysBetween(from, to); offset <= length; offset++) {
      const date = addDays(from, offset);
      const key = `${rule.id}\u0000${date}`;
      if (known.has(key) || !ruleOccursOn(rule, date)) continue;
      const template = rule.template;
      const task: Task = {
        id: crypto.randomUUID(), title: template.title, description: template.description, status: 'open',
        priority: template.priority, estimatedMinutes: template.estimatedMinutes,
        dueDate: template.dueOffsetDays === null ? null : addDays(date, template.dueOffsetDays),
        plan: { kind: 'day', date }, subtasks: cloneSubtasks(template.subtasks, true),
        noteIds: [...template.noteIds], tags: [...template.tags], ruleId: rule.id, occurrenceDate: date,
        createdAt: stamp, updatedAt: stamp,
      };
      tasks.push(task); receipts.push({ ruleId: rule.id, date, taskId: task.id }); known.add(key);
    }
  }
  return tasks.length === data.tasks.length ? data : { ...data, tasks, recurrenceReceipts: receipts };
}
