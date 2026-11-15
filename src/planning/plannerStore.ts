import { applyUndo, makeUndo } from './undoHistory';
import type { UndoEntry } from './undoHistory';
import { repository } from '../data/repository';
import { dateInZone, isTimeZone, localToInstant } from './dates';
import { tasksForDay } from './selectors';
import { moveTaskBlocks, samePlan } from './move';
import { materializeRecurring as recurringTasks } from './recurrence';
import { materializeMorningRoutine as morningTask, skipMorningRoutine as skipMorningTask } from './morningRoutine';
import { reminderOccurrenceId } from './reminders';
import { emptyPlanning } from './types';
import type { AppSettings, Appointment, CaptureCommit, CaptureOperation, CaptureResult, DayPlan, PlannerSnapshot, PlanningData, Reminder, ReminderOccurrence, ReminderReceipt, Task, TaskPlan, TaskRule, TaskSaveOptions, TaskStatus, TimeBlock, WeekPlan } from './types';
import { validateCaptureItem, validatePlanning, validatePlan, validateReminder, validateReminderReceipt } from './validation';

const AUTOSAVE_DELAY = 450;
function copy<T>(value: T): T { return structuredClone(value); }
function message(error: unknown): string { return error instanceof Error && error.message ? error.message : 'Die Planung konnte nicht gespeichert werden. Deine Eingaben bleiben erhalten.'; }
function replace<T>(items: T[], predicate: (item: T) => boolean, value: T): T[] {
  return items.some(predicate) ? items.map((item) => predicate(item) ? value : item) : [...items, value];
}
function pruneMovedPriorities(data: PlanningData, moved: Set<string>): PlanningData {
  return { ...data, days: data.days.map((day) => {
    if (!day.priorityTaskIds.some((id) => moved.has(id))) return day;
    const stillPlanned = new Set(tasksForDay(data, day.date).map((task) => task.id));
    return { ...day, priorityTaskIds: day.priorityTaskIds.filter((id) => !moved.has(id) || stillPlanned.has(id)) };
  }) };
}
function detachDeletedTargets(data: PlanningData, taskIds: Set<string>, appointmentIds: Set<string>, now: () => string): PlanningData {
  return { ...data, reminders: (data.reminders ?? []).map((reminder) => {
    if ((reminder.taskId !== null && taskIds.has(reminder.taskId)) || (reminder.appointmentId !== null && appointmentIds.has(reminder.appointmentId))) {
      return { ...reminder, taskId: null, appointmentId: null, enabled: false, updatedAt: now() };
    }
    return reminder;
  }) };
}

/** A single serialized write queue acknowledges only exact, committed revisions. */
export class PlannerStore {
  private data = emptyPlanning();
  private history: UndoEntry[] = [];
  private undoBusy = false;
  private undoPending = false;
  private undoRevision = 0;
  private undoError: string | null = null;
  private loaded = false;
  private started = false;
  private loading = true;
  private loadError: string | null = null;
  private error: string | null = null;
  private blocked = false;
  private epoch = 0;
  private revision = 0;
  private committedRevision = 0;
  private clock = 0;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private pendingJobs = 0;
  private snapshot: PlannerSnapshot = { data: this.data, loading: true, loadError: null, status: 'saving', error: null, undoRevision: 0, undoState: { canUndo: false, label: null, count: 0, busy: false, pending: false, error: null } };

  getSnapshot = (): PlannerSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  hasUnsavedChanges = (): boolean => this.revision !== this.committedRevision;
  start = (): void => { if (this.started) return; this.started = true; void this.reload().catch(() => undefined); };

  private publish(): void {
    this.snapshot = {
      data: this.data, loading: this.loading, loadError: this.loadError, error: this.error, undoRevision: this.undoRevision,
      undoState: { canUndo: !this.undoBusy && (this.undoPending || !!this.history.length && this.history[this.history.length - 1].revision <= this.committedRevision) && !this.blocked && !this.loading && !this.loadError && (this.undoPending || !this.hasUnsavedChanges()), label: this.history.at(-1)?.label ?? null, count: this.history.filter((entry) => entry.revision <= this.committedRevision).length, busy: this.undoBusy, pending: this.undoPending, error: this.undoError },
      status: this.pendingJobs > 0 || this.loading ? 'saving'
        : this.error || this.loadError ? 'error' : this.hasUnsavedChanges() || !this.loaded ? 'saving' : 'saved',
    };
    for (const listener of this.listeners) listener();
  }
  private cancelTimer(): void { if (this.timer !== null) clearTimeout(this.timer); this.timer = null; }
  private scheduleSave(): void {
    this.cancelTimer();
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, AUTOSAVE_DELAY);
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.pendingJobs++; this.publish();
    const result = this.queue.then(operation).finally(() => { this.pendingJobs--; this.publish(); });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
  private assertMutable(): void {
    if (this.undoPending || this.undoBusy) throw new Error('Bitte schließe zuerst das Rückgängigmachen ab.');
    if (this.blocked) throw new Error('Die Planung ist während des Imports gesperrt. Bitte warte auf das erneute Laden.');
    if (!this.loaded || this.loading || this.loadError) throw new Error('Die Planung muss zuerst erfolgreich geladen werden. Deine gespeicherten Daten werden nicht überschrieben.');
  }
  /** Monotonic even when two edits occur in one millisecond, for reliable undo guards. */
  private now(previous?: string): string {
    const previousTime = previous ? Date.parse(previous) : 0;
    this.clock = Math.max(Date.now(), this.clock + 1, Number.isFinite(previousTime) ? previousTime + 1 : 0);
    return new Date(this.clock).toISOString();
  }
  private setData(data: PlanningData, debounce: boolean): void {
    validatePlanning(data);
    this.data = copy(data); this.revision++; this.publish();
    if (debounce) this.scheduleSave();
  }
  private change(updater: (data: PlanningData) => PlanningData, debounce = false): void {
    this.assertMutable();
    this.setData(updater(copy(this.data)), debounce);
  }
  private async persist(epoch: number): Promise<boolean> {
    let attempted = -1;
    while (epoch === this.epoch && this.hasUnsavedChanges() && this.revision !== attempted) {
      if (!this.loaded || this.loadError) return false;
      const revision = this.revision;
      const data = copy(this.data);
      attempted = revision;
      try {
        await repository.putPlanning(data);
        if (epoch !== this.epoch) return false;
        this.committedRevision = revision;
        this.error = null;
      } catch (error) {
        if (epoch !== this.epoch) return false;
        this.error = message(error);
      }
      this.publish();
    }
    return epoch === this.epoch && this.loaded && !this.loadError && !this.hasUnsavedChanges();
  }
  flush = (): Promise<boolean> => {
    this.cancelTimer(); const epoch = this.epoch;
    return this.enqueue(async () => {
      const saved = await this.persist(epoch);
      if (saved && this.undoPending) {
        this.history.pop(); this.undoPending = false; this.undoError = null;
        // Confirm the inverse write here so direct Undo and every retry path
        // acknowledge it exactly once. Clearing history never increments this.
        this.undoRevision++; this.publish();
      }
      return saved;
    });
  };
  retry = async (): Promise<boolean> => { if (this.undoPending) { try { await this.undo(); return true; } catch { return false; } } return this.flush(); };
  private async requireSaved(epoch: number): Promise<void> {
    if (!await this.flush() || epoch !== this.epoch) throw new Error(this.error ?? 'Die Planung konnte noch nicht vollständig gespeichert werden. Deine Eingaben bleiben erhalten; bitte erneut versuchen.');
  }
  private async commit(updater: (data: PlanningData) => PlanningData, label?: string): Promise<void> {
    const epoch = this.epoch;
    const before = copy(this.data);
    this.change(updater);
    if (label) this.record(before, label);
    await this.requireSaved(epoch);
  }

  private record(before: PlanningData, label: string): void {
    const entry = makeUndo(before, this.data, label, this.revision);
    if (entry) { this.history.push(entry); if (this.history.length > 20) this.history.shift(); this.undoError = null; this.publish(); }
  }
  private clearHistory(): void { this.history = []; this.undoPending = false; this.undoError = null; }
  undo = async (): Promise<void> => {
    if (this.undoBusy) return;
    if (this.blocked || this.loading || !this.loaded) throw new Error('Die Planung ist derzeit nicht verfügbar.');
    const entry = this.history.at(-1);
    if (!entry || (!this.undoPending && entry.revision > this.committedRevision)) return;
    this.undoBusy = true; this.undoError = null; this.publish();
    try {
      if (!this.undoPending) {
        const next = applyUndo(this.data, entry, (previous) => this.now(previous));
        validatePlanning(next);
        this.setData(next, false);
        this.undoPending = true;
      }
      await this.requireSaved(this.epoch);
    } catch (error) {
      this.undoError = message(error);
      throw error;
    } finally { this.undoBusy = false; this.publish(); }
  };

  update = (updater: (data: PlanningData) => PlanningData, options?: { recordUndo?: boolean }): void => {
    this.assertMutable();
    if (options?.recordUndo === false) { this.clearHistory(); this.publish(); }
    const before = copy(this.data);
    this.change((previous) => {
      const next = copy(updater(previous));
      // Generic accepted AI edits follow the same rescheduling rule as forms.
      const changed = new Set(next.tasks.filter((task) => {
        const old = this.data.tasks.find((item) => item.id === task.id);
        return old && !samePlan(old.plan, task.plan);
      }).map((task) => task.id));
      for (const taskId of changed) {
        const old = this.data.tasks.find((task) => task.id === taskId)!;
        const target = next.tasks.find((task) => task.id === taskId)!;
        const unchanged = new Set(next.timeBlocks.filter((block) => block.taskId === taskId && this.data.timeBlocks.some((item) => item.id === block.id && item.taskId === taskId && item.startAt === block.startAt)).map((block) => block.id));
        const shifted = new Map(moveTaskBlocks(this.data, taskId, old.plan, target.plan, unchanged).map((block) => [block.id, block]));
        next.timeBlocks = next.timeBlocks.flatMap((block) => {
          if (block.taskId !== taskId) return [block];
          const previousBlock = this.data.timeBlocks.find((item) => item.id === block.id);
          if (!previousBlock) return [block];
          const moved = shifted.get(block.id);
          if (!moved) return [];
          // An explicit block edit already supplies its target instant.
          return [block.startAt === previousBlock.startAt ? { ...block, startAt: moved.startAt } : block];
        });
      }
      const newBlockDates = new Set(next.timeBlocks.filter((block) => {
        const old = this.data.timeBlocks.find((item) => item.id === block.id);
        return !old || old.taskId !== block.taskId || dateInZone(old.startAt, next.settings.timeZone) !== dateInZone(block.startAt, next.settings.timeZone);
      }).map((block) => block.taskId));
      for (const taskId of newBlockDates) {
        if (changed.has(taskId)) continue;
        const blocks = next.timeBlocks.filter((block) => block.taskId === taskId);
        const first = blocks.reduce((earliest, block) => Date.parse(block.startAt) < Date.parse(earliest.startAt) ? block : earliest);
        next.tasks = next.tasks.map((task) => task.id === taskId ? { ...task, plan: { kind: 'day', date: dateInZone(first.startAt, next.settings.timeZone) } } : task);
        changed.add(taskId);
      }
      // An updater must not make later edits invisible to capture undo detection.
      next.tasks = next.tasks.map((task) => {
        const old = this.data.tasks.find((item) => item.id === task.id);
        return old && JSON.stringify(old) !== JSON.stringify(task) ? { ...task, updatedAt: this.now(old.updatedAt) } : task;
      });
      next.timeBlocks = next.timeBlocks.map((block) => {
        const old = this.data.timeBlocks.find((item) => item.id === block.id);
        return old && JSON.stringify(old) !== JSON.stringify(block) ? { ...block, updatedAt: this.now(old.updatedAt) } : block;
      });
      for (const old of this.data.timeBlocks) {
        const block = next.timeBlocks.find((item) => item.id === old.id);
        if (!block || JSON.stringify(block) !== JSON.stringify(old)) changed.add(old.taskId);
      }
      const removedTasks = new Set(this.data.tasks.filter((old) => !next.tasks.some((task) => task.id === old.id)).map((task) => task.id));
      const removedAppointments = new Set(this.data.appointments.filter((old) => !next.appointments.some((item) => item.id === old.id)).map((item) => item.id));
      return detachDeletedTargets(pruneMovedPriorities(next, changed), removedTasks, removedAppointments, () => this.now());
    }, true);
    if (options?.recordUndo !== false) this.record(before, 'KI-Änderung');
  };

  saveTask = async (input: Task, inputOptions?: TaskSaveOptions): Promise<void> => {
    const task = copy(input); const options = copy(inputOptions);
    await this.commit((data) => {
      const old = data.tasks.find((item) => item.id === task.id);
      const next = { ...task, ...(old?.ruleId ? { ruleId: old.ruleId, occurrenceDate: old.occurrenceDate } : {}), ...(old?.morningRoutineDate ? { morningRoutineDate: old.morningRoutineDate } : {}), createdAt: old?.createdAt ?? task.createdAt, updatedAt: this.now(old?.updatedAt ?? task.updatedAt) };
      let rules = data.taskRules ?? []; let receipts = data.recurrenceReceipts ?? [];
      if (options?.rule === null && old?.ruleId) rules = rules.map((rule) => rule.id === old.ruleId ? { ...rule, paused: true, updatedAt: this.now(rule.updatedAt) } : rule);
      if (options?.rule) {
        const rule = options.rule; const previousRule = rules.find((item) => item.id === rule.id);
        if (old?.ruleId && old.ruleId !== rule.id) throw new Error('Bitte bearbeite die bestehende Wiederholungsregel. Ein vorhandenes Vorkommen kann nicht einer anderen Regel zugewiesen werden.');
        const date = next.ruleId === rule.id ? next.occurrenceDate : next.plan?.kind === 'day' ? next.plan.date : undefined;
        if (!date || (!previousRule && date !== rule.startDate)) throw new Error('Bitte wähle einen konkreten Planungstag als Beginn der neuen Wiederholung.');
        next.ruleId = rule.id; next.occurrenceDate = date;
        const existingReceipt = receipts.find((receipt) => receipt.ruleId === rule.id && receipt.date === date);
        if (existingReceipt && existingReceipt.taskId !== task.id) throw new Error('Für diesen Regeltermin besteht bereits eine Aufgabe oder ein dauerhafter Löschbeleg.');
        rules = replace(rules, (item) => item.id === rule.id, { ...rule, createdAt: previousRule?.createdAt ?? rule.createdAt, updatedAt: this.now(previousRule?.updatedAt ?? rule.updatedAt) });
        if (!existingReceipt) receipts = [...receipts, { ruleId: rule.id, date, taskId: next.id }];
      }
      let reminders = data.reminders ?? [];
      if (options?.reminder === null) reminders = reminders.filter((reminder) => reminder.taskId !== task.id);
      if (options?.reminder) {
        const reminder = { ...options.reminder, taskId: task.id, appointmentId: null };
        const previousReminder = reminders.find((item) => item.id === reminder.id);
        validateReminder(reminder, !previousReminder || previousReminder.localStart !== reminder.localStart || previousReminder.timeZone !== reminder.timeZone);
        reminders = replace(reminders, (item) => item.id === reminder.id, { ...reminder, createdAt: previousReminder?.createdAt ?? reminder.createdAt, updatedAt: this.now(previousReminder?.updatedAt ?? reminder.updatedAt) });
      }
      const timeBlocks = old ? moveTaskBlocks(data, task.id, old.plan, next.plan).map((block) => {
        const previousBlock = data.timeBlocks.find((item) => item.id === block.id);
        return previousBlock && previousBlock.startAt !== block.startAt ? { ...block, updatedAt: this.now(previousBlock.updatedAt) } : block;
      }) : data.timeBlocks;
      const result = { ...data, tasks: replace(data.tasks, (item) => item.id === next.id, next), timeBlocks, taskRules: rules, recurrenceReceipts: receipts, reminders };
      return old && !samePlan(old.plan, next.plan) ? pruneMovedPriorities(result, new Set([task.id])) : result;
    }, 'Aufgabe speichern');
  };
  deleteTask = async (id: string): Promise<void> => {
    await this.commit((data) => detachDeletedTargets({ ...data, tasks: data.tasks.filter((task) => task.id !== id),
      timeBlocks: data.timeBlocks.filter((block) => block.taskId !== id),
      days: data.days.map((day) => ({ ...day, priorityTaskIds: day.priorityTaskIds.filter((taskId) => taskId !== id) })) }, new Set([id]), new Set(), () => this.now()), 'Aufgabe löschen');
  };
  setTaskStatus = async (id: string, status: TaskStatus): Promise<void> => {
    await this.commit((data) => {
      if (!data.tasks.some((task) => task.id === id)) throw new Error('Diese Aufgabe ist nicht mehr vorhanden.');
      return { ...data, tasks: data.tasks.map((task) => task.id === id ? { ...task, status, updatedAt: this.now(task.updatedAt) } : task) };
    }, 'Aufgabenstatus ändern');
  };
  moveTask = async (id: string, plan: TaskPlan): Promise<void> => {
    validatePlan(plan); const target = copy(plan);
    await this.commit((data) => {
      const task = data.tasks.find((item) => item.id === id);
      if (!task) throw new Error('Diese Aufgabe ist nicht mehr vorhanden.');
      const timeBlocks = moveTaskBlocks(data, id, task.plan, target).map((block) => {
        const old = data.timeBlocks.find((item) => item.id === block.id);
        return old && old.startAt !== block.startAt ? { ...block, updatedAt: this.now(old.updatedAt) } : block;
      });
      return pruneMovedPriorities({ ...data, tasks: data.tasks.map((item) => item.id === id ? { ...item, plan: target, updatedAt: this.now(item.updatedAt) } : item), timeBlocks }, new Set([id]));
    }, 'Aufgabe verschieben');
  };
  saveAppointment = async (input: Appointment): Promise<void> => {
    const appointment = copy(input);
    await this.commit((data) => {
      const old = data.appointments.find((item) => item.id === appointment.id);
      return { ...data, appointments: replace(data.appointments, (item) => item.id === appointment.id,
        { ...appointment, createdAt: old?.createdAt ?? appointment.createdAt, updatedAt: this.now(old?.updatedAt ?? appointment.updatedAt) }) };
    }, 'Termin speichern');
  };
  deleteAppointment = async (id: string): Promise<void> => { await this.commit((data) => detachDeletedTargets({ ...data, appointments: data.appointments.filter((item) => item.id !== id) }, new Set(), new Set([id]), () => this.now()), 'Termin löschen'); };
  saveTimeBlock = async (input: TimeBlock): Promise<void> => {
    const block = copy(input);
    await this.commit((data) => {
      const task = data.tasks.find((item) => item.id === block.taskId);
      if (!task) throw new Error('Bitte wähle eine vorhandene Aufgabe für den Zeitblock.');
      const old = data.timeBlocks.find((item) => item.id === block.id);
      const now = this.now(old?.updatedAt);
      const timeBlocks = replace(data.timeBlocks, (item) => item.id === block.id, { ...block, createdAt: old?.createdAt ?? block.createdAt, updatedAt: now });
      const first = timeBlocks.filter((item) => item.taskId === task.id).reduce((earliest, item) => Date.parse(item.startAt) < Date.parse(earliest.startAt) ? item : earliest);
      const day = dateInZone(first.startAt, data.settings.timeZone);
      const dateChanged = !old || old.taskId !== block.taskId || dateInZone(old.startAt, data.settings.timeZone) !== dateInZone(block.startAt, data.settings.timeZone);
      return pruneMovedPriorities({ ...data, tasks: data.tasks.map((item) => item.id === task.id ? { ...item, plan: dateChanged ? { kind: 'day', date: day } : item.plan, updatedAt: this.now(item.updatedAt) } : item),
        timeBlocks }, new Set([task.id, ...(old ? [old.taskId] : [])]));
    }, 'Zeitblock speichern');
  };
  deleteTimeBlock = async (id: string): Promise<void> => {
    await this.commit((data) => {
      const block = data.timeBlocks.find((item) => item.id === id);
      return pruneMovedPriorities({ ...data, timeBlocks: data.timeBlocks.filter((item) => item.id !== id) }, new Set(block ? [block.taskId] : []));
    }, 'Zeitblock löschen');
  };
  updateDay = (input: DayPlan): void => { const day = copy(input); const before = copy(this.data); this.change((data) => ({ ...data, days: replace(data.days, (item) => item.date === day.date, day) }), true); this.record(before, 'Tagesprioritäten ändern'); };
  updateWeek = (input: WeekPlan): void => { const week = copy(input); this.change((data) => ({ ...data, weeks: replace(data.weeks, (item) => item.weekStart === week.weekStart, week) }), true); };
  updateSettings = (input: Partial<AppSettings>): void => { const settings = copy(input); this.change((data) => ({ ...data, settings: { ...data.settings, ...settings } }), true); };

  saveTaskRule = async (input: TaskRule): Promise<void> => {
    const rule = copy(input);
    await this.commit((data) => {
      const old = (data.taskRules ?? []).find((item) => item.id === rule.id);
      return { ...data, taskRules: replace(data.taskRules ?? [], (item) => item.id === rule.id,
        { ...rule, createdAt: old?.createdAt ?? rule.createdAt, updatedAt: this.now(old?.updatedAt ?? rule.updatedAt) }) };
    }, 'Wiederholung speichern');
  };
  materializeRecurring = async (from: string, to: string): Promise<void> => {
    this.assertMutable();
    const now = new Date();
    const next = recurringTasks(this.data, from, to, now);
    if (next === this.data) { await this.requireSaved(this.epoch); return; }
    await this.commit((data) => recurringTasks(data, from, to, now));
  };
  materializeMorningRoutine = async (date: string): Promise<void> => {
    this.assertMutable();
    const next = morningTask(this.data, date);
    if (next === this.data) { await this.requireSaved(this.epoch); return; }
    // Preparing a daily instance is a system action, not an undoable user edit.
    // The receipt and complete task always enter the same persisted snapshot.
    await this.commit(() => next);
  };
  skipMorningRoutine = async (date: string): Promise<void> => {
    this.assertMutable();
    const next = skipMorningTask(this.data, date);
    if (next === this.data) { await this.requireSaved(this.epoch); return; }
    await this.commit(() => next, 'Morgenroutine heute überspringen');
  };
  saveReminder = async (input: Reminder): Promise<void> => {
    const reminder = copy(input);
    await this.commit((data) => {
      const old = (data.reminders ?? []).find((item) => item.id === reminder.id);
      validateReminder(reminder, !old || old.localStart !== reminder.localStart || old.timeZone !== reminder.timeZone);
      return { ...data, reminders: replace(data.reminders ?? [], (item) => item.id === reminder.id,
        { ...reminder, createdAt: old?.createdAt ?? reminder.createdAt, updatedAt: this.now(old?.updatedAt ?? reminder.updatedAt) }) };
    }, 'Erinnerung speichern');
  };
  deleteReminder = async (id: string): Promise<void> => {
    // Receipt tombstones also survive deleting and recreating the same rule identifier.
    await this.commit((data) => ({ ...data, reminders: (data.reminders ?? []).filter((reminder) => reminder.id !== id) }), 'Erinnerung löschen');
  };
  private occurrenceReceipt(data: PlanningData, input: ReminderOccurrence): ReminderReceipt {
    if (!(data.reminders ?? []).some((reminder) => reminder.id === input.reminder.id)) throw new Error('Diese Erinnerung ist nicht mehr vorhanden.');
    const scheduledAt = new Date(input.scheduledAt).toISOString();
    const id = reminderOccurrenceId(input.reminder.id, scheduledAt);
    if (input.id !== id) throw new Error('Dieses Erinnerungsvorkommen besitzt keine gültige stabile Kennung.');
    const old = (data.reminderReceipts ?? []).find((receipt) => receipt.reminderId === input.reminder.id && Date.parse(receipt.scheduledAt) === Date.parse(scheduledAt));
    return old ?? { id, reminderId: input.reminder.id, scheduledAt, status: 'pending', snoozedUntil: null, notifiedAt: null };
  }
  acknowledgeReminder = async (input: ReminderOccurrence, status: 'done' | 'dismissed' | 'pending', snoozedUntil?: string | null): Promise<void> => {
    const occurrence = copy(input);
    await this.commit((data) => {
      const old = this.occurrenceReceipt(data, occurrence);
      const snooze = status !== 'pending' ? null : snoozedUntil === undefined ? old.snoozedUntil : snoozedUntil;
      const next = { ...old, status, snoozedUntil: snooze, notifiedAt: status === 'pending' && (old.status !== 'pending' || snooze !== old.snoozedUntil) ? null : old.notifiedAt };
      validateReminderReceipt(next);
      return { ...data, reminderReceipts: replace(data.reminderReceipts ?? [], (receipt) => receipt.id === next.id, next) };
    }, 'Erinnerung bearbeiten');
  };
  markReminderNotified = async (input: ReminderOccurrence): Promise<void> => {
    const occurrence = copy(input);
    this.assertMutable();
    const existing = this.occurrenceReceipt(this.data, occurrence);
    if (existing.notifiedAt || existing.status !== 'pending' || (existing.snoozedUntil ?? existing.scheduledAt) !== occurrence.effectiveAt) {
      await this.requireSaved(this.epoch); return;
    }
    await this.commit((data) => {
      const receipt = this.occurrenceReceipt(data, occurrence);
      const next = { ...receipt, notifiedAt: receipt.notifiedAt ?? this.now() };
      return { ...data, reminderReceipts: replace(data.reminderReceipts ?? [], (item) => item.id === receipt.id, next) };
    });
  };

  commitCapture = async (input: CaptureCommit): Promise<CaptureResult> => {
    this.assertMutable();
    this.clearHistory(); this.publish();
    const capture = copy(input);
    const epoch = this.epoch;
    if (!capture.operationId.trim() || capture.context.operationId !== capture.operationId || !isTimeZone(capture.context.timeZone)
      || !Number.isFinite(Date.parse(capture.context.capturedAt))) throw new Error('Der zeitliche Bezug der Erfassung ist ungültig. Bitte beginne eine neue Erfassung.');
    const operation = this.data.operations.find((item) => item.id === capture.operationId);
    if (operation?.status === 'undone') throw new Error('Diese Erfassung wurde bereits rückgängig gemacht. Beginne für neue Aufgaben eine neue Erfassung.');
    if (new Set(capture.items.map((item) => item.itemId)).size !== capture.items.length) throw new Error('Eine Erfassungskennung kommt mehrfach vor. Bitte prüfe die Vorschau.');
    const existing = new Map(operation?.items.map((receipt) => [receipt.itemId, receipt]) ?? []);
    const pending = capture.items.filter((item) => !existing.has(item.itemId));
    for (const item of capture.items) {
      const questions = validateCaptureItem(item, capture.context.timeZone);
      if (questions.length) throw new Error(questions.join(' '));
    }
    const taskIds = capture.items.filter((item) => existing.has(item.itemId)).map((item) => existing.get(item.itemId)!.taskId);
    const skippedItemIds = capture.items.filter((item) => existing.has(item.itemId)).map((item) => item.itemId);
    if (pending.length) {
      const now = this.now(operation?.updatedAt ?? capture.context.capturedAt);
      const tasks: Task[] = [];
      const blocks: TimeBlock[] = [];
      const receipts = pending.map((item) => {
        const taskId = crypto.randomUUID();
        const suggestions = item.suggestions.map((suggestion) => `Vorschlag: ${suggestion}`);
        tasks.push({ id: taskId, title: item.title.trim(), description: [item.description, ...suggestions].filter(Boolean).join('\n\n'),
          status: 'open', priority: item.priority, estimatedMinutes: item.estimatedMinutes, dueDate: item.dueDate,
          plan: item.plannedDate ? { kind: 'day', date: item.plannedDate } : item.plannedWeek ? { kind: 'week', weekStart: item.plannedWeek } : null,
          subtasks: [], noteIds: [...new Set(capture.noteIds ?? [])], createdAt: now, updatedAt: now });
        const blockIds: string[] = [];
        if (item.startTime !== null && item.plannedDate !== null && item.durationMinutes !== null) {
          const id = crypto.randomUUID(); blockIds.push(id);
          blocks.push({ id, taskId, startAt: localToInstant(item.plannedDate, item.startTime, capture.context.timeZone), durationMinutes: item.durationMinutes, createdAt: now, updatedAt: now });
        }
        taskIds.push(taskId);
        return { itemId: item.itemId, taskId, appliedUpdatedAt: now, blockIds };
      });
      const nextOperation: CaptureOperation = { id: capture.operationId, createdAt: operation?.createdAt ?? new Date(capture.context.capturedAt).toISOString(), updatedAt: now, status: 'applied', items: [...(operation?.items ?? []), ...receipts] };
      this.change((data) => ({ ...data, tasks: [...data.tasks, ...tasks], timeBlocks: [...data.timeBlocks, ...blocks],
        operations: replace(data.operations, (item) => item.id === capture.operationId, nextOperation) }));
    }
    // Also retry an already prepared, failed draft; receipts are not an early success acknowledgement.
    await this.requireSaved(epoch);
    return { taskIds, skippedItemIds };
  };

  undoCapture = async (operationId: string, force = false): Promise<void> => {
    this.assertMutable();
    this.clearHistory(); this.publish();
    const operation = this.data.operations.find((item) => item.id === operationId);
    if (!operation) throw new Error('Diese Erfassung ist nicht mehr vorhanden.');
    if (operation.status === 'undone') { await this.requireSaved(this.epoch); return; }
    if (!force) {
      for (const receipt of operation.items) {
        const task = this.data.tasks.find((item) => item.id === receipt.taskId);
        const blocks = this.data.timeBlocks.filter((block) => block.taskId === receipt.taskId);
        if ((task && task.updatedAt !== receipt.appliedUpdatedAt)
          || blocks.some((block) => !receipt.blockIds.includes(block.id) || block.updatedAt !== receipt.appliedUpdatedAt)
          || (task && receipt.blockIds.some((id) => !blocks.some((block) => block.id === id)))) {
          throw new Error('Seit der Erfassung wurden Aufgaben oder Zeitblöcke verändert. Beim Rückgängigmachen gehen diese späteren Änderungen verloren. Bitte bestätige das ausdrücklich.');
        }
      }
    }
    const taskIds = new Set(operation.items.map((item) => item.taskId));
    await this.commit((data) => detachDeletedTargets({ ...data, tasks: data.tasks.filter((task) => !taskIds.has(task.id)),
      timeBlocks: data.timeBlocks.filter((block) => !taskIds.has(block.taskId)),
      days: data.days.map((day) => ({ ...day, priorityTaskIds: day.priorityTaskIds.filter((id) => !taskIds.has(id)) })),
      operations: data.operations.map((item) => item.id === operationId ? { ...item, status: 'undone', updatedAt: this.now(item.updatedAt) } : item) }, taskIds, new Set(), () => this.now()));
  };

  setBlocked = (blocked: boolean): void => { this.blocked = blocked; if (blocked) this.clearHistory(); this.publish(); };
  /** Imports flush first. Epoch changes invalidate every queued stale write and callback. */
  reload = (): Promise<void> => {
    this.clearHistory(); this.cancelTimer(); const epoch = ++this.epoch;
    this.loading = true; this.loadError = null; this.publish();
    return this.enqueue(async () => {
      try {
        const stored = copy(await repository.getPlanning());
        if (epoch !== this.epoch) return;
        validatePlanning(stored);
        this.data = stored; this.revision++; this.committedRevision = this.revision;
        this.loaded = true; this.loading = false; this.loadError = null; this.error = null; this.publish();
      } catch (error) {
        if (epoch !== this.epoch) return;
        this.loading = false; this.loadError = message(error); this.publish();
        throw new Error(this.loadError);
      }
    });
  };
}
