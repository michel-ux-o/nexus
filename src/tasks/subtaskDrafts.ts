import type { Planner, Task } from '../planning/types';

export interface SubtaskDraft { id: string; title: string }
type Drafts = Readonly<Record<string, SubtaskDraft>>;

/** Keep unfinished inputs when the task view unmounts, scoped to its planner. */
class SubtaskDraftStore {
  private drafts: Drafts = Object.create(null);
  private listeners = new Set<() => void>();

  getSnapshot = (): Drafts => this.drafts;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(drafts: Drafts): void {
    this.drafts = Object.assign(Object.create(null), drafts);
    for (const listener of this.listeners) listener();
  }
  start(taskId: string): void {
    if (!this.drafts[taskId]) this.publish({ ...this.drafts, [taskId]: { id: crypto.randomUUID(), title: '' } });
  }
  setTitle(taskId: string, title: string): void {
    const draft = this.drafts[taskId];
    if (draft) this.publish({ ...this.drafts, [taskId]: { ...draft, title } });
  }
  discard(taskId: string, saved?: SubtaskDraft): void {
    // A save finishing after a view switch must not erase newer input.
    if (saved && this.drafts[taskId] !== saved) return;
    const drafts = { ...this.drafts };
    delete drafts[taskId];
    this.publish(drafts);
  }
}

const stores = new WeakMap<Planner['saveTask'], { epoch: number; store: SubtaskDraftStore }>();
export function getSubtaskDraftStore(saveTask: Planner['saveTask'], workspaceEpoch = 0): SubtaskDraftStore {
  let entry = stores.get(saveTask);
  if (!entry || entry.epoch !== workspaceEpoch) {
    entry = { epoch: workspaceEpoch, store: new SubtaskDraftStore() };
    stores.set(saveTask, entry);
  }
  return entry.store;
}

export async function saveSubtaskDraft(target: Task, input: SubtaskDraft, saveTask: Planner['saveTask']): Promise<void> {
  if (!input.title.trim()) return;
  // A failed planner write keeps its optimistic change. Reuse the ID on retry.
  const existing = target.subtasks.find(item => item.id === input.id);
  const subtask = { ...structuredClone(existing), id: input.id, title: input.title.trim(), done: existing?.done ?? false, suggestion: existing?.suggestion ?? false };
  const subtasks = existing ? target.subtasks.map(item => item.id === input.id ? subtask : item) : [...target.subtasks, subtask];
  await saveTask({ ...target, subtasks });
}

export async function focusTaskWithDraft(planner: Pick<Planner, 'saveTask' | 'flush'>, target: Task, onFocusTask: (id: string) => void, store = getSubtaskDraftStore(planner.saveTask)): Promise<void> {
  const draft = store.getSnapshot()[target.id];
  if (draft?.title.trim()) await saveSubtaskDraft(target, draft, planner.saveTask);
  if (!await planner.flush()) throw new Error('Bitte speichere zuerst die ausstehenden Änderungen.');
  if (stores.get(planner.saveTask)?.store !== store) throw new Error('Der Arbeitsbereich wurde neu geladen. Bitte wähle die Aufgabe erneut.');
  if (draft?.title.trim()) store.discard(target.id, draft);
  onFocusTask(target.id);
}
