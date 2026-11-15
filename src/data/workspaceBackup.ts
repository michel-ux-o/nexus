import type { Note } from '../types';
import type { AppSettings, PlanningData, Subtask, WorkspaceBackup } from '../planning/types';
import { DEFAULT_SETTINGS, emptyPlanning } from '../planning/types';
import { reminderOccurrenceId } from '../planning/reminders';
import { makeBackup, parseBackup } from './backup';

export const MAX_WORKSPACE_BACKUP_BYTES = 50 * 1024 * 1024;
export const WORKSPACE_LIMITS = Object.freeze({
  bytes: MAX_WORKSPACE_BACKUP_BYTES, tasks: 10_000, appointments: 10_000,
  timeBlocks: 20_000, days: 2_000, weeks: 1_000, operations: 10_000,
  taskRules: 10_000, recurrenceReceipts: 100_000, reminders: 10_000, reminderReceipts: 100_000, morningRoutineReceipts: 100_000,
  id: 128, title: 500, text: 200_000, subtasks: 1_000, tags: 100, tag: 100,
});

function invalid(path: string, message: string): never {
  throw new Error(`Ungültige Workspace-Sicherung: ${path} ${message}`);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid(path, 'muss ein Objekt sein.');
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string, max: number = WORKSPACE_LIMITS.text): string {
  if (typeof value !== 'string' || value.length > max) return invalid(path, `muss Text mit höchstens ${max.toLocaleString('de-DE')} Zeichen enthalten.`);
  return value;
}

function id(value: unknown, path: string): string {
  const result = text(value, path, WORKSPACE_LIMITS.id);
  if (!result.trim() || /[\u0000-\u001f\u007f]/.test(result)) return invalid(path, 'muss eine nicht leere Kennung ohne Steuerzeichen sein.');
  return result;
}

function title(value: unknown, path: string): string {
  const result = text(value, path, WORKSPACE_LIMITS.title);
  if (!result.trim()) return invalid(path, 'darf nicht leer sein.');
  return result;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') return invalid(path, 'muss wahr oder falsch sein.');
  return value;
}

function integer(value: unknown, path: string, min = 1, max = 1440): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) return invalid(path, `muss eine ganze Zahl zwischen ${min} und ${max} sein.`);
  return value;
}

function choice<T extends string | null>(value: unknown, path: string, values: readonly T[]): T {
  if (!values.includes(value as T)) return invalid(path, 'enthält einen nicht unterstützten Wert.');
  return value as T;
}

function list<T>(value: unknown, path: string, max: number, parse: (value: unknown, path: string) => T): T[] {
  if (!Array.isArray(value) || value.length > max) return invalid(path, `muss eine Liste mit höchstens ${max.toLocaleString('de-DE')} Einträgen sein.`);
  return value.map((entry, index) => parse(entry, `${path}[${index + 1}]`));
}

function unique<T>(items: T[], key: (item: T) => string, path: string): T[] {
  const used = new Set<string>();
  for (const item of items) {
    const value = key(item);
    if (used.has(value)) return invalid(path, `enthält die Kennung „${value}“ mehrfach.`);
    used.add(value);
  }
  return items;
}

function ids(value: unknown, path: string, max: number): string[] {
  return unique(list(value, path, max, id), entry => entry, path);
}

function timestamp(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return invalid(path, 'muss ein gültiger ISO-Zeitstempel in UTC sein.');
  const expected = value.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction: string | undefined) => `.${(fraction ?? '').padEnd(3, '0')}Z`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== expected) return invalid(path, 'muss ein gültiger ISO-Zeitstempel in UTC sein.');
  return value;
}

function date(value: unknown, path: string, monday = false): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1) return invalid(path, 'muss ein echtes Kalenderdatum (JJJJ-MM-TT, Jahr 0001–9999) sein.');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return invalid(path, 'muss ein echtes Kalenderdatum sein.');
  if (monday && parsed.getUTCDay() !== 1) return invalid(path, 'muss der Montag einer Woche sein.');
  return value;
}

function times(item: Record<string, unknown>, path: string) {
  const createdAt = timestamp(item.createdAt, `${path}.createdAt`);
  const updatedAt = timestamp(item.updatedAt, `${path}.updatedAt`);
  if (new Date(updatedAt).getTime() < new Date(createdAt).getTime()) return invalid(path, 'darf vor seiner Erstellung nicht geändert worden sein.');
  return { createdAt, updatedAt };
}

function interval(item: Record<string, unknown>, path: string) {
  const startAt = timestamp(item.startAt, `${path}.startAt`);
  const durationMinutes = integer(item.durationMinutes, `${path}.durationMinutes`);
  // An interval's end must remain representable by our UTC ISO format, too.
  timestamp(new Date(new Date(startAt).getTime() + durationMinutes * 60_000).toISOString(), `${path}.Ende`);
  return { startAt, durationMinutes };
}

function timeZone(value: unknown, path: string): string {
  const result = text(value, path, 100);
  try { new Intl.DateTimeFormat('de-DE', { timeZone: result }); }
  catch { return invalid(path, 'muss eine gültige IANA-Zeitzone sein.'); }
  if (!result.trim() || /^[+-]/.test(result)) return invalid(path, 'muss eine gültige IANA-Zeitzone sein.');
  return result;
}

function clock(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return invalid(path, 'muss eine Uhrzeit von 00:00 bis 23:59 sein.');
  return value;
}

function hexColor(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) return invalid(path, 'muss ein sechsstelliger Hex-Farbwert sein, zum Beispiel #8ebed4.');
  return value;
}

function tags(value: unknown, path: string): string[] {
  return unique(list(value, path, WORKSPACE_LIMITS.tags, (value, path) => {
    const result = text(value, path, WORKSPACE_LIMITS.tag);
    if (!result.trim()) return invalid(path, 'darf nicht leer sein.');
    return result;
  }), item => item, path);
}

/** Exactly one child level; never silently discard a deeper imported tree. */
function subtasks(value: unknown, path: string): Subtask[] {
  const result = list(value, path, WORKSPACE_LIMITS.subtasks, (value, path): Subtask => {
    const item = object(value, path);
    const done = bool(item.done, `${path}.done`);
    const children = item.children === undefined ? undefined : list(item.children, `${path}.children`, WORKSPACE_LIMITS.subtasks, (value, path) => {
      const child = object(value, path);
      if (child.children !== undefined) invalid(`${path}.children`, 'darf keine weitere Unterebene enthalten.');
      return { id: id(child.id, `${path}.id`), title: title(child.title, `${path}.title`), done: bool(child.done, `${path}.done`), suggestion: bool(child.suggestion, `${path}.suggestion`) };
    });
    return {
      id: id(item.id, `${path}.id`), title: title(item.title, `${path}.title`),
      done: children?.length ? children.every(child => child.done) : done, suggestion: bool(item.suggestion, `${path}.suggestion`),
      ...(children === undefined ? {} : { children }),
    };
  });
  const all = result.flatMap(item => [item, ...(item.children ?? [])]);
  if (all.length > WORKSPACE_LIMITS.subtasks) invalid(path, `darf einschließlich Einzelschritten höchstens ${WORKSPACE_LIMITS.subtasks} Einträge enthalten.`);
  unique(all, item => item.id, path);
  return result;
}

function ruleSubtasks(value: unknown, path: string): NonNullable<PlanningData['taskRules']>[number]['template']['subtasks'] {
  const result = list(value, path, WORKSPACE_LIMITS.subtasks, (value, path) => {
    const item = object(value, path);
    const children = item.children === undefined ? undefined : list(item.children, `${path}.children`, WORKSPACE_LIMITS.subtasks, (value, path) => {
      const child = object(value, path);
      if (child.children !== undefined) invalid(`${path}.children`, 'darf keine weitere Unterebene enthalten.');
      return { title: title(child.title, `${path}.title`), suggestion: bool(child.suggestion, `${path}.suggestion`) };
    });
    return { title: title(item.title, `${path}.title`), suggestion: bool(item.suggestion, `${path}.suggestion`), ...(children === undefined ? {} : { children }) };
  });
  if (result.reduce((total, item) => total + 1 + (item.children?.length ?? 0), 0) > WORKSPACE_LIMITS.subtasks) invalid(path, 'enthält zu viele Unteraufgaben einschließlich Einzelschritten.');
  return result;
}

const NEW_SETTINGS = ['menuMotion', 'matrixBackground', 'powerSaving', 'dashboardSections', 'capacity', 'notifications', 'backupIntervalDays', 'exportHistory', 'onboardingDone'] as const;

function settings(value: unknown, strict: boolean): AppSettings {
  const item = object(value, 'settings');
  if (strict) for (const field of NEW_SETTINGS) if (item[field] === undefined) invalid(`settings.${field}`, 'fehlt in der Version-3-Sicherung.');
  const source = { ...structuredClone(DEFAULT_SETTINGS), ...item };
  const capacity = object(source.capacity, 'settings.capacity');
  const windows = unique(list(capacity.windows, 'settings.capacity.windows', 7, (value, path) => {
    const window = object(value, path);
    const start = clock(window.start, `${path}.start`);
    const end = clock(window.end, `${path}.end`);
    if (start >= end) return invalid(path, 'muss am selben Tag vor seinem Ende beginnen.');
    return { weekday: integer(window.weekday, `${path}.weekday`, 1, 7), enabled: bool(window.enabled, `${path}.enabled`), start, end };
  }), window => String(window.weekday), 'settings.capacity.windows');
  return {
    ...(item.theme === undefined ? {} : { theme: choice(item.theme, 'settings.theme', ['nexus', 'daylight', 'sand', 'aurora', 'system'] as const) }),
    ...(item.artifactIntensity === undefined ? {} : { artifactIntensity: choice(item.artifactIntensity, 'settings.artifactIntensity', ['still', 'atmospheric', 'intense'] as const) }),
    ...(item.particleColor === undefined ? {} : { particleColor: hexColor(item.particleColor, 'settings.particleColor') }),
    timeZone: timeZone(item.timeZone, 'settings.timeZone'),
    startView: choice(item.startView, 'settings.startView', ['menu', 'home', 'last']),
    lastView: choice(item.lastView, 'settings.lastView', ['menu', 'home', 'tasks', 'notes', 'today', 'week', 'calendar', 'reminders', 'settings', 'ai']),
    voiceReview: bool(item.voiceReview, 'settings.voiceReview'),
    aiConsent: bool(item.aiConsent, 'settings.aiConsent'),
    defaultAvailableMinutes: integer(item.defaultAvailableMinutes, 'settings.defaultAvailableMinutes', 0),
    menuMotion: choice(source.menuMotion, 'settings.menuMotion', ['still', 'float', 'orbit'] as const),
    matrixBackground: bool(source.matrixBackground, 'settings.matrixBackground'),
    powerSaving: bool(source.powerSaving, 'settings.powerSaving'),
    dashboardSections: unique(list(source.dashboardSections, 'settings.dashboardSections', 7, (value, path) => choice(value, path, ['priority', 'tasks', 'progress', 'upcoming', 'notes', 'capture', 'ai'])), value => value, 'settings.dashboardSections'),
    capacity: { enabled: bool(capacity.enabled, 'settings.capacity.enabled'), windows, bufferMinutes: integer(capacity.bufferMinutes, 'settings.capacity.bufferMinutes', 0) },
    notifications: bool(source.notifications, 'settings.notifications'),
    backupIntervalDays: integer(source.backupIntervalDays, 'settings.backupIntervalDays', 0, 365),
    exportHistory: list(source.exportHistory, 'settings.exportHistory', 100, timestamp),
    onboardingDone: bool(source.onboardingDone, 'settings.onboardingDone'),
    ...(item.morningRoutine === undefined ? {} : { morningRoutine: (() => {
      const routine = object(item.morningRoutine, 'settings.morningRoutine');
      const days = unique(list(routine.days, 'settings.morningRoutine.days', 7, (value, path) => {
        const day = object(value, path);
        return { weekday: integer(day.weekday, `${path}.weekday`, 1, 7), enabled: bool(day.enabled, `${path}.enabled`), subtasks: subtasks(day.subtasks, `${path}.subtasks`) };
      }), day => String(day.weekday), 'settings.morningRoutine.days');
      if (days.length !== 7) invalid('settings.morningRoutine.days', 'muss für Montag bis Sonntag jeweils genau eine Vorlage enthalten.');
      return { days };
    })() }),
  };
}

/** Validate and copy the entire graph. Deleted capture targets remain as tombstones. */
export function validatePlanningData(value: unknown, notes: readonly Note[], strict = false): PlanningData {
  const data = object(value, 'planning');
  const newList = (field: 'taskRules' | 'recurrenceReceipts' | 'reminders' | 'reminderReceipts') => {
    if (strict && data[field] === undefined) return invalid(field, 'fehlt in der Version-3-Sicherung.');
    return data[field] === undefined ? [] : data[field];
  };
  const tasks = unique(list(data.tasks, 'tasks', WORKSPACE_LIMITS.tasks, (value, path) => {
    const item = object(value, path);
    let plan: PlanningData['tasks'][number]['plan'] = null;
    if (item.plan !== null) {
      const source = object(item.plan, `${path}.plan`);
      const kind = choice(source.kind, `${path}.plan.kind`, ['day', 'week']);
      plan = kind === 'day' ? { kind, date: date(source.date, `${path}.plan.date`) }
        : { kind, weekStart: date(source.weekStart, `${path}.plan.weekStart`, true) };
    }
    const taskSubtasks = subtasks(item.subtasks, `${path}.subtasks`);
    if ((item.ruleId === undefined) !== (item.occurrenceDate === undefined)) invalid(path, 'muss Wiederholungsregel und Vorkommensdatum gemeinsam enthalten.');
    if (strict && item.tags === undefined) invalid(`${path}.tags`, 'fehlt in der Version-3-Sicherung.');
    return {
      id: id(item.id, `${path}.id`), title: title(item.title, `${path}.title`),
      description: text(item.description, `${path}.description`),
      status: choice(item.status, `${path}.status`, ['open', 'progress', 'done']),
      priority: choice(item.priority, `${path}.priority`, ['low', 'normal', 'high', null]),
      estimatedMinutes: item.estimatedMinutes === null ? null : integer(item.estimatedMinutes, `${path}.estimatedMinutes`),
      dueDate: item.dueDate === null ? null : date(item.dueDate, `${path}.dueDate`),
      plan, subtasks: taskSubtasks, noteIds: ids(item.noteIds, `${path}.noteIds`, 10_000), tags: tags(item.tags === undefined ? [] : item.tags, `${path}.tags`),
      ...(item.morningRoutineDate === undefined ? {} : { morningRoutineDate: date(item.morningRoutineDate, `${path}.morningRoutineDate`) }),
      ...(item.ruleId === undefined ? {} : { ruleId: id(item.ruleId, `${path}.ruleId`), occurrenceDate: date(item.occurrenceDate, `${path}.occurrenceDate`) }), ...times(item, path),
    };
  }), item => item.id, 'tasks');
  const appointments = unique(list(data.appointments, 'appointments', WORKSPACE_LIMITS.appointments, (value, path) => {
    const item = object(value, path);
    let allDay;
    if (item.allDay !== undefined) {
      const source = object(item.allDay, `${path}.allDay`);
      const startDate = date(source.startDate, `${path}.allDay.startDate`);
      const endDate = date(source.endDate, `${path}.allDay.endDate`);
      if (endDate <= startDate) return invalid(`${path}.allDay`, 'muss ein exklusives Enddatum nach dem Startdatum besitzen.');
      allDay = { startDate, endDate };
    }
    // Legacy interval fields are retained for round trips, never interpreted as
    // capacity for an all-day entry. Newly authored entries may omit them.
    const timing = allDay ? {
      startAt: item.startAt === undefined ? `${allDay.startDate}T00:00:00.000Z` : timestamp(item.startAt, `${path}.startAt`),
      durationMinutes: item.durationMinutes === undefined ? 1 : integer(item.durationMinutes, `${path}.durationMinutes`),
    } : interval(item, path);
    return { id: id(item.id, `${path}.id`), title: title(item.title, `${path}.title`), description: text(item.description, `${path}.description`), ...timing, ...(allDay ? { allDay } : {}), ...times(item, path) };
  }), item => item.id, 'appointments');
  const timeBlocks = unique(list(data.timeBlocks, 'timeBlocks', WORKSPACE_LIMITS.timeBlocks, (value, path) => {
    const item = object(value, path);
    return { id: id(item.id, `${path}.id`), taskId: id(item.taskId, `${path}.taskId`), ...interval(item, path), ...times(item, path) };
  }), item => item.id, 'timeBlocks');
  const days = unique(list(data.days, 'days', WORKSPACE_LIMITS.days, (value, path) => {
    const item = object(value, path);
    return { date: date(item.date, `${path}.date`), priorityTaskIds: ids(item.priorityTaskIds, `${path}.priorityTaskIds`, 3), note: text(item.note, `${path}.note`), review: text(item.review, `${path}.review`), availableMinutes: integer(item.availableMinutes, `${path}.availableMinutes`, 0) };
  }), item => item.date, 'days');
  const weeks = unique(list(data.weeks, 'weeks', WORKSPACE_LIMITS.weeks, (value, path) => {
    const item = object(value, path);
    return { weekStart: date(item.weekStart, `${path}.weekStart`, true), goals: text(item.goals, `${path}.goals`), review: text(item.review, `${path}.review`) };
  }), item => item.weekStart, 'weeks');
  const operations = unique(list(data.operations, 'operations', WORKSPACE_LIMITS.operations, (value, path) => {
    const item = object(value, path);
    const items = unique(list(item.items, `${path}.items`, WORKSPACE_LIMITS.tasks, (value, path) => {
      const receipt = object(value, path);
      return { itemId: id(receipt.itemId, `${path}.itemId`), taskId: id(receipt.taskId, `${path}.taskId`), appliedUpdatedAt: timestamp(receipt.appliedUpdatedAt, `${path}.appliedUpdatedAt`), blockIds: ids(receipt.blockIds, `${path}.blockIds`, WORKSPACE_LIMITS.timeBlocks) };
    }), receipt => receipt.itemId, `${path}.items`);
    unique(items, receipt => receipt.taskId, `${path}.items.taskId`);
    return { id: id(item.id, `${path}.id`), status: choice(item.status, `${path}.status`, ['applied', 'undone']), items, ...times(item, path) };
  }), item => item.id, 'operations');
  const taskRules = unique(list(newList('taskRules'), 'taskRules', WORKSPACE_LIMITS.taskRules, (value, path) => {
    const item = object(value, path);
    const template = object(item.template, `${path}.template`);
    const startDate = date(item.startDate, `${path}.startDate`);
    const endDate = item.endDate === null ? null : date(item.endDate, `${path}.endDate`);
    if (endDate !== null && endDate < startDate) return invalid(path, 'darf nicht vor seinem Beginn enden.');
    return {
      id: id(item.id, `${path}.id`), frequency: choice(item.frequency, `${path}.frequency`, ['daily', 'weekdays', 'weekly']), startDate, endDate,
      paused: bool(item.paused, `${path}.paused`), template: {
        title: title(template.title, `${path}.template.title`), description: text(template.description, `${path}.template.description`),
        priority: choice(template.priority, `${path}.template.priority`, ['low', 'normal', 'high', null]),
        estimatedMinutes: template.estimatedMinutes === null ? null : integer(template.estimatedMinutes, `${path}.template.estimatedMinutes`),
        tags: tags(template.tags, `${path}.template.tags`), noteIds: ids(template.noteIds, `${path}.template.noteIds`, 10_000),
        subtasks: ruleSubtasks(template.subtasks, `${path}.template.subtasks`),
        dueOffsetDays: template.dueOffsetDays === null ? null : integer(template.dueOffsetDays, `${path}.template.dueOffsetDays`, -36_500, 36_500),
      }, ...times(item, path),
    };
  }), item => item.id, 'taskRules');
  const recurrenceReceipts = unique(list(newList('recurrenceReceipts'), 'recurrenceReceipts', WORKSPACE_LIMITS.recurrenceReceipts, (value, path) => {
    const item = object(value, path);
    return { ruleId: id(item.ruleId, `${path}.ruleId`), date: date(item.date, `${path}.date`), taskId: id(item.taskId, `${path}.taskId`) };
  }), item => JSON.stringify([item.ruleId, item.date]), 'recurrenceReceipts');
  unique(recurrenceReceipts, item => item.taskId, 'recurrenceReceipts.taskId');
  const reminders = unique(list(newList('reminders'), 'reminders', WORKSPACE_LIMITS.reminders, (value, path) => {
    const item = object(value, path);
    if (typeof item.localStart !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(item.localStart)) return invalid(`${path}.localStart`, 'muss ein lokales Datum mit Uhrzeit (JJJJ-MM-TTTHH:mm) sein.');
    date(item.localStart.slice(0, 10), `${path}.localStart`);
    clock(item.localStart.slice(11), `${path}.localStart`);
    const taskId = item.taskId === null ? null : id(item.taskId, `${path}.taskId`);
    const appointmentId = item.appointmentId === null ? null : id(item.appointmentId, `${path}.appointmentId`);
    if (taskId !== null && appointmentId !== null) return invalid(path, 'darf höchstens eine Aufgabe oder einen Termin verknüpfen.');
    return {
      id: id(item.id, `${path}.id`), title: title(item.title, `${path}.title`), localStart: item.localStart,
      timeZone: timeZone(item.timeZone, `${path}.timeZone`), frequency: choice(item.frequency, `${path}.frequency`, ['once', 'daily', 'weekly']),
      enabled: bool(item.enabled, `${path}.enabled`), taskId, appointmentId, ...times(item, path),
    };
  }), item => item.id, 'reminders');
  const reminderReceipts = unique(list(newList('reminderReceipts'), 'reminderReceipts', WORKSPACE_LIMITS.reminderReceipts, (value, path) => {
    const item = object(value, path);
    const reminderId = id(item.reminderId, `${path}.reminderId`);
    const scheduledAt = timestamp(item.scheduledAt, `${path}.scheduledAt`);
    const receiptId = id(item.id, `${path}.id`);
    if (receiptId !== reminderOccurrenceId(reminderId, scheduledAt)) return invalid(`${path}.id`, 'muss der stabilen Kennung aus Erinnerung und UTC-Vorkommen entsprechen.');
    const snoozedUntil = item.snoozedUntil === null ? null : timestamp(item.snoozedUntil, `${path}.snoozedUntil`);
    if (snoozedUntil !== null && Date.parse(snoozedUntil) <= Date.parse(scheduledAt)) return invalid(`${path}.snoozedUntil`, 'muss nach dem geplanten UTC-Vorkommen liegen.');
    return {
      id: receiptId, reminderId, scheduledAt,
      status: choice(item.status, `${path}.status`, ['pending', 'done', 'dismissed']),
      snoozedUntil,
      notifiedAt: item.notifiedAt === null ? null : timestamp(item.notifiedAt, `${path}.notifiedAt`),
    };
  }), item => item.id, 'reminderReceipts');
  unique(reminderReceipts, item => JSON.stringify([item.reminderId, Date.parse(item.scheduledAt)]), 'reminderReceipts.Vorkommen');
  const morningRoutineReceipts = data.morningRoutineReceipts === undefined ? undefined : unique(list(data.morningRoutineReceipts, 'morningRoutineReceipts', WORKSPACE_LIMITS.morningRoutineReceipts, (value, path) => {
    const item = object(value, path);
    return { date: date(item.date, `${path}.date`), taskId: id(item.taskId, `${path}.taskId`), skipped: bool(item.skipped, `${path}.skipped`) };
  }), item => item.date, 'morningRoutineReceipts');
  unique(morningRoutineReceipts ?? [], item => item.taskId, 'morningRoutineReceipts.taskId');

  const noteIds = new Set(notes.map(note => note.id));
  unique([...tasks, ...appointments, ...timeBlocks, ...operations, ...taskRules, ...reminders, ...reminderReceipts], item => item.id, 'planning');
  const taskIds = new Set(tasks.map(task => task.id));
  const appointmentIds = new Set(appointments.map(item => item.id));
  const ruleIds = new Set(taskRules.map(item => item.id));
  const recurrenceByTask = new Map(recurrenceReceipts.map(item => [item.taskId, item]));
  const morningByTask = new Map((morningRoutineReceipts ?? []).map(item => [item.taskId, item]));
  const blocks = new Map(timeBlocks.map(block => [block.id, block]));
  for (const task of tasks) for (const linked of task.noteIds) if (!noteIds.has(linked)) invalid(`task ${task.id}.noteIds`, `verweist auf die fehlende Notiz „${linked}“.`);
  for (const rule of taskRules) for (const linked of rule.template.noteIds) if (!noteIds.has(linked)) invalid(`taskRule ${rule.id}.template.noteIds`, `verweist auf die fehlende Notiz „${linked}“.`);
  for (const receipt of recurrenceReceipts) if (!ruleIds.has(receipt.ruleId)) invalid('recurrenceReceipts.ruleId', 'verweist auf eine fehlende Wiederholungsregel.');
  for (const task of tasks) {
    const receipt = recurrenceByTask.get(task.id);
    if (task.ruleId !== undefined && (!ruleIds.has(task.ruleId) || !receipt)) invalid(`task ${task.id}.ruleId`, 'benötigt eine vorhandene Regel und einen dauerhaften Vorkommensbeleg.');
    if (receipt && (receipt.ruleId !== task.ruleId || receipt.date !== task.occurrenceDate)) invalid(`task ${task.id}`, 'widerspricht seinem Wiederholungsbeleg.');
    const morning = morningByTask.get(task.id);
    if (task.morningRoutineDate !== undefined && (!morning || morning.date !== task.morningRoutineDate)) invalid(`task ${task.id}.morningRoutineDate`, 'benötigt einen passenden dauerhaften Tagesbeleg.');
    if (morning && morning.date !== task.morningRoutineDate) invalid(`task ${task.id}`, 'widerspricht seinem Morgenroutinebeleg.');
    if (morning && task.ruleId !== undefined) invalid(`task ${task.id}`, 'darf nicht zugleich Morgenroutine und Wiederholungsaufgabe sein.');
  }
  for (const reminder of reminders) {
    if (reminder.taskId !== null && !taskIds.has(reminder.taskId)) invalid(`reminder ${reminder.id}.taskId`, 'verweist auf eine fehlende Aufgabe.');
    if (reminder.appointmentId !== null && !appointmentIds.has(reminder.appointmentId)) invalid(`reminder ${reminder.id}.appointmentId`, 'verweist auf einen fehlenden Termin.');
  }
  for (const block of timeBlocks) if (!taskIds.has(block.taskId)) invalid(`timeBlock ${block.id}.taskId`, 'verweist auf eine fehlende Aufgabe.');
  for (const day of days) for (const priority of day.priorityTaskIds) if (!taskIds.has(priority)) invalid(`day ${day.date}.priorityTaskIds`, 'verweist auf eine fehlende Aufgabe.');
  const receiptTasks = new Set<string>();
  const receiptBlocks = new Set<string>();
  for (const operation of operations) for (const receipt of operation.items) {
    if (receiptTasks.has(receipt.taskId)) invalid(`operation ${operation.id}`, 'enthält eine bereits durch einen anderen Beleg angelegte Aufgabe.');
    receiptTasks.add(receipt.taskId);
    for (const blockId of receipt.blockIds) {
      if (receiptBlocks.has(blockId)) invalid(`operation ${operation.id}`, 'enthält einen bereits durch einen anderen Beleg angelegten Zeitblock.');
      receiptBlocks.add(blockId);
      const block = blocks.get(blockId);
      if (block && block.taskId !== receipt.taskId) invalid(`operation ${operation.id}`, 'verweist auf einen Zeitblock einer anderen Aufgabe.');
    }
  }
  // Capture, recurrence and reminder receipts intentionally retain historical
  // target IDs after deletion, so importing them cannot replay old actions.
  const result: PlanningData = { tasks, appointments, timeBlocks, days, weeks, operations, taskRules, recurrenceReceipts, reminders, reminderReceipts, ...(morningRoutineReceipts === undefined ? {} : { morningRoutineReceipts }), settings: settings(data.settings, strict) };
  assertSize(JSON.stringify(result));
  return result;
}

function assertSize(value: string): void {
  if (value.length > WORKSPACE_LIMITS.bytes || new TextEncoder().encode(value).byteLength > WORKSPACE_LIMITS.bytes) throw new Error('Die Workspace-Sicherung ist zu groß. Erlaubt sind höchstens 50 MiB einschließlich Notizen und Planung.');
}

/** Validate an immutable, compact-JSON-exportable snapshot. Notes retain the 20 MiB limit. */
export function makeWorkspaceBackup(notes: Note[], planning: PlanningData): WorkspaceBackup {
  const safeNotes = makeBackup(notes).notes;
  const result: WorkspaceBackup = { format: 'nexus-workspace', version: 4, exportedAt: new Date().toISOString(), notes: safeNotes, planning: validatePlanningData(planning, safeNotes) };
  assertSize(JSON.stringify(result));
  return result;
}

/** Normalize original v1/v2 backups; validate complete v3/v4 snapshots strictly. */
export function parseWorkspaceBackup(source: string): WorkspaceBackup {
  if (typeof source !== 'string') throw new Error('Die Sicherung muss als JSON-Text vorliegen.');
  assertSize(source);
  let parsed: unknown;
  try { parsed = JSON.parse(source); }
  catch { throw new Error('Die Datei enthält kein gültiges JSON. Bitte wähle eine NEXUS-Sicherung.'); }
  const value = object(parsed, 'Datei');
  if (value.format === 'nexus-notes') {
    const old = parseBackup(source);
    const planning = emptyPlanning();
    planning.settings.onboardingDone = true;
    return { ...makeWorkspaceBackup(old.notes, planning), exportedAt: old.exportedAt };
  }
  if (value.format !== 'nexus-workspace') throw new Error('Das Dateiformat wird nicht unterstützt. Erwartet wird eine NEXUS-Sicherung.');
  if (value.version !== 2 && value.version !== 3 && value.version !== 4) throw new Error('Diese Workspace-Sicherungsversion wird nicht unterstützt. Unterstützt werden Version 2, 3 und 4.');
  const exportedAt = timestamp(value.exportedAt, 'exportedAt');
  const notes = makeBackup(value.notes as Note[]).notes;
  const planning = validatePlanningData(value.planning, notes, value.version >= 3);
  if (value.version === 2) planning.settings.onboardingDone = true;
  const result = makeWorkspaceBackup(notes, planning);
  return { ...result, exportedAt };
}
