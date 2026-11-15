import { addDays, dateInZone, formatTime, isDate, startOfWeek } from '../planning/dates';
import { allDayAppointmentsForDay, timedAppointmentsForDay } from '../planning/selectors';
import type { Appointment, PlanningData, Task, TimeBlock } from '../planning/types';

export type CalendarMode = 'month' | 'week' | 'day';
export type CalendarEntry =
  | { kind: 'all-day' | 'appointment'; id: string; title: string; label: string; appointment: Appointment }
  | { kind: 'due' | 'planned'; id: string; title: string; label: string; task: Task }
  | { kind: 'block'; id: string; title: string; label: string; block: TimeBlock; task?: Task };

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

/** Fälligkeit and explicit day planning are separate entries, even for the same task. */
export function entriesForCalendarDay(data: PlanningData, date: string): CalendarEntry[] {
  const zone = data.settings.timeZone;
  const taskMap = new Map(data.tasks.map(task => [task.id, task]));
  const timed: CalendarEntry[] = [
    ...timedAppointmentsForDay(data, date).map(appointment => ({
      kind: 'appointment' as const, id: `appointment:${appointment.id}`, title: appointment.title,
      label: `${dateInZone(appointment.startAt, zone) < date ? 'seit ' : ''}${formatTime(appointment.startAt, zone)}`,
      appointment,
    })),
    ...blocksForCalendarDay(data, date).map(block => ({
      kind: 'block' as const, id: `block:${block.id}`, title: taskMap.get(block.taskId)?.title ?? 'Zeitblock',
      label: `${dateInZone(block.startAt, zone) < date ? 'seit ' : ''}${formatTime(block.startAt, zone)} · ${block.durationMinutes} Min.`,
      block, task: taskMap.get(block.taskId),
    })),
  ];
  timed.sort((left, right) => {
    const instant = (entry: CalendarEntry) => entry.kind === 'block' ? entry.block.startAt
      : 'appointment' in entry ? entry.appointment.startAt : '';
    return Date.parse(instant(left)) - Date.parse(instant(right)) || left.id.localeCompare(right.id);
  });
  return [
    ...allDayAppointmentsForDay(data, date).map(appointment => ({
      kind: 'all-day' as const, id: `all-day:${appointment.id}`, title: appointment.title, label: 'Ganztägig', appointment,
    })),
    ...data.tasks.filter(task => task.dueDate === date).map(task => ({
      kind: 'due' as const, id: `due:${task.id}`, title: task.title, label: 'Fällig', task,
    })),
    ...timed,
    ...data.tasks.filter(task => task.plan?.kind === 'day' && task.plan.date === date).map(task => ({
      kind: 'planned' as const, id: `planned:${task.id}`, title: task.title,
      label: `Geplant${task.estimatedMinutes === null ? ' · ohne Schätzung' : ` · ${task.estimatedMinutes} Min.`}`, task,
    })),
  ];
}
