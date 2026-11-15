import type { Note } from '../types';
import type { Appointment, PlanningData, Task } from '../planning/types';

export type SearchResult =
  | { kind: 'task'; item: Task }
  | { kind: 'note'; item: Note }
  | { kind: 'appointment'; item: Appointment };
export type SearchKind = SearchResult['kind'];
export interface SearchEntry { result: SearchResult; title: string; text: string }
const collator = new Intl.Collator('de', { sensitivity: 'base', numeric: true });

/** Search is literal text. Umlauts, their typed equivalents and ß share a spelling. */
export function normalizeSearch(value: string): string {
  return value.toLocaleLowerCase('de').normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/ß/g, 'ss').replace(/ae/g, 'a').replace(/oe/g, 'o').replace(/ue/g, 'u').replace(/\s+/g, ' ').trim();
}

/** Deleted notes are deliberately excluded, including their revision histories. */
export function createWorkspaceSearchIndex(data: Pick<PlanningData, 'tasks' | 'appointments'>, notes: Note[]): SearchEntry[] {
  const results: SearchResult[] = [
    ...data.tasks.map((item): SearchResult => ({ kind: 'task', item })),
    ...notes.filter((item) => !item.deletedAt).map((item): SearchResult => ({ kind: 'note', item })),
    ...data.appointments.map((item): SearchResult => ({ kind: 'appointment', item })),
  ];
  return results.map((result) => {
    const item = result.item;
    const body = result.kind === 'note' ? result.item.content : result.item.description;
    const tags = result.kind === 'appointment' ? [] : result.item.tags ?? [];
    const subtasks = result.kind === 'task' ? result.item.subtasks.flatMap((step) => [step.title, ...(step.children ?? []).map(child => child.title)]) : [];
    return { result, title: normalizeSearch(item.title), text: normalizeSearch([item.title, body, ...tags.flatMap((tag) => [tag, `#${tag}`]), ...subtasks].join(' ')) };
  });
}

/** All words must match; exact titles precede title prefixes and body matches. */
export function queryWorkspaceSearch(index: SearchEntry[], query: string): SearchResult[] {
  const normalized = normalizeSearch(query);
  if (!normalized) return [];
  const words = normalized.split(' ');
  const rank = (entry: SearchEntry) => entry.title === normalized ? 0 : entry.title.startsWith(normalized) ? 1 : words.every((word) => entry.title.includes(word)) ? 2 : 3;
  return index.filter((entry) => words.every((word) => entry.text.includes(word)))
    .sort((left, right) => rank(left) - rank(right)
      || right.result.item.updatedAt.localeCompare(left.result.item.updatedAt)
      || collator.compare(left.result.item.title, right.result.item.title)
      || left.result.item.id.localeCompare(right.result.item.id))
    .map((entry) => entry.result);
}

export function searchWorkspace(data: Pick<PlanningData, 'tasks' | 'appointments'>, notes: Note[], query: string): SearchResult[] {
  return queryWorkspaceSearch(createWorkspaceSearchIndex(data, notes), query);
}
