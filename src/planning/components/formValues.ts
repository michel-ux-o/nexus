import { addDays, isDate } from '../dates';

/** The form shows the last included day; the data model stores an exclusive end. */
export function allDayRange(startDate: string, lastDate: string): { startDate: string; endDate: string } {
  if (!isDate(startDate) || !isDate(lastDate)) throw new Error('Wähle einen gültigen ersten und letzten Tag.');
  if (lastDate < startDate) throw new Error('Der letzte Tag darf nicht vor dem ersten Tag liegen.');
  return { startDate, endDate: addDays(lastDate, 1) };
}

export function calendarDayDifference(from: string, to: string): number {
  if (!isDate(from) || !isDate(to)) throw new Error('Wähle ein gültiges Datum.');
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

export function taskTags(value: string): string[] {
  const tags = value.split(',').map((tag) => tag.trim()).filter(Boolean);
  return tags.filter((tag, index) => tags.findIndex((other) => other.toLocaleLowerCase('de') === tag.toLocaleLowerCase('de')) === index);
}
