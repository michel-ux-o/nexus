import { addDays, dateInZone, formatDate, formatTime } from '../planning/dates';
import type { Reminder } from '../planning/types';

export const frequencyLabels: Record<Reminder['frequency'], string> = {
  once: 'Einmalig', daily: 'Täglich', weekly: 'Wöchentlich',
};

export function reminderTimeLabel(instant: string, zone: string): string {
  return `${formatDate(dateInZone(instant, zone), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })} · ${formatTime(instant, zone)}`;
}

export function boundedDay(date: string, difference: number): string {
  try { return addDays(date, difference); }
  catch { return difference < 0 ? '0001-01-01' : '9999-12-31'; }
}
