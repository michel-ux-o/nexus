import { isDate, todayInZone } from './dates';
import { cloneSubtasks } from './subtasks';
import type { PlanningData, Task } from './types';

export const MORNING_ROUTINE_TITLE = 'Dein Start in den Morgen';

function assertToday(data: PlanningData, date: string, now: Date): void {
  if (!isDate(date) || date !== todayInZone(data.settings.timeZone, now)) {
    throw new Error('Die Morgenroutine kann nur für den heutigen Tag in deiner eingestellten Zeitzone gestartet oder übersprungen werden.');
  }
}

/** Receipts, including deleted or skipped instances, make opening today idempotent. */
export function materializeMorningRoutine(data: PlanningData, date: string, now = new Date()): PlanningData {
  assertToday(data, date, now);
  const receipts = data.morningRoutineReceipts ?? [];
  if (receipts.some((receipt) => receipt.date === date)) return data;

  // Recover a task whose receipt was omitted by an older/manual transfer without
  // changing any progress, text, or planning already entered in that instance.
  const existing = data.tasks.find((task) => task.morningRoutineDate === date);
  if (existing) return { ...data, morningRoutineReceipts: [...receipts, { date, taskId: existing.id, skipped: false }] };

  const weekday = ((new Date(`${date}T12:00:00.000Z`).getUTCDay() + 6) % 7) + 1;
  const template = data.settings.morningRoutine?.days.find((day) => day.weekday === weekday);
  if (!template?.enabled || !template.subtasks.length) return data;

  const id = `morning-routine:${date}`;
  if (data.tasks.some((task) => task.id === id)) {
    throw new Error('Die Tageskennung der Morgenroutine wird bereits verwendet. Bitte sichere deine Daten und prüfe den vorhandenen Eintrag.');
  }
  const stamp = now.toISOString();
  const task: Task = {
    id, title: MORNING_ROUTINE_TITLE, description: '', status: 'open', priority: null,
    estimatedMinutes: null, dueDate: null, plan: { kind: 'day', date },
    subtasks: cloneSubtasks(template.subtasks, true),
    noteIds: [], tags: [], morningRoutineDate: date, createdAt: stamp, updatedAt: stamp,
  };
  return { ...data, tasks: [...data.tasks, task], morningRoutineReceipts: [...receipts, { date, taskId: task.id, skipped: false }] };
}

/** A skip hides today's presentation; it never pretends the task was completed. */
export function skipMorningRoutine(data: PlanningData, date: string, now = new Date()): PlanningData {
  const prepared = materializeMorningRoutine(data, date, now);
  const receipt = prepared.morningRoutineReceipts?.find((item) => item.date === date);
  if (!receipt || receipt.skipped) return prepared;
  return { ...prepared, morningRoutineReceipts: prepared.morningRoutineReceipts!.map((item) => item.date === date ? { ...item, skipped: true } : item) };
}

export function activeMorningRoutine(data: PlanningData, date: string): Task | undefined {
  const receipt = data.morningRoutineReceipts?.find((item) => item.date === date);
  if (!receipt || receipt.skipped) return undefined;
  return data.tasks.find((task) => task.id === receipt.taskId && task.morningRoutineDate === date && task.status !== 'done');
}
