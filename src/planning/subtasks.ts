import type { Subtask, SubtaskChild, SubtaskTemplate } from './types';

export type SubtaskState = 'checked' | 'mixed' | 'unchecked';
export interface SubtaskProgress { done: number; total: number }

/** A group contributes its executable children, never an extra completed step. */
export function subtaskProgress(subtasks: readonly Subtask[]): SubtaskProgress {
  let done = 0;
  let total = 0;
  for (const subtask of subtasks) {
    const leaves = subtask.children?.length ? subtask.children : [subtask];
    total += leaves.length;
    done += leaves.filter((leaf) => leaf.done).length;
  }
  return { done, total };
}

export function subtaskState(subtask: Subtask): SubtaskState {
  const { done, total } = subtaskProgress([subtask]);
  return done === total ? 'checked' : done === 0 ? 'unchecked' : 'mixed';
}

/** A parent checkbox controls its children; checking a child updates its group. */
export function setSubtaskDone(subtasks: readonly Subtask[], targetId: string, done: boolean): Subtask[] {
  return subtasks.map((subtask) => {
    if (subtask.id === targetId) {
      return {
        ...subtask, done,
        ...(subtask.children ? { children: subtask.children.map((child) => ({ ...child, done })) } : {}),
      };
    }
    if (!subtask.children?.some((child) => child.id === targetId)) return subtask;
    const children = subtask.children.map((child) => child.id === targetId ? { ...child, done } : child);
    return { ...subtask, children, done: children.every((child) => child.done) };
  });
}

/** Duplicate an instance or template with entirely new IDs on both supported levels. */
export function cloneSubtasks(
  subtasks: readonly (Subtask | SubtaskTemplate)[],
  resetDone = false,
  createId: () => string = () => crypto.randomUUID(),
): Subtask[] {
  return subtasks.map((subtask) => {
    const children: SubtaskChild[] | undefined = subtask.children?.map((child) => ({
      id: createId(), title: child.title, suggestion: child.suggestion,
      done: !resetDone && 'done' in child ? child.done : false,
    }));
    return {
      id: createId(), title: subtask.title, suggestion: subtask.suggestion,
      done: children?.length ? children.every((child) => child.done) : !resetDone && 'done' in subtask ? subtask.done : false,
      ...(children ? { children } : {}),
    };
  });
}
