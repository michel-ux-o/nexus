import type { WorkspaceBackup } from '../planning/types';
import { reminderOccurrenceId } from '../planning/reminders';
import { makeWorkspaceBackup } from './workspaceBackup';

function graphIds(workspace: WorkspaceBackup): string[] {
  const { planning } = workspace;
  return [
    ...workspace.notes.flatMap(note => [note.id, ...note.revisions.map(revision => revision.id)]),
    ...planning.tasks.flatMap(task => [task.id, ...task.subtasks.flatMap(subtask => [subtask.id, ...(subtask.children ?? []).map(child => child.id)])]),
    ...(planning.settings.morningRoutine?.days ?? []).flatMap(day => day.subtasks.flatMap(subtask => [subtask.id, ...(subtask.children ?? []).map(child => child.id)])),
    ...planning.appointments.map(item => item.id), ...planning.timeBlocks.map(item => item.id),
    ...planning.operations.flatMap(operation => [operation.id, ...operation.items.flatMap(item => [item.itemId, item.taskId, ...item.blockIds])]),
    ...(planning.taskRules ?? []).map(item => item.id),
    ...(planning.recurrenceReceipts ?? []).flatMap(item => [item.ruleId, item.taskId]),
    ...(planning.reminders ?? []).map(item => item.id),
    ...(planning.reminderReceipts ?? []).flatMap(item => [item.id, item.reminderId]),
    ...(planning.morningRoutineReceipts ?? []).map(item => item.taskId),
  ];
}

/** Remap first, including receipt tombstones, before assembling any relationships. */
export function mergeWorkspaces(current: WorkspaceBackup, incoming: WorkspaceBackup): WorkspaceBackup {
  const used = new Set(graphIds(current));
  const reserved = new Set([...used, ...graphIds(incoming)]);
  const allocate = (id: string, force = false): string => {
    if (!force && !used.has(id)) { used.add(id); return id; }
    if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') throw new Error('Für einen sicheren Import wird ein Browser mit Unterstützung für zufällige UUIDs benötigt.');
    let result: string;
    do { result = crypto.randomUUID(); } while (reserved.has(result));
    used.add(result);
    reserved.add(result);
    return result;
  };
  const mapping = (values: string[]) => new Map([...new Set(values)].map(id => [id, allocate(id)]));
  const noteIds = mapping(incoming.notes.map(note => note.id));
  const taskIds = mapping([
    ...incoming.planning.tasks.map(task => task.id),
    ...incoming.planning.operations.flatMap(operation => operation.items.map(item => item.taskId)),
    ...(incoming.planning.recurrenceReceipts ?? []).map(item => item.taskId),
    ...(incoming.planning.morningRoutineReceipts ?? []).map(item => item.taskId),
  ]);
  const blockIds = mapping([
    ...incoming.planning.timeBlocks.map(block => block.id),
    ...incoming.planning.operations.flatMap(operation => operation.items.flatMap(item => item.blockIds)),
  ]);
  const eventIds = mapping(incoming.planning.appointments.map(event => event.id));
  const operationIds = mapping(incoming.planning.operations.map(operation => operation.id));
  const ruleIds = mapping((incoming.planning.taskRules ?? []).map(rule => rule.id));
  const reminderIds = mapping([
    ...(incoming.planning.reminders ?? []).map(reminder => reminder.id),
    ...(incoming.planning.reminderReceipts ?? []).map(receipt => receipt.reminderId),
  ]);
  const receiptsByReminder = new Map<string, NonNullable<WorkspaceBackup['planning']['reminderReceipts']>>();
  for (const receipt of incoming.planning.reminderReceipts ?? []) {
    const receipts = receiptsByReminder.get(receipt.reminderId) ?? [];
    receipts.push(receipt);
    receiptsByReminder.set(receipt.reminderId, receipts);
  }
  // Receipt identity is derived from its reminder and instant. If an imported
  // derived ID collides with any existing primary ID, rekey the reminder too.
  for (const [originalId, initialId] of reminderIds) {
    const receipts = receiptsByReminder.get(originalId) ?? [];
    let nextId = initialId;
    while (receipts.some(item => used.has(reminderOccurrenceId(nextId, item.scheduledAt)))) nextId = allocate(originalId, true);
    reminderIds.set(originalId, nextId);
    for (const receipt of receipts) {
      const receiptId = reminderOccurrenceId(nextId, receipt.scheduledAt);
      used.add(receiptId);
      reserved.add(receiptId);
    }
  }
  const notes = incoming.notes.map(note => ({
    ...note, id: noteIds.get(note.id)!,
    revisions: note.revisions.map(revision => ({ ...revision, id: allocate(revision.id, noteIds.get(note.id) !== note.id) })),
  }));
  const existingRoutineDates = new Set((current.planning.morningRoutineReceipts ?? []).map(receipt => receipt.date));
  const tasks = incoming.planning.tasks.map(task => {
    const { morningRoutineDate, ...rest } = task;
    return {
      ...rest, id: taskIds.get(task.id)!, noteIds: task.noteIds.map(id => noteIds.get(id)!),
      ...(task.ruleId === undefined ? {} : { ruleId: ruleIds.get(task.ruleId)! }),
      // Keep the current day's receipt authoritative. Preserve the imported
      // content as an ordinary task rather than creating two daily routines.
      ...(morningRoutineDate === undefined || existingRoutineDates.has(morningRoutineDate) ? {} : { morningRoutineDate }),
      subtasks: task.subtasks.map(subtask => ({ ...subtask, id: allocate(subtask.id),
        ...(subtask.children === undefined ? {} : { children: subtask.children.map(child => ({ ...child, id: allocate(child.id) })) }),
      })),
    };
  });
  const timeBlocks = incoming.planning.timeBlocks.map(block => ({ ...block, id: blockIds.get(block.id)!, taskId: taskIds.get(block.taskId)! }));
  const appointments = incoming.planning.appointments.map(event => ({ ...event, id: eventIds.get(event.id)! }));
  const operations = incoming.planning.operations.map(operation => ({
    ...operation, id: operationIds.get(operation.id)!,
    items: operation.items.map(item => ({ ...item, itemId: allocate(item.itemId), taskId: taskIds.get(item.taskId)!, blockIds: item.blockIds.map(id => blockIds.get(id)!) })),
  }));
  const taskRules = (incoming.planning.taskRules ?? []).map(rule => ({
    ...rule, id: ruleIds.get(rule.id)!, template: { ...rule.template, noteIds: rule.template.noteIds.map(id => noteIds.get(id)!) },
  }));
  const recurrenceReceipts = (incoming.planning.recurrenceReceipts ?? []).map(receipt => ({ ...receipt, ruleId: ruleIds.get(receipt.ruleId)!, taskId: taskIds.get(receipt.taskId)! }));
  const reminders = (incoming.planning.reminders ?? []).map(reminder => ({
    ...reminder, id: reminderIds.get(reminder.id)!, taskId: reminder.taskId === null ? null : taskIds.get(reminder.taskId)!,
    appointmentId: reminder.appointmentId === null ? null : eventIds.get(reminder.appointmentId)!,
  }));
  const reminderReceipts = (incoming.planning.reminderReceipts ?? []).map(receipt => {
    const reminderId = reminderIds.get(receipt.reminderId)!;
    return { ...receipt, reminderId, id: reminderOccurrenceId(reminderId, receipt.scheduledAt) };
  });
  const morningRoutineReceipts = (incoming.planning.morningRoutineReceipts ?? [])
    .filter(receipt => !existingRoutineDates.has(receipt.date))
    .map(receipt => ({ ...receipt, taskId: taskIds.get(receipt.taskId)! }));
  const appendText = (existing: string, imported: string, heading: string): string => !imported ? existing
    : !existing ? imported : `${existing}\n\n— Importiert: ${heading} —\n${imported}`;
  const days = new Map(current.planning.days.map(day => [day.date, { ...day, priorityTaskIds: [...day.priorityTaskIds] }]));
  for (const incomingDay of incoming.planning.days) {
    const day = { ...incomingDay, priorityTaskIds: incomingDay.priorityTaskIds.map(id => taskIds.get(id)!) };
    const existing = days.get(day.date);
    days.set(day.date, existing ? {
      ...existing, priorityTaskIds: [...new Set([...existing.priorityTaskIds, ...day.priorityTaskIds])].slice(0, 3),
      note: appendText(existing.note, day.note, 'Tagesnotiz'), review: appendText(existing.review, day.review, 'Tagesrückblick'),
    } : day);
  }
  const weeks = new Map(current.planning.weeks.map(week => [week.weekStart, { ...week }]));
  for (const week of incoming.planning.weeks) {
    const existing = weeks.get(week.weekStart);
    weeks.set(week.weekStart, existing ? {
      ...existing, goals: appendText(existing.goals, week.goals, 'Wochenziele'), review: appendText(existing.review, week.review, 'Wochenrückblick'),
    } : week);
  }
  return makeWorkspaceBackup([...current.notes, ...notes], {
    tasks: [...current.planning.tasks, ...tasks], appointments: [...current.planning.appointments, ...appointments],
    timeBlocks: [...current.planning.timeBlocks, ...timeBlocks], operations: [...current.planning.operations, ...operations],
    taskRules: [...(current.planning.taskRules ?? []), ...taskRules], recurrenceReceipts: [...(current.planning.recurrenceReceipts ?? []), ...recurrenceReceipts],
    reminders: [...(current.planning.reminders ?? []), ...reminders], reminderReceipts: [...(current.planning.reminderReceipts ?? []), ...reminderReceipts],
    ...(current.planning.morningRoutineReceipts === undefined && incoming.planning.morningRoutineReceipts === undefined ? {} : {
      morningRoutineReceipts: [...(current.planning.morningRoutineReceipts ?? []), ...morningRoutineReceipts],
    }),
    days: [...days.values()], weeks: [...weeks.values()], settings: { ...current.planning.settings },
  });
}
