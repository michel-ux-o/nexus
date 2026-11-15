import type { PlanningData } from './types';

type Collection = 'tasks' | 'appointments' | 'timeBlocks' | 'days' | 'taskRules' | 'reminders' | 'reminderReceipts' | 'morningRoutineReceipts';
type Row = Record<string, unknown>;
type Change = { collection: Collection; id: string; before: Row | null; after: Row | null; fields: string[] };
export interface UndoEntry { label: string; revision: number; changes: Change[] }
const keys: Record<Collection, string> = { tasks: 'id', appointments: 'id', timeBlocks: 'id', days: 'date', taskRules: 'id', reminders: 'id', reminderReceipts: 'id', morningRoutineReceipts: 'date' };
const collections = Object.keys(keys) as Collection[];
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const rows = (data: PlanningData, collection: Collection): Row[] => (data[collection] ?? []) as unknown as Row[];
export function makeUndo(before: PlanningData, after: PlanningData, label: string, revision: number): UndoEntry | null {
  const changes: Change[] = [];
  for (const collection of collections) {
    const key = keys[collection];
    const previous = new Map(rows(before, collection).map(row => [String(row[key]), row]));
    const next = new Map(rows(after, collection).map(row => [String(row[key]), row]));
    for (const id of new Set([...previous.keys(), ...next.keys()])) {
      const old = previous.get(id) ?? null; const current = next.get(id) ?? null;
      // System notification timestamps are not part of a user's receipt action.
      const fields = [...new Set([...Object.keys(old ?? {}), ...Object.keys(current ?? {})])].filter(field => field !== 'updatedAt' && (collection !== 'days' || field === 'priorityTaskIds') && !(collection === 'reminderReceipts' && field === 'notifiedAt') && !equal(old?.[field], current?.[field]));
      if (fields.length) changes.push({ collection, id, before: old, after: current, fields });
    }
  }
  return changes.length ? { label, revision, changes: structuredClone(changes) } : null;
}
export function applyUndo(data: PlanningData, entry: UndoEntry, now: (previous?: string) => string): PlanningData {
  const result = structuredClone(data);
  for (const change of entry.changes) {
    if (!result[change.collection]) (result as unknown as Record<string, unknown>)[change.collection] = [];
    const list = rows(result, change.collection); const key = keys[change.collection];
    const index = list.findIndex(row => String(row[key]) === change.id); const current = index < 0 ? null : list[index];
    if (!change.after) {
      if (current) throw new Error('Rückgängig nicht möglich: Ein gelöschter Eintrag wurde erneut angelegt.');
    } else if (!current || change.fields.some(field => !equal(current[field], change.after?.[field]))) {
      throw new Error('Rückgängig nicht möglich: Betroffene Daten wurden inzwischen geändert.');
    }
    if (!change.before) {
      // Do not delete entities subsequently modified in fields outside the original action.
      if (change.collection !== 'days' && current && Object.keys(current).some(field => field !== 'updatedAt' && !(change.collection === 'reminderReceipts' && field === 'notifiedAt') && !equal(current[field], change.after?.[field]))) throw new Error('Rückgängig nicht möglich: Der Eintrag wurde inzwischen geändert.');
      if (change.collection === 'days' && current) {
        list[index] = { ...current, priorityTaskIds: [] };
      } else if (change.collection === 'taskRules' && current && (result.recurrenceReceipts ?? []).some(receipt => receipt.ruleId === change.id)) {
        list[index] = { ...current, paused: true, updatedAt: now(String(current.updatedAt)) };
      } else if (change.collection === 'reminderReceipts' && current) {
        list[index] = { ...current, status: 'pending', snoozedUntil: null };
      } else if (index >= 0) list.splice(index, 1);
    } else if (!current) {
      const restored = structuredClone(change.before);
      if ('updatedAt' in restored) restored.updatedAt = now(String(restored.updatedAt));
      list.push(restored);
    } else {
      const restored = { ...current };
      for (const field of change.fields) {
        if (field in change.before) restored[field] = structuredClone(change.before[field]);
        else delete restored[field];
      }
      if ('updatedAt' in restored) restored.updatedAt = now(String(current.updatedAt));
      list[index] = restored;
    }
  }
  return result;
}
