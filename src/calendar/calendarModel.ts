import { addDays, dateInZone, formatTime, isDate, startOfWeek } from '../planning/dates';
import { allDayAppointmentsForDay, timedAppointmentsForDay } from '../planning/selectors';
import type { Appointment, PlanningData, Task, TimeBlock } from '../planning/types';

export type CalendarMode = 'month' | 'week' | 'day';
type BlockTime = { block: TimeBlock; label: string };
export type CalendarEntry =
  | { kind: 'all-day' | 'appointment'; id: string; title: string; label: string; appointment: Appointment }
  | { kind: 'due' | 'planned'; id: string; title: string; label: string; task: Task; planned: boolean }
  | { kind: 'block'; id: string; title: string; label: string; times: [BlockTime, ...BlockTime[]]; task?: Task; due: boolean };

export function monthDates(date: string): string[] {
  const first = startOfWeek(`${date.slice(0, 7)}-01`);
  return Array.from({ length: 42 }, (_, index) => addDays(first, index));
}

export function calendarDates(date: string, mode: CalendarMode): string[] {
  if (mode === 'month') return monthDates(date);
  const first = mode === 'week' ? startOfWeek(date) : date;
  return Array.from({ length: mode === 'week' ? 7 : 1 }, (_, index) => addDays(first, index));
}

/** Preserve the selected day where possible when moving through months. */
export function shiftCalendarDate(date: string, mode: CalendarMode, direction: -1 | 1): string {
  if (mode !== 'month') return addDays(date, direction * (mode === 'week' ? 7 : 1));
  const value = new Date(`${date.slice(0, 7)}-01T12:00:00.000Z`);
  value.setUTCMonth(value.getUTCMonth() + direction);
  const month = value.toISOString().slice(0, 7);
  value.setUTCMonth(value.getUTCMonth() + 1, 0);
  const result = `${month}-${String(Math.min(Number(date.slice(8)), value.getUTCDate())).padStart(2, '0')}`;
  if (!isDate(result)) throw new Error('Dieser Monat liegt außerhalb des unterstützten Kalenderbereichs.');
  return result;
}

export function blocksForCalendarDay(data: PlanningData, date: string): TimeBlock[] {
  return data.timeBlocks.filter(block => dateInZone(block.startAt, data.settings.timeZone) <= date
    && dateInZone(new Date(Date.parse(block.startAt) + block.durationMinutes * 60_000 - 1), data.settings.timeZone) >= date)
    .sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt) || left.id.localeCompare(right.id));
}

export function entriesForCalendarDay(data: PlanningData, date: string): CalendarEntry[] {
  const zone = data.settings.timeZone;
  const taskMap = new Map(data.tasks.map(task => [task.id, task]));
  const timeLabel = (startAt: string) => `${dateInZone(startAt, zone) < date ? 'seit ' : ''}${formatTime(startAt, zone)}`;
  const timed: { entry: CalendarEntry; startAt: string }[] = timedAppointmentsForDay(data, date).map(appointment => ({
    entry: { kind: 'appointment', id: `appointment:${appointment.id}`, title: appointment.title, label: timeLabel(appointment.startAt), appointment },
    startAt: appointment.startAt,
  }));
  const taskBlocks = new Map<string, Extract<CalendarEntry, { kind: 'block' }>>();
  for (const block of blocksForCalendarDay(data, date)) {
    const time = { block, label: timeLabel(block.startAt) };
    const existing = taskBlocks.get(block.taskId);
    if (existing) {
      existing.times.push(time);
      continue;
    }
    const task = taskMap.get(block.taskId);
    const entry: Extract<CalendarEntry, { kind: 'block' }> = {
      kind: 'block', id: task ? `task:${task.id}` : `block:${block.id}`, title: task?.title ?? 'Zeitblock',
      label: time.label, times: [time], task, due: task?.dueDate === date,
    };
    timed.push({ entry, startAt: block.startAt });
    if (task) taskBlocks.set(task.id, entry);
  }
  timed.sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt) || left.entry.id.localeCompare(right.entry.id));
  const flexible = data.tasks.flatMap((task): CalendarEntry[] => {
    if (taskBlocks.has(task.id)) return [];
    const due = task.dueDate === date;
    const planned = task.plan?.kind === 'day' && task.plan.date === date;
    if (!due && !planned) return [];
    return [{ kind: due ? 'due' : 'planned', id: `task:${task.id}`, title: task.title, label: due ? 'Fällig' : 'Geplant', task, planned }];
  });
  return [
    ...allDayAppointmentsForDay(data, date).map(appointment => ({
      kind: 'all-day' as const, id: `all-day:${appointment.id}`, title: appointment.title, label: 'Ganztägig', appointment,
    })),
    ...timed.map(item => item.entry),
    ...flexible,
  ];
}
