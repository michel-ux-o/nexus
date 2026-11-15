import type { PlanningData } from '../planning/types';
import type { Note } from '../types';
import type { SceneEvent, SceneRegion } from './sceneEvents';

export interface CommittedSceneSnapshot { planning: PlanningData; notes: Note[]; epoch: number; undoRevision: number }

/** Call only with two successfully committed snapshots. Settings/navigation never animate data. */
export function committedSceneChange(before: CommittedSceneSnapshot, after: CommittedSceneSnapshot): SceneEvent | null {
  if (before.epoch !== after.epoch) return null;
  const previousOperations = new Map(before.planning.operations.map(operation => [operation.id, operation]));
  const captureUndo = after.planning.operations.some(operation => operation.status === 'undone' && previousOperations.get(operation.id)?.status === 'applied');
  const undo = after.undoRevision > before.undoRevision || captureUndo;
  const event = (region: SceneRegion, item: string, action: SceneEvent['action']): SceneEvent => ({ kind: 'commit', region, item, action: undo ? 'restore' : action });
  const tasks = new Map(before.planning.tasks.map(task => [task.id, task]));
  for (const task of after.planning.tasks) {
    const prior = tasks.get(task.id);
    if (!prior) return event('tasks', task.id, 'add');
    if (prior === task) continue;
    if (prior.status !== task.status) return event('tasks', task.id, task.status === 'done' ? 'complete' : prior.status === 'done' ? 'restore' : 'update');
    const subtasks = new Map(prior.subtasks.flatMap(sub => [sub, ...(sub.children ?? [])]).map(sub => [sub.id, sub]));
    for (const sub of task.subtasks.flatMap(item => [item, ...(item.children ?? [])])) {
      const old = subtasks.get(sub.id);
      if (!old) return event('focus', sub.id, 'add');
      if (old.done !== sub.done) return event('focus', sub.id, sub.done ? 'complete' : 'restore');
    }
    if (task.updatedAt !== prior.updatedAt || task.title !== prior.title || task.description !== prior.description) return event('tasks', task.id, 'update');
  }
  const nextTaskIds = new Set(after.planning.tasks.map(task => task.id));
  const removedTask = before.planning.tasks.find(task => !nextTaskIds.has(task.id));
  if (removedTask) return event('tasks', removedTask.id, 'complete');
  for (const [region, previous, next] of [
    ['calendar', before.planning.appointments, after.planning.appointments],
    ['calendar', before.planning.timeBlocks, after.planning.timeBlocks],
    ['reminders', before.planning.reminders ?? [], after.planning.reminders ?? []],
    ['notes', before.notes, after.notes],
  ] as const) {
    const previousById = new Map<string, { id: string; updatedAt: string }>(previous.map(item => [item.id, item]));
    for (const item of next) {
      const old = previousById.get(item.id);
      if (!old) return event(region, item.id, 'add');
      if (region === 'notes' && 'deletedAt' in old && 'deletedAt' in item && old.deletedAt !== item.deletedAt) return event(region, item.id, item.deletedAt === null ? 'restore' : 'complete');
      if (old.updatedAt !== item.updatedAt) return event(region, item.id, 'update');
    }
    const ids = new Set(next.map(item => item.id));
    const removed = previous.find(item => !ids.has(item.id));
    if (removed) return event(region, removed.id, 'complete');
  }
  const receipts = new Map((before.planning.reminderReceipts ?? []).map(item => [item.id, item]));
  for (const item of after.planning.reminderReceipts ?? []) {
    const old = receipts.get(item.id);
    if (old?.status !== item.status) return event('reminders', item.id, item.status === 'pending' ? 'restore' : 'complete');
  }
  return null;
}
