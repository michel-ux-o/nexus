import { dateInZone, formatDate } from '../planning/dates';
import type { PlanningData, Task, TaskPlan } from '../planning/types';

export function firstTaskBlockDates(data: PlanningData): ReadonlyMap<string, string> {
  const firstStarts = new Map<string, number>();
  for (const block of data.timeBlocks) {
    const start = Date.parse(block.startAt);
    if (start < (firstStarts.get(block.taskId) ?? Infinity)) firstStarts.set(block.taskId, start);
  }
  return new Map(Array.from(firstStarts, ([id, start]) => [id, dateInZone(new Date(start), data.settings.timeZone)]));
}

export function taskSchedule(task: Task, blockDates: ReadonlyMap<string, string>): TaskPlan {
  if (task.plan) return task.plan;
  const blockDate = blockDates.get(task.id);
  return blockDate ? { kind: 'day', date: blockDate } : null;
}

export function scheduleDate(plan: TaskPlan): string | undefined {
  return plan?.kind === 'week' ? plan.weekStart : plan?.date;
}

export function shortScheduleDate(plan: NonNullable<TaskPlan>, today: string): string {
  const date = plan.kind === 'week' ? plan.weekStart : plan.date;
  const year = date.slice(0, 4) === today.slice(0, 4) ? undefined : 'numeric';
  const label = formatDate(date, { weekday: plan.kind === 'day' ? 'short' : undefined, day: 'numeric', month: 'short', year });
  return plan.kind === 'week' ? `Woche ab ${label}` : label;
}
