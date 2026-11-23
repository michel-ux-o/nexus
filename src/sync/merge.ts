import { parseWorkspaceBackup } from '../data/workspaceBackup';
import { DEFAULT_MORNING_ROUTINE, DEFAULT_SETTINGS } from '../planning/types';
import type { AppSettings, CapacitySettings, MorningRoutineSettings, PlanningData, WorkspaceBackup } from '../planning/types';

export interface WorkspaceMergeConflict {
  path: string;
  label: string;
  /** An absent entity or optional setting is represented by null. */
  local: unknown;
  remote: unknown;
  base: unknown;
}

export interface WorkspaceMergeResult {
  /** Never return a partly merged workspace when any conflict remains. */
  workspace: WorkspaceBackup | null;
  conflicts: WorkspaceMergeConflict[];
}

function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

function orderedObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderedObject);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compare(left, right)).map(([key, entry]) => [key, orderedObject(entry)]));
  }
  return value;
}

function contentString(value: unknown): string { return JSON.stringify(orderedObject(value)) ?? 'undefined'; }
function equal(left: unknown, right: unknown): boolean { return contentString(left) === contentString(right); }
function byKey<T>(items: readonly T[] | undefined, key: (item: T) => string): T[] {
  return [...(items ?? [])].sort((left, right) => compare(key(left), key(right)));
}
const entityId = (item: { id: string }): string => item.id;
const calendarDate = (item: { date: string }): string => item.date;
const weekday = (item: { weekday: number }): string => String(item.weekday);
const recurrenceKey = (item: { ruleId: string; date: string }): string => JSON.stringify([item.ruleId, item.date]);
const LOCAL_SYNC_PREFERENCES = new Set<keyof AppSettings>(['lastView', 'notifications', 'exportHistory', 'aiConsent']);

/**
 * Navigation and export history belong to this installation. Notification
 * permission and AI consent must also be granted independently on each device.
 * Apply this to direct cloud restores as well as ordinary three-way merges.
 */
export function withLocalSyncPreferences(incoming: WorkspaceBackup, local: WorkspaceBackup): WorkspaceBackup {
  const result = structuredClone(incoming);
  result.planning.settings = {
    ...result.planning.settings,
    lastView: local.planning.settings.lastView,
    notifications: local.planning.settings.notifications ?? DEFAULT_SETTINGS.notifications,
    exportHistory: [...(local.planning.settings.exportHistory ?? [])],
    aiConsent: local.planning.settings.aiConsent,
  };
  return result;
}

/** Stable shared-content fingerprint; device preferences must not cause upload churn. */
export function workspaceContentString(workspace: WorkspaceBackup): string {
  const data = workspace.planning;
  const settings = { ...DEFAULT_SETTINGS, ...data.settings };
  const sharedSettings = Object.fromEntries(Object.entries(settings).filter(([field]) => !LOCAL_SYNC_PREFERENCES.has(field as keyof AppSettings)));
  return contentString({
    format: workspace.format, version: workspace.version,
    notes: byKey(workspace.notes, entityId),
    planning: {
      ...data,
      tasks: byKey(data.tasks, entityId).map(task => ({ ...task, tags: task.tags ?? [] })),
      appointments: byKey(data.appointments, entityId), timeBlocks: byKey(data.timeBlocks, entityId),
      days: byKey(data.days, calendarDate), weeks: byKey(data.weeks, item => item.weekStart),
      operations: byKey(data.operations, entityId), taskRules: byKey(data.taskRules, entityId),
      recurrenceReceipts: byKey(data.recurrenceReceipts, recurrenceKey),
      reminders: byKey(data.reminders, entityId), reminderReceipts: byKey(data.reminderReceipts, entityId),
      morningRoutineReceipts: byKey(data.morningRoutineReceipts, calendarDate),
      settings: {
        ...sharedSettings,
        ...(settings.capacity === undefined ? {} : { capacity: { ...settings.capacity, windows: byKey(settings.capacity.windows, weekday) } }),
        ...(settings.morningRoutine === undefined ? {} : { morningRoutine: { days: byKey(settings.morningRoutine.days, weekday) } }),
      },
    },
  });
}

export function workspaceContentEqual(left: WorkspaceBackup | null, right: WorkspaceBackup | null): boolean {
  return left === null || right === null ? left === right : workspaceContentString(left) === workspaceContentString(right);
}

/**
 * Three-way sync preserves IDs and deletions, unlike the separate backup import
 * merge. Without an acknowledged base, missing entities are never deletions.
 * Nested note/task data stays atomic so simultaneous edits cannot lose history.
 */
export function mergeWorkspaceSnapshots(base: WorkspaceBackup | null, local: WorkspaceBackup, remote: WorkspaceBackup): WorkspaceMergeResult {
  const conflicts: WorkspaceMergeConflict[] = [];
  const conflict = (path: string, label: string, ancestor: unknown, ours: unknown, theirs: unknown): void => {
    conflicts.push({ path, label, base: ancestor === undefined ? null : structuredClone(ancestor),
      local: ours === undefined ? null : structuredClone(ours), remote: theirs === undefined ? null : structuredClone(theirs) });
  };

  // Normalize old versions and defaults before comparison, and refuse malformed
  // source snapshots rather than allowing duplicate IDs to vanish in a Map.
  let ancestor: WorkspaceBackup | null = null;
  let ours: WorkspaceBackup;
  let theirs: WorkspaceBackup;
  try {
    ancestor = base === null ? null : parseWorkspaceBackup(JSON.stringify(base));
    ours = parseWorkspaceBackup(JSON.stringify(local));
    theirs = parseWorkspaceBackup(JSON.stringify(remote));
  } catch (error) {
    conflict('workspace', error instanceof Error ? error.message : 'Die Workspace-Sicherung ist ungültig.', base, local, remote);
    return { workspace: null, conflicts };
  }

  function value<T>(path: string, label: string, original: T | undefined, left: T | undefined, right: T | undefined): T | undefined {
    if (equal(left, right)) return left;
    if (equal(left, original)) return right;
    if (equal(right, original)) return left;
    conflict(path, label, original, left, right);
    return undefined;
  }

  function collection<T>(path: string, label: string, original: readonly T[] | undefined, left: readonly T[] | undefined, right: readonly T[] | undefined, key: (entry: T) => string): T[] {
    const before = new Map((original ?? []).map(entry => [key(entry), entry]));
    const localItems = new Map((left ?? []).map(entry => [key(entry), entry]));
    const remoteItems = new Map((right ?? []).map(entry => [key(entry), entry]));
    const keys = [...new Set([...before.keys(), ...localItems.keys(), ...remoteItems.keys()])].sort(compare);
    const result: T[] = [];
    for (const id of keys) {
      const merged = value(`${path}[${JSON.stringify(id)}]`, `${label}: ${id}`, before.get(id), localItems.get(id), remoteItems.get(id));
      if (merged !== undefined) result.push(merged);
    }
    return result;
  }

  function capacity(original: CapacitySettings | undefined, left: CapacitySettings, right: CapacitySettings): CapacitySettings {
    return {
      enabled: value('planning.settings.capacity.enabled', 'Kapazitätsplanung', original?.enabled, left.enabled, right.enabled)!,
      bufferMinutes: value('planning.settings.capacity.bufferMinutes', 'Kapazitätspuffer', original?.bufferMinutes, left.bufferMinutes, right.bufferMinutes)!,
      windows: collection('planning.settings.capacity.windows', 'Kapazitätszeitfenster', original?.windows, left.windows, right.windows, weekday),
    };
  }

  function routine(original: MorningRoutineSettings | undefined, left: MorningRoutineSettings, right: MorningRoutineSettings): MorningRoutineSettings {
    return { days: collection('planning.settings.morningRoutine.days', 'Morgenroutine', (original ?? DEFAULT_MORNING_ROUTINE).days, left.days, right.days, weekday) };
  }

  // Initial defaults are the settings ancestor for a new device. This lets an
  // empty device adopt cloud preferences while retaining its own changed fields.
  const beforeSettings = ancestor?.planning.settings ?? DEFAULT_SETTINGS;
  const leftSettings = ours.planning.settings;
  const rightSettings = theirs.planning.settings;
  const mergedSettings: Record<string, unknown> = {};
  const fields = [...new Set([...Object.keys(beforeSettings), ...Object.keys(leftSettings), ...Object.keys(rightSettings)])].sort(compare) as (keyof AppSettings)[];
  for (const field of fields) {
    const original = beforeSettings[field];
    const left = leftSettings[field];
    const right = rightSettings[field];
    let merged: unknown;
    // These values are installation state, not shared user content. In
    // particular, navigating on two devices must never create a conflict.
    if (LOCAL_SYNC_PREFERENCES.has(field)) merged = left;
    // A deletion versus an edit to the same optional object remains a conflict.
    else if (field === 'capacity' && leftSettings.capacity && rightSettings.capacity) {
      merged = capacity(beforeSettings.capacity, leftSettings.capacity, rightSettings.capacity);
    } else if (field === 'morningRoutine' && leftSettings.morningRoutine && rightSettings.morningRoutine) {
      merged = routine(beforeSettings.morningRoutine, leftSettings.morningRoutine, rightSettings.morningRoutine);
    } else merged = value(`planning.settings.${field}`, `Einstellung: ${field}`, original, left, right);
    if (merged !== undefined) mergedSettings[field] = merged;
  }

  const previous = ancestor?.planning;
  const left = ours.planning;
  const right = theirs.planning;
  const planning: PlanningData = {
    tasks: collection('planning.tasks', 'Aufgabe', previous?.tasks, left.tasks, right.tasks, entityId),
    appointments: collection('planning.appointments', 'Termin', previous?.appointments, left.appointments, right.appointments, entityId),
    timeBlocks: collection('planning.timeBlocks', 'Zeitblock', previous?.timeBlocks, left.timeBlocks, right.timeBlocks, entityId),
    days: collection('planning.days', 'Tagesplan', previous?.days, left.days, right.days, calendarDate),
    weeks: collection('planning.weeks', 'Wochenplan', previous?.weeks, left.weeks, right.weeks, item => item.weekStart),
    operations: collection('planning.operations', 'Übernahmebeleg', previous?.operations, left.operations, right.operations, entityId),
    taskRules: collection('planning.taskRules', 'Wiederholungsregel', previous?.taskRules, left.taskRules, right.taskRules, entityId),
    recurrenceReceipts: collection('planning.recurrenceReceipts', 'Wiederholungsbeleg', previous?.recurrenceReceipts, left.recurrenceReceipts, right.recurrenceReceipts, recurrenceKey),
    reminders: collection('planning.reminders', 'Erinnerung', previous?.reminders, left.reminders, right.reminders, entityId),
    reminderReceipts: collection('planning.reminderReceipts', 'Erinnerungsbeleg', previous?.reminderReceipts, left.reminderReceipts, right.reminderReceipts, entityId),
    morningRoutineReceipts: collection('planning.morningRoutineReceipts', 'Morgenroutinebeleg', previous?.morningRoutineReceipts, left.morningRoutineReceipts, right.morningRoutineReceipts, calendarDate),
    settings: mergedSettings as unknown as AppSettings,
  };
  const notes = collection('notes', 'Notiz', ancestor?.notes, ours.notes, theirs.notes, entityId);
  if (conflicts.length) return { workspace: null, conflicts };

  // No wall-clock calls: the same snapshots always produce the same result.
  const exportedAt = [ours.exportedAt, theirs.exportedAt].sort(compare).at(-1)!;
  try {
    const workspace = parseWorkspaceBackup(JSON.stringify({ format: 'nexus-workspace', version: 4, exportedAt, notes, planning }));
    return { workspace, conflicts };
  } catch (error) {
    conflict('workspace.references', error instanceof Error ? error.message : 'Die zusammengeführten Verknüpfungen sind ungültig.', ancestor, ours, theirs);
    return { workspace: null, conflicts };
  }
}
