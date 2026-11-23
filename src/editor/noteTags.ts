import { formatDate, isDate } from '../planning/dates';

export function noteTagDate(tag: string): string | null {
  const date = tag.startsWith('tag:') ? tag.slice(4) : null;
  return isDate(date) ? date : null;
}

export function noteTagLabel(tag: string, prefix = ''): string {
  const date = noteTagDate(tag);
  return date ? formatDate(date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : `${prefix}${tag}`;
}
