import { addDays, dateInZone, formatDate, formatTime } from '../planning/dates';
import type { PlanningData, Reminder, ReminderOccurrence } from '../planning/types';

export const frequencyLabels: Record<Reminder['frequency'], string> = {
  once: 'Einmalig', daily: 'Täglich', weekly: 'Wöchentlich',
};

export function reminderTimeLabel(instant: string, zone: string): string {
  return `${formatDate(dateInZone(instant, zone), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })} · ${formatTime(instant, zone)}`;
}

export function reminderRelativeTime(occurrence: ReminderOccurrence, data: PlanningData): string | null {
  if (occurrence.status !== 'pending' || occurrence.effectiveAt !== occurrence.scheduledAt) return null;
  const { taskId, appointmentId } = occurrence.reminder;
  const zone = data.settings.timeZone;
  const reminderDay = dateInZone(occurrence.scheduledAt, zone);
  const task = taskId ? data.tasks.find(item => item.id === taskId) : undefined;
  const appointment = appointmentId ? data.appointments.find(item => item.id === appointmentId) : undefined;
  const blocks = task ? data.timeBlocks.filter(block => block.taskId === task.id && dateInZone(block.startAt, zone) === reminderDay) : [];
  const target = task && blocks.length === 1
    ? { title: task.title, startAt: blocks[0].startAt }
    : appointment && !appointment.allDay && dateInZone(appointment.startAt, zone) === reminderDay ? appointment : undefined;
  if (!target) return null;
  const difference = Date.parse(target.startAt) - Date.parse(occurrence.scheduledAt);
  if (difference === 0) return `Zum Beginn von „${target.title}“`;
  const minutes = Math.round(Math.abs(difference) / 60_000);
  if (minutes === 0) return null;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  const duration = [hours ? `${hours} Std.` : '', remainingMinutes ? `${remainingMinutes} Min.` : ''].filter(Boolean).join(' ');
  return `${duration} ${difference > 0 ? 'vor' : 'nach'} Beginn von „${target.title}“`;
}

export function boundedDay(date: string, difference: number): string {
  try { return addDays(date, difference); }
  catch { return difference < 0 ? '0001-01-01' : '9999-12-31'; }
}
