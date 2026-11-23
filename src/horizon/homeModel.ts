import type { Note } from '../types';
import type { PlanningData, ReminderOccurrence, Task, TimeBlock } from '../planning/types';
import { addDays, dateInZone, dayBounds, isDate } from '../planning/dates';
import { tasksForDay } from '../planning/selectors';

export function horizonDayTasks(data: PlanningData, date: string): Task[] {
  const priorities = data.days.find(day => day.date === date)?.priorityTaskIds ?? [];
  return tasksForDay(data, date).sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done')
    || (priorities.includes(a.id) ? priorities.indexOf(a.id) : priorities.length) - (priorities.includes(b.id) ? priorities.indexOf(b.id) : priorities.length)
    || Number(b.priority === 'high') - Number(a.priority === 'high') || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function horizonRoutineTask(task: Task): boolean {
  return Boolean(task.morningRoutineDate || task.ruleId);
}

export function horizonDayBlocks(data: PlanningData, date: string): TimeBlock[] {
  const [from, to] = dayBounds(date, data.settings.timeZone);
  return data.timeBlocks.filter(block => Date.parse(block.startAt) < to && horizonBlockEnd(block) > from)
    .sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt) || left.id.localeCompare(right.id));
}

function horizonBlockEnd(block: Pick<TimeBlock, 'startAt' | 'durationMinutes'>): number {
  return Date.parse(block.startAt) + block.durationMinutes * 60_000;
}

/** Prefer work already in progress by schedule, then the next booked task. */
export function horizonRecommendTask(tasks: Task[], blocks: TimeBlock[], now: number | null): Task | null {
  const open = tasks.filter(task => task.status !== 'done' && !task.morningRoutineDate);
  const byId = new Map(open.map(task => [task.id, task]));
  const booked = blocks.find(block => byId.has(block.taskId) && (now === null || horizonBlockEnd(block) > now));
  if (booked) return byId.get(booked.taskId) ?? null;
  const scheduled = new Set(blocks.map(block => block.taskId));
  return open.find(task => !scheduled.has(task.id)) ?? open[0] ?? null;
}

export function horizonTaskBlock(blocks: TimeBlock[], taskId: string, now: number | null): TimeBlock | undefined {
  const matching = blocks.filter(block => block.taskId === taskId);
  return matching.find(block => now === null || horizonBlockEnd(block) > now) ?? matching.at(-1);
}

/** Show the next start first, with an ongoing block as the fallback for today. */
export function horizonNextTimedItem<T extends Pick<TimeBlock, 'startAt' | 'durationMinutes'>>(items: T[], now: number | null): T | undefined {
  return items.find(item => now === null || Date.parse(item.startAt) >= now)
    ?? (now === null ? undefined : items.find(item => horizonBlockEnd(item) > now));
}

export function horizonNextReminder(reminders: ReminderOccurrence[], now: number | null): ReminderOccurrence | undefined {
  const pending = reminders.filter(reminder => reminder.status === 'pending');
  return pending.find(reminder => now === null || Date.parse(reminder.effectiveAt) >= now) ?? pending[0];
}

export function horizonNotePreview(content: string): string {
  return content.slice(0, 4000)
    .replace(/^\s*(?:`{3,}|~{3,}).*$/gm, '')
    .replace(/^[\t ]*(?:\|?[\t ]*:?-{3,}:?[\t ]*(?:\|[\t ]*:?-{3,}:?[\t ]*)*\|?|[-*_]{3,})[\t ]*$/gm, '')
    .replace(/^(?:[\t ]*>[\t ]?)+/gm, '')
    .replace(/^[\t ]*#{1,6}[\t ]+(.*?)(?:[\t ]+#+)?$/gm, '$1')
    .replace(/^[\t ]*(?:[-*+]|\d+[.)])[\t ]+(?:\[[ xX]\][\t ]*)?/gm, '')
    .replace(/!?\[([^\[\]\n]*)\]\((?:[^()\n]|\([^()\n]*\))*\)/g, '$1')
    .replace(/`+([^`\n]+)`+|\*{1,3}([^*\n]+)\*{1,3}|(?<![\w_])_{1,3}([^_\n]+)_{1,3}(?![\w_])|~~([^~\n]+)~~/g,
      (_match, code, bold, emphasis, crossed) => code ?? bold ?? emphasis ?? crossed)
    .replace(/\\([!#$%&'()*+,\-./:;<=>?@[\]\\^`_{|}~])/g, '$1')
    .replace(/^[\t ]*\||\|[\t ]*$/gm, '')
    .replace(/[\t ]+\|[\t ]+/g, ' · ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

/** Explicit date tags and task links remain useful after a note is edited on another day. */
export function horizonDayNotes(notes: Note[], tasks: Task[], date: string, timeZone: string): Note[] {
  const linked = new Set(tasks.flatMap(task => task.noteIds));
  return notes.filter(note => {
    if (note.deletedAt) return false;
    const assigned = note.tags.filter(tag => /^tag:\d{4}-\d{2}-\d{2}$/.test(tag));
    return linked.has(note.id) || (assigned.length ? assigned.includes('tag:' + date)
      : dateInZone(note.updatedAt, timeZone) === date || dateInZone(note.createdAt, timeZone) === date);
  }).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

export function horizonShiftDate(date: string, offset: number): string {
  try { return addDays(date, offset); } catch { return date; }
}

export function horizonDateStrip(date: string): string[] {
  return [...new Set(Array.from({ length: 15 }, (_, index) => horizonShiftDate(date, index - 7)))];
}

/** Opening focus from the task library must not silently select a different task. */
export function horizonTaskDate(data: PlanningData, task: Task): string | null {
  if (task.plan?.kind === 'day') return task.plan.date;
  const block = data.timeBlocks.filter(item => item.taskId === task.id)
    .sort((a, b) => a.startAt.localeCompare(b.startAt))[0];
  return block ? dateInZone(block.startAt, data.settings.timeZone) : null;
}

export function horizonNextTaskId(tasks: Task[], current: string | null, direction: number): string | null {
  if (!tasks.length) return null;
  const index = tasks.findIndex(task => task.id === current);
  if (index < 0) return tasks[direction < 0 ? tasks.length - 1 : 0].id;
  return tasks[(index + direction % tasks.length + tasks.length) % tasks.length].id;
}

export interface HorizonDayDraft {
  taskTitle: string; taskId: string; noteTitle: string; noteContent: string; noteOperationId: string;
  reminderTitle: string; reminderTime: string; reminderId: string;
}
export interface HorizonSubtaskDraft { title: string; id: string }
export interface HorizonDraftBook { days: Record<string, HorizonDayDraft>; subtasks: Record<string, HorizonSubtaskDraft> }
export function emptyHorizonDraft(): HorizonDayDraft {
  return { taskTitle: '', taskId: '', noteTitle: '', noteContent: '', noteOperationId: '', reminderTitle: '', reminderTime: '09:00', reminderId: '' };
}

/** Free-standing text can carry over; identities may refer to replaced workspace data. */
export function horizonDraftsForWorkspace(book: HorizonDraftBook): HorizonDraftBook {
  return { days: Object.fromEntries(Object.entries(book.days).map(([date, draft]) => [date, { ...draft, taskId: '', noteOperationId: '', reminderId: '' }])), subtasks: Object.create(null) };
}

/** Only known text fields are restored; storage never contains audio or planner snapshots. */
export function parseHorizonDrafts(serialized: string | null): HorizonDraftBook {
  const result: HorizonDraftBook = { days: Object.create(null), subtasks: Object.create(null) };
  if (!serialized) return result;
  let source: unknown;
  try { source = JSON.parse(serialized); } catch { return result; }
  if (!source || typeof source !== 'object') return result;
  const { days, subtasks } = source as Record<string, unknown>;
  if (days && typeof days === 'object' && !Array.isArray(days)) {
    for (const [date, value] of Object.entries(days)) {
      if (!isDate(date) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
      const draft = emptyHorizonDraft();
      for (const key of Object.keys(draft) as (keyof HorizonDayDraft)[]) {
        const field = (value as Record<string, unknown>)[key];
        if (typeof field === 'string') draft[key] = field.slice(0, key === 'noteContent' ? 200_000 : key.endsWith('Id') ? 128 : 500);
      }
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.reminderTime)) draft.reminderTime = '09:00';
      result.days[date] = draft;
    }
  }
  if (subtasks && typeof subtasks === 'object' && !Array.isArray(subtasks)) {
    for (const [taskId, value] of Object.entries(subtasks)) {
      if (!taskId || taskId.length > 128 || !value || typeof value !== 'object') continue;
      const item = value as Record<string, unknown>;
      if (typeof item.title === 'string') result.subtasks[taskId] = { title: item.title.slice(0, 500), id: typeof item.id === 'string' ? item.id.slice(0, 128) : '' };
    }
  }
  return result;
}
