import type { Appointment, PlanningData, ReminderOccurrence, TimeBlock } from '../planning/types';
import { dateInZone, formatDate, formatTime } from '../planning/dates';

export function minutesLabel(minutes: number): string {
  const rounded = Math.round(Math.abs(minutes));
  if (rounded < 60) return `${rounded} Min.`;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return `${hours} Std.${rest ? ` ${rest} Min.` : ''}`;
}

export function shortDate(date: string, today: string): string {
  return formatDate(date, { day: 'numeric', month: 'short', ...(date.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' as const } : {}) });
}

export function notePreview(content: string): string {
  return content.replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/^\s*[-*+]\s+(?:\[[ xX]\]\s*)?/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim().slice(0, 150);
}

interface UpcomingBase { id: string; title: string; date: string; time: string; dateTime: string; label: string; ongoing: boolean; adjusted: boolean }
export type UpcomingItem = UpcomingBase & (
  { kind: 'appointment'; appointment: Appointment }
  | { kind: 'block'; block: TimeBlock }
  | { kind: 'reminder'; occurrence: ReminderOccurrence }
);

/** A shared civil-date range keeps all-day entries out of the timed-event arithmetic. */
export function upcomingItems(data: PlanningData, today: string, through: string, now: Date, reminders: ReminderOccurrence[]): UpcomingItem[] {
  const zone = data.settings.timeZone;
  const nowTime = now.getTime();
  const items: UpcomingItem[] = [];
  for (const appointment of data.appointments) {
    if (appointment.allDay) {
      const { startDate, endDate } = appointment.allDay;
      if (endDate <= today || startDate > through) continue;
      const date = startDate < today ? today : startDate;
      items.push({ id: `appointment:${appointment.id}`, kind: 'appointment', appointment, title: appointment.title,
        date, time: '', dateTime: startDate, label: 'Ganztägiger Termin', ongoing: startDate < today, adjusted: false });
      continue;
    }
    const start = Date.parse(appointment.startAt);
    const date = dateInZone(appointment.startAt, zone);
    if (start + appointment.durationMinutes * 60_000 <= nowTime || date > through) continue;
    items.push({ id: `appointment:${appointment.id}`, kind: 'appointment', appointment, title: appointment.title,
      date: date < today ? today : date, time: start <= nowTime ? formatTime(now, zone) : formatTime(appointment.startAt, zone),
      dateTime: appointment.startAt, label: 'Termin', ongoing: start <= nowTime, adjusted: false });
  }
  const tasks = new Map(data.tasks.map(task => [task.id, task]));
  for (const block of data.timeBlocks) {
    const task = tasks.get(block.taskId);
    if (!task) continue;
    const start = Date.parse(block.startAt);
    const date = dateInZone(block.startAt, zone);
    if (start + block.durationMinutes * 60_000 <= nowTime || date > through) continue;
    items.push({ id: `block:${block.id}`, kind: 'block', block, title: task.title,
      date: date < today ? today : date, time: start <= nowTime ? formatTime(now, zone) : formatTime(block.startAt, zone),
      dateTime: block.startAt, label: 'Aufgabenblock', ongoing: start <= nowTime, adjusted: false });
  }
  for (const occurrence of reminders) {
    if (occurrence.status !== 'pending' || Date.parse(occurrence.effectiveAt) < nowTime) continue;
    const date = dateInZone(occurrence.effectiveAt, zone);
    if (date > through) continue;
    items.push({ id: `reminder:${occurrence.id}`, kind: 'reminder', occurrence, title: occurrence.reminder.title,
      date, time: formatTime(occurrence.effectiveAt, zone), dateTime: occurrence.effectiveAt,
      label: 'Erinnerung', ongoing: false, adjusted: occurrence.adjusted });
  }
  return items.sort((left, right) => left.date.localeCompare(right.date) || left.time.localeCompare(right.time) || left.id.localeCompare(right.id));
}
