import { addDays, dayBoundary, dayBounds, startOfWeek } from './dates';
import type { Appointment, PlanningData, Task } from './types';

function bounds(data: PlanningData, date: string): [number, number] {
  return dayBounds(date, data.settings.timeZone);
}

function overlap(startAt: string, durationMinutes: number, range: [number, number]): number {
  const start = Date.parse(startAt);
  return Math.max(0, Math.min(start + durationMinutes * 60_000, range[1]) - Math.max(start, range[0]));
}

export function tasksForDay(data: PlanningData, date: string): Task[] {
  const range = bounds(data, date);
  const blocked = new Set(data.timeBlocks.filter((block) => overlap(block.startAt, block.durationMinutes, range) > 0).map((block) => block.taskId));
  return data.tasks.filter((task) => (task.plan?.kind === 'day' && task.plan.date === date) || blocked.has(task.id));
}

export function tasksForWeek(data: PlanningData, weekStart: string): Task[] {
  const first = startOfWeek(weekStart);
  const last = first > '9999-12-25' ? '9999-12-31' : addDays(first, 6);
  const range: [number, number] = [dayBoundary(first, data.settings.timeZone), dayBounds(last, data.settings.timeZone)[1]];
  const blocked = new Set(data.timeBlocks.filter((block) => overlap(block.startAt, block.durationMinutes, range) > 0).map((block) => block.taskId));
  return data.tasks.filter((task) => blocked.has(task.id) || (task.plan?.kind === 'week'
    ? task.plan.weekStart === first
    : task.plan?.kind === 'day' && task.plan.date >= first && task.plan.date <= last));
}

export function inboxTasks(data: PlanningData): Task[] {
  const blocked = new Set(data.timeBlocks.map((block) => block.taskId));
  return data.tasks.filter((task) => task.plan === null && !blocked.has(task.id));
}

export function weekPool(data: PlanningData, weekStart: string): Task[] {
  const first = startOfWeek(weekStart);
  return data.tasks.filter((task) => task.plan?.kind === 'week' && task.plan.weekStart === first);
}

export function allDayAppointmentsForDay(data: PlanningData, date: string): Appointment[] {
  bounds(data, date);
  return data.appointments.filter((item) => item.allDay && item.allDay.startDate <= date && date < item.allDay.endDate);
}

export function timedAppointmentsForDay(data: PlanningData, date: string): Appointment[] {
  const range = bounds(data, date);
  return data.appointments.filter((item) => !item.allDay && overlap(item.startAt, item.durationMinutes, range) > 0);
}

export function appointmentsForDay(data: PlanningData, date: string): Appointment[] {
  return [...allDayAppointmentsForDay(data, date), ...timedAppointmentsForDay(data, date)];
}

/** Actual event/block minutes on this day + estimates for day tasks without a block on this day. */
export function plannedMinutes(data: PlanningData, date: string): number {
  const range = bounds(data, date);
  const blocks = data.timeBlocks.filter((block) => overlap(block.startAt, block.durationMinutes, range) > 0);
  const taskIds = new Set(blocks.map((block) => block.taskId));
  const intervals = [...blocks, ...data.appointments.filter((item) => !item.allDay)];
  return intervals.reduce((total, item) => total + overlap(item.startAt, item.durationMinutes, range) / 60_000, 0)
    + data.tasks.filter((task) => task.plan?.kind === 'day' && task.plan.date === date && !taskIds.has(task.id))
      .reduce((total, task) => total + (task.estimatedMinutes ?? 0), 0);
}

export function conflictsForDay(data: PlanningData, date: string): { ids: string[]; message: string }[] {
  const range = bounds(data, date);
  const intervals = [...data.appointments.filter((item) => !item.allDay).map((item) => ({ ...item, label: item.title })),
    ...data.timeBlocks.map((item) => ({ ...item, label: data.tasks.find((task) => task.id === item.taskId)?.title ?? 'Zeitblock' }))]
    .filter((item) => overlap(item.startAt, item.durationMinutes, range) > 0)
    .sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt));
  const conflicts: { ids: string[]; message: string }[] = [];
  for (let i = 0; i < intervals.length; i++) {
    for (let j = i + 1; j < intervals.length; j++) {
      const left = intervals[i]; const right = intervals[j];
      if (Date.parse(right.startAt) >= Date.parse(left.startAt) + left.durationMinutes * 60_000) break;
      conflicts.push({ ids: [left.id, right.id], message: `„${left.label}“ und „${right.label}“ überschneiden sich.` });
    }
  }
  return conflicts;
}
