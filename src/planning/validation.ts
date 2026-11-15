import { isDate, isTimeZone, localToInstant, startOfWeek } from './dates';
import { reminderOccurrenceId } from './reminders';
import type { AppSettings, Appointment, CaptureItem, DayPlan, MorningRoutineSettings, PlanningData, Reminder, ReminderReceipt, Subtask, SubtaskTemplate, Task, TaskPlan, TaskRule, TimeBlock, WeekPlan } from './types';

function requireValue(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function text(value: unknown, maximum: number, label: string, required = false): void {
  requireValue(typeof value === 'string' && value.length <= maximum && (!required || value.trim().length > 0), `${label} ist leer oder zu lang.`);
}
function id(value: unknown): void { text(value, 128, 'Die Kennung', true); requireValue(typeof value === 'string' && !/[\u0000-\u001f\u007f]/.test(value), 'Die Kennung enthält Steuerzeichen.'); }
function unique(values: string[], label: string): void { requireValue(new Set(values).size === values.length, `${label} enthält doppelte Kennungen.`); }
function timestamp(value: unknown): void {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19), 'Der UTC-Zeitpunkt ist ungültig.');
}
function duration(value: unknown, optional = false): void {
  requireValue((optional && value === null) || (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 1440), 'Die Dauer muss zwischen 1 und 1440 ganzen Minuten liegen.');
}
function intervalEnd(startAt: string, minutes: number): void { timestamp(new Date(Date.parse(startAt) + minutes * 60_000).toISOString()); }
function dated(value: unknown, label: string): void { requireValue(isDate(value), `${label} ist kein gültiges Kalenderdatum.`); }
export function validatePlan(plan: TaskPlan): void {
  if (plan === null) return;
  requireValue(plan && typeof plan === 'object', 'Die Planung ist ungültig.');
  if (plan.kind === 'day') dated(plan.date, 'Der Planungstag');
  else {
    requireValue(plan.kind === 'week', 'Die Planungsart ist ungültig.');
    dated(plan.weekStart, 'Der Wochenbeginn');
    requireValue(startOfWeek(plan.weekStart) === plan.weekStart, 'Die Planungswoche muss an einem Montag beginnen.');
  }
}

/** At most two levels and 1000 total nodes; IDs are unique across both levels. */
export function validateSubtasks(subtasks: Subtask[]): void {
  requireValue(Array.isArray(subtasks) && subtasks.length <= 1000, 'Die Teilaufgaben sind ungültig oder zu zahlreich.');
  const ids: string[] = [];
  for (const subtask of subtasks) {
    requireValue(subtask && typeof subtask === 'object', 'Die Teilaufgabe ist ungültig.');
    id(subtask.id); text(subtask.title, 500, 'Der Teilaufgabentitel', true); ids.push(subtask.id);
    requireValue(typeof subtask.done === 'boolean' && typeof subtask.suggestion === 'boolean', 'Der Teilaufgabenstatus ist ungültig.');
    if (subtask.children === undefined) continue;
    requireValue(Array.isArray(subtask.children) && subtask.children.length <= 1000, 'Die einzelnen Schritte sind ungültig oder zu zahlreich.');
    for (const child of subtask.children) {
      requireValue(child && typeof child === 'object' && !('children' in child), 'Einzelne Schritte dürfen keine weitere Unterebene enthalten.');
      id(child.id); text(child.title, 500, 'Der Schritttitel', true); ids.push(child.id);
      requireValue(typeof child.done === 'boolean' && typeof child.suggestion === 'boolean', 'Der Schrittstatus ist ungültig.');
    }
  }
  requireValue(ids.length <= 1000, 'Eine Aufgabe darf höchstens 1000 Teilaufgaben und Schritte enthalten.');
  unique(ids, 'Die Teilaufgaben und Schritte');
}

export function validateMorningRoutine(routine: MorningRoutineSettings): void {
  requireValue(routine && typeof routine === 'object' && Array.isArray(routine.days) && routine.days.length === 7, 'Die Morgenroutine benötigt je eine Vorlage für Montag bis Sonntag.');
  const weekdays: string[] = [];
  for (const day of routine.days) {
    requireValue(day && typeof day === 'object' && Number.isInteger(day.weekday) && day.weekday >= 1 && day.weekday <= 7 && typeof day.enabled === 'boolean', 'Der Wochentag der Morgenroutine ist ungültig.');
    weekdays.push(String(day.weekday)); validateSubtasks(day.subtasks);
  }
  unique(weekdays, 'Die Vorlagen-Wochentage');
}

export function validateTask(task: Task): void {
  requireValue(task && typeof task === 'object', 'Die Aufgabe ist ungültig.');
  id(task.id); text(task.title, 500, 'Der Aufgabentitel', true); text(task.description, 200_000, 'Die Aufgabenbeschreibung');
  requireValue(['open', 'progress', 'done'].includes(task.status), 'Der Aufgabenstatus ist ungültig.');
  requireValue(task.priority === null || ['low', 'normal', 'high'].includes(task.priority), 'Die Priorität ist ungültig.');
  duration(task.estimatedMinutes, true);
  if (task.dueDate !== null) dated(task.dueDate, 'Die Fälligkeit');
  validatePlan(task.plan); timestamp(task.createdAt); timestamp(task.updatedAt);
  requireValue(Date.parse(task.updatedAt) >= Date.parse(task.createdAt), 'Die Änderung liegt vor der Erstellung der Aufgabe.');
  validateSubtasks(task.subtasks);
  requireValue(Array.isArray(task.noteIds) && task.noteIds.length <= 10_000, 'Die Notizverknüpfungen sind ungültig.');
  task.noteIds.forEach(id); unique(task.noteIds, 'Die Notizverknüpfungen');
  if (task.tags !== undefined) tags(task.tags);
  requireValue((task.ruleId === undefined) === (task.occurrenceDate === undefined), 'Wiederholungsregel und Vorkommensdatum müssen gemeinsam angegeben werden.');
  if (task.ruleId !== undefined) { id(task.ruleId); dated(task.occurrenceDate, 'Das Vorkommensdatum'); }
  if (task.morningRoutineDate !== undefined) {
    dated(task.morningRoutineDate, 'Das Datum der Morgenroutine');
    requireValue(task.ruleId === undefined, 'Eine Morgenroutine darf nicht zugleich eine Wiederholungsaufgabe sein.');
  }
}

export function validateAppointment(appointment: Appointment): void {
  id(appointment.id); text(appointment.title, 500, 'Der Termintitel', true); text(appointment.description, 200_000, 'Die Terminbeschreibung');
  timestamp(appointment.startAt); timestamp(appointment.createdAt); timestamp(appointment.updatedAt); duration(appointment.durationMinutes);
  if (appointment.allDay !== undefined) {
    requireValue(appointment.allDay && typeof appointment.allDay === 'object', 'Der ganztägige Termin ist ungültig.');
    dated(appointment.allDay.startDate, 'Der erste Termintag'); dated(appointment.allDay.endDate, 'Der exklusive letzte Termintag');
    requireValue(appointment.allDay.startDate < appointment.allDay.endDate, 'Der ganztägige Termin muss mindestens einen Tag umfassen.');
  } else intervalEnd(appointment.startAt, appointment.durationMinutes);
  requireValue(Date.parse(appointment.updatedAt) >= Date.parse(appointment.createdAt), 'Die Änderung liegt vor der Erstellung des Termins.');
}
export function validateTimeBlock(block: TimeBlock): void {
  id(block.id); id(block.taskId); timestamp(block.startAt); timestamp(block.createdAt); timestamp(block.updatedAt); duration(block.durationMinutes);
  intervalEnd(block.startAt, block.durationMinutes);
  requireValue(Date.parse(block.updatedAt) >= Date.parse(block.createdAt), 'Die Änderung liegt vor der Erstellung des Zeitblocks.');
}
export function validateDay(day: DayPlan): void {
  dated(day.date, 'Der Tag');
  requireValue(Array.isArray(day.priorityTaskIds) && day.priorityTaskIds.length <= 3, 'Wähle höchstens drei Tagesprioritäten.');
  day.priorityTaskIds.forEach(id); unique(day.priorityTaskIds, 'Die Tagesprioritäten');
  text(day.note, 200_000, 'Die Tagesnotiz'); text(day.review, 200_000, 'Der Tagesrückblick');
  requireValue(Number.isInteger(day.availableMinutes) && day.availableMinutes >= 0 && day.availableMinutes <= 1440, 'Die Tagesverfügbarkeit muss zwischen 0 und 1440 Minuten liegen.');
}
export function validateWeek(week: WeekPlan): void {
  dated(week.weekStart, 'Der Wochenbeginn');
  requireValue(startOfWeek(week.weekStart) === week.weekStart, 'Die Woche muss an einem Montag beginnen.');
  text(week.goals, 200_000, 'Die Wochenziele'); text(week.review, 200_000, 'Der Wochenrückblick');
}
export function validateSettings(settings: AppSettings): void {
  requireValue(isTimeZone(settings.timeZone), 'Bitte wähle eine gültige IANA-Zeitzone.');
  requireValue(['menu', 'home', 'last'].includes(settings.startView) && ['menu', 'home', 'tasks', 'notes', 'today', 'week', 'calendar', 'reminders', 'settings', 'ai'].includes(settings.lastView), 'Die Startansicht ist ungültig.');
  requireValue(typeof settings.voiceReview === 'boolean' && typeof settings.aiConsent === 'boolean', 'Die KI-Einstellungen sind ungültig.');
  requireValue(Number.isInteger(settings.defaultAvailableMinutes) && settings.defaultAvailableMinutes >= 0 && settings.defaultAvailableMinutes <= 1440, 'Die Standardverfügbarkeit muss zwischen 0 und 1440 Minuten liegen.');
  if (settings.theme !== undefined) requireValue(['nexus', 'daylight', 'sand', 'aurora', 'system'].includes(settings.theme), 'Das Theme ist ungültig.');
  if (settings.artifactIntensity !== undefined) requireValue(['still', 'atmospheric', 'intense'].includes(settings.artifactIntensity), 'Die Artefaktintensität ist ungültig.');
  if (settings.particleColor !== undefined) requireValue(typeof settings.particleColor === 'string' && /^#[0-9a-f]{6}$/i.test(settings.particleColor), 'Die Punktfarbe muss ein sechsstelliger Hex-Farbwert sein, zum Beispiel #8ebed4.');
  if (settings.menuMotion !== undefined) requireValue(['still', 'float', 'orbit'].includes(settings.menuMotion), 'Die Menübewegung ist ungültig.');
  for (const value of [settings.matrixBackground, settings.powerSaving, settings.notifications, settings.onboardingDone]) {
    requireValue(value === undefined || typeof value === 'boolean', 'Eine Ansichts- oder Benachrichtigungseinstellung ist ungültig.');
  }
  if (settings.dashboardSections !== undefined) {
    requireValue(Array.isArray(settings.dashboardSections) && settings.dashboardSections.length <= 7, 'Die Dashboard-Auswahl ist ungültig.');
    requireValue(settings.dashboardSections.every((section) => ['priority', 'tasks', 'progress', 'upcoming', 'notes', 'capture', 'ai'].includes(section)), 'Der Dashboard-Baustein ist ungültig.');
    unique(settings.dashboardSections, 'Die Dashboard-Auswahl');
  }
  if (settings.backupIntervalDays !== undefined) requireValue(Number.isInteger(settings.backupIntervalDays) && settings.backupIntervalDays >= 0 && settings.backupIntervalDays <= 365, 'Der Sicherungsabstand muss zwischen 0 und 365 Tagen liegen.');
  if (settings.exportHistory !== undefined) {
    requireValue(Array.isArray(settings.exportHistory) && settings.exportHistory.length <= 100, 'Die Exporthistorie ist ungültig.');
    settings.exportHistory.forEach(timestamp);
  }
  if (settings.morningRoutine !== undefined) validateMorningRoutine(settings.morningRoutine);
  if (settings.capacity !== undefined) {
    const capacity = settings.capacity;
    requireValue(capacity && typeof capacity.enabled === 'boolean' && Array.isArray(capacity.windows) && capacity.windows.length <= 7, 'Die Zeitkapazität ist ungültig.');
    requireValue(Number.isInteger(capacity.bufferMinutes) && capacity.bufferMinutes >= 0 && capacity.bufferMinutes <= 1440, 'Der Kapazitätspuffer muss zwischen 0 und 1440 Minuten liegen.');
    unique(capacity.windows.map((window) => String(window.weekday)), 'Die Kapazitäts-Wochentage');
    for (const window of capacity.windows) {
      requireValue(Number.isInteger(window.weekday) && window.weekday >= 1 && window.weekday <= 7 && typeof window.enabled === 'boolean', 'Der Kapazitäts-Wochentag ist ungültig.');
      requireValue(typeof window.start === 'string' && typeof window.end === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(window.start) && /^([01]\d|2[0-3]):[0-5]\d$/.test(window.end) && window.start < window.end, 'Das Zeitfenster benötigt gültige Uhrzeiten mit Beginn vor Ende.');
    }
  }
}

function tags(values: string[]): void {
  requireValue(Array.isArray(values) && values.length <= 100, 'Die Tags sind ungültig oder zu zahlreich.');
  values.forEach((value) => text(value, 100, 'Ein Tag', true)); unique(values, 'Die Tags');
}

export function validateSubtaskTemplates(subtasks: SubtaskTemplate[]): void {
  requireValue(Array.isArray(subtasks) && subtasks.length <= 1000, 'Die Vorlagenteilaufgaben sind ungültig.');
  let count = subtasks.length;
  for (const subtask of subtasks) {
    requireValue(subtask && typeof subtask === 'object', 'Die Teilaufgabenvorlage ist ungültig.');
    text(subtask.title, 500, 'Der Teilaufgabentitel', true);
    requireValue(typeof subtask.suggestion === 'boolean', 'Die Teilaufgabenvorlage ist ungültig.');
    if (subtask.children === undefined) continue;
    requireValue(Array.isArray(subtask.children) && subtask.children.length <= 1000, 'Die Vorlagenschritte sind ungültig oder zu zahlreich.');
    count += subtask.children.length;
    for (const child of subtask.children) {
      requireValue(child && typeof child === 'object' && !('children' in child), 'Vorlagenschritte dürfen keine weitere Unterebene enthalten.');
      text(child.title, 500, 'Der Schritttitel', true);
      requireValue(typeof child.suggestion === 'boolean', 'Die Schrittvorlage ist ungültig.');
    }
  }
  requireValue(count <= 1000, 'Eine Vorlage darf höchstens 1000 Teilaufgaben und Schritte enthalten.');
}

export function validateTaskRule(rule: TaskRule): void {
  requireValue(rule && typeof rule === 'object', 'Die Wiederholungsregel ist ungültig.');
  id(rule.id); dated(rule.startDate, 'Der Wiederholungsbeginn');
  requireValue(['daily', 'weekdays', 'weekly'].includes(rule.frequency) && typeof rule.paused === 'boolean', 'Die Wiederholung ist ungültig.');
  if (rule.endDate !== null) { dated(rule.endDate, 'Das Wiederholungsende'); requireValue(rule.endDate >= rule.startDate, 'Die Wiederholung endet vor ihrem Beginn.'); }
  timestamp(rule.createdAt); timestamp(rule.updatedAt);
  requireValue(Date.parse(rule.updatedAt) >= Date.parse(rule.createdAt), 'Die Änderung liegt vor der Erstellung der Regel.');
  const template = rule.template;
  requireValue(template && typeof template === 'object', 'Die Wiederholungsvorlage ist ungültig.');
  text(template.title, 500, 'Der Vorlagentitel', true); text(template.description, 200_000, 'Die Vorlagenbeschreibung');
  requireValue(template.priority === null || ['low', 'normal', 'high'].includes(template.priority), 'Die Vorlagenpriorität ist ungültig.');
  duration(template.estimatedMinutes, true); tags(template.tags);
  requireValue(template.dueOffsetDays === null || (Number.isInteger(template.dueOffsetDays) && Math.abs(template.dueOffsetDays) <= 36500), 'Der relative Fälligkeitstag ist ungültig.');
  validateSubtaskTemplates(template.subtasks);
  requireValue(Array.isArray(template.noteIds) && template.noteIds.length <= 10_000, 'Die Notizverknüpfungen der Regel sind ungültig.');
  template.noteIds.forEach(id); unique(template.noteIds, 'Die Notizverknüpfungen der Regel');
}

export function validateReminder(reminder: Reminder, explicitTime = false): void {
  requireValue(reminder && typeof reminder === 'object', 'Die Erinnerung ist ungültig.');
  id(reminder.id); text(reminder.title, 500, 'Der Erinnerungstitel', true);
  requireValue(typeof reminder.localStart === 'string' && /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(reminder.localStart) && isDate(reminder.localStart.slice(0, 10)), 'Der lokale Erinnerungsbeginn ist ungültig.');
  requireValue(isTimeZone(reminder.timeZone), 'Die Erinnerungszeitzone ist ungültig.');
  requireValue(['once', 'daily', 'weekly'].includes(reminder.frequency) && typeof reminder.enabled === 'boolean', 'Die Erinnerungsregel ist ungültig.');
  requireValue(reminder.taskId === null || typeof reminder.taskId === 'string', 'Die Aufgabenverknüpfung der Erinnerung ist ungültig.');
  requireValue(reminder.appointmentId === null || typeof reminder.appointmentId === 'string', 'Die Terminverknüpfung der Erinnerung ist ungültig.');
  requireValue(reminder.taskId === null || reminder.appointmentId === null, 'Eine Erinnerung darf höchstens eine Aufgabe oder einen Termin verknüpfen.');
  if (reminder.taskId !== null) id(reminder.taskId);
  if (reminder.appointmentId !== null) id(reminder.appointmentId);
  timestamp(reminder.createdAt); timestamp(reminder.updatedAt);
  requireValue(Date.parse(reminder.updatedAt) >= Date.parse(reminder.createdAt), 'Die Änderung liegt vor der Erstellung der Erinnerung.');
  if (explicitTime) localToInstant(reminder.localStart.slice(0, 10), reminder.localStart.slice(11, 16), reminder.timeZone);
}

export function validateReminderReceipt(receipt: ReminderReceipt): void {
  id(receipt.id); id(receipt.reminderId); timestamp(receipt.scheduledAt);
  requireValue(receipt.id === reminderOccurrenceId(receipt.reminderId, receipt.scheduledAt), 'Der Erinnerungsbeleg benötigt seine stabile Vorkommenskennung.');
  requireValue(['pending', 'done', 'dismissed'].includes(receipt.status), 'Der Erinnerungsbelegstatus ist ungültig.');
  if (receipt.snoozedUntil !== null) {
    timestamp(receipt.snoozedUntil);
    requireValue(Date.parse(receipt.snoozedUntil) > Date.parse(receipt.scheduledAt), 'Die spätere Erinnerung muss nach ihrem ursprünglichen Zeitpunkt liegen.');
  }
  if (receipt.notifiedAt !== null) timestamp(receipt.notifiedAt);
}

/** Semantic validation; note references are checked atomically by the repository. */
export function validatePlanning(data: PlanningData): void {
  const collections = [data.tasks, data.appointments, data.timeBlocks, data.days, data.weeks, data.operations];
  requireValue(collections.every(Array.isArray), 'Die Planung ist unvollständig.');
  const limits = [10_000, 10_000, 20_000, 2000, 1000, 10_000];
  requireValue(collections.every((items, index) => items.length <= limits[index]), 'Die Planung enthält zu viele Datensätze.');
  data.tasks.forEach(validateTask); data.appointments.forEach(validateAppointment); data.timeBlocks.forEach(validateTimeBlock);
  data.days.forEach(validateDay); data.weeks.forEach(validateWeek); validateSettings(data.settings);
  const rules = data.taskRules ?? []; const recurrenceReceipts = data.recurrenceReceipts ?? [];
  const reminders = data.reminders ?? []; const reminderReceipts = data.reminderReceipts ?? [];
  const morningRoutineReceipts = data.morningRoutineReceipts ?? [];
  requireValue(data.morningRoutineReceipts === undefined || Array.isArray(data.morningRoutineReceipts), 'Die Morgenroutinen-Belege sind ungültig.');
  requireValue(morningRoutineReceipts.length <= 100_000, 'Die Morgenroutine enthält zu viele Tagesbelege.');
  requireValue([data.taskRules, data.recurrenceReceipts, data.reminders, data.reminderReceipts].every((items) => items === undefined || Array.isArray(items)), 'Die Wiederholungen und Erinnerungen sind unvollständig.');
  requireValue([rules, recurrenceReceipts, reminders, reminderReceipts].every(Array.isArray), 'Die Wiederholungen und Erinnerungen sind unvollständig.');
  requireValue(rules.length <= 10_000 && recurrenceReceipts.length <= 100_000 && reminders.length <= 10_000 && reminderReceipts.length <= 100_000, 'Die Wiederholungen oder Erinnerungen enthalten zu viele Datensätze.');
  rules.forEach(validateTaskRule); reminders.forEach((reminder) => validateReminder(reminder)); reminderReceipts.forEach(validateReminderReceipt);
  unique(rules.map((rule) => rule.id), 'Die Wiederholungsregeln'); unique(reminders.map((reminder) => reminder.id), 'Die Erinnerungen');
  unique(reminderReceipts.map((receipt) => receipt.id), 'Die Erinnerungsbelege');
  unique(reminderReceipts.map((receipt) => `${receipt.reminderId}\u0000${Date.parse(receipt.scheduledAt)}`), 'Die Erinnerungsvorkommen');
  unique(recurrenceReceipts.map((receipt) => `${receipt.ruleId}\u0000${receipt.date}`), 'Die Wiederholungsvorkommen');
  unique(recurrenceReceipts.map((receipt) => receipt.taskId), 'Die Wiederholungsaufgaben');
  for (const receipt of morningRoutineReceipts) {
    requireValue(receipt && typeof receipt === 'object', 'Der Morgenroutinen-Beleg ist ungültig.');
    dated(receipt.date, 'Der Morgenroutinen-Tag'); id(receipt.taskId);
    requireValue(typeof receipt.skipped === 'boolean', 'Der Überspringen-Status der Morgenroutine ist ungültig.');
  }
  unique(morningRoutineReceipts.map((receipt) => receipt.date), 'Die Morgenroutinen-Tage');
  unique(morningRoutineReceipts.map((receipt) => receipt.taskId), 'Die Morgenroutinen-Aufgaben');
  unique([...data.tasks, ...data.appointments, ...data.timeBlocks, ...data.operations, ...rules, ...reminders, ...reminderReceipts].map((item) => item.id), 'Die Planung');
  unique(data.days.map((day) => day.date), 'Die Tagesplanung'); unique(data.weeks.map((week) => week.weekStart), 'Die Wochenplanung');
  const tasks = new Set(data.tasks.map((task) => task.id));
  const appointments = new Set(data.appointments.map((appointment) => appointment.id));
  const ruleIds = new Set(rules.map((rule) => rule.id));
  const taskMap = new Map(data.tasks.map((task) => [task.id, task]));
  const recurrenceByTask = new Map(recurrenceReceipts.map((receipt) => [receipt.taskId, receipt]));
  const morningRoutineByTask = new Map(morningRoutineReceipts.map((receipt) => [receipt.taskId, receipt]));
  for (const receipt of morningRoutineReceipts) {
    const task = taskMap.get(receipt.taskId);
    requireValue(!task || task.morningRoutineDate === receipt.date, 'Ein Morgenroutinen-Beleg passt nicht zu seiner Aufgabe.');
  }
  for (const task of data.tasks) if (task.morningRoutineDate !== undefined) {
    const receipt = morningRoutineByTask.get(task.id);
    requireValue(receipt && receipt.date === task.morningRoutineDate, 'Der Morgenroutine fehlt ihr dauerhafter Tagesbeleg.');
  }
  for (const receipt of recurrenceReceipts) {
    id(receipt.ruleId); id(receipt.taskId); dated(receipt.date, 'Das Wiederholungsvorkommen');
    requireValue(ruleIds.has(receipt.ruleId), 'Ein Wiederholungsbeleg verweist auf eine nicht vorhandene Regel.');
    const task = taskMap.get(receipt.taskId);
    requireValue(!task || (task.ruleId === receipt.ruleId && task.occurrenceDate === receipt.date), 'Ein Wiederholungsbeleg passt nicht zu seiner Aufgabe.');
  }
  for (const task of data.tasks) if (task.ruleId !== undefined) {
    requireValue(ruleIds.has(task.ruleId), 'Eine Aufgabe verweist auf eine nicht vorhandene Wiederholungsregel.');
    const receipt = recurrenceByTask.get(task.id);
    requireValue(receipt && receipt.ruleId === task.ruleId && receipt.date === task.occurrenceDate, 'Der Aufgabe fehlt ihr dauerhafter Wiederholungsbeleg.');
  }
  for (const reminder of reminders) {
    requireValue(reminder.taskId === null || tasks.has(reminder.taskId), 'Eine Erinnerung verweist auf eine nicht vorhandene Aufgabe.');
    requireValue(reminder.appointmentId === null || appointments.has(reminder.appointmentId), 'Eine Erinnerung verweist auf einen nicht vorhandenen Termin.');
  }
  for (const block of data.timeBlocks) requireValue(tasks.has(block.taskId), 'Ein Zeitblock verweist auf eine nicht vorhandene Aufgabe.');
  for (const day of data.days) for (const taskId of day.priorityTaskIds) requireValue(tasks.has(taskId), 'Eine Tagespriorität verweist auf eine nicht vorhandene Aufgabe.');
  const receiptTasks = new Set<string>();
  const receiptBlocks = new Set<string>();
  const blocks = new Map(data.timeBlocks.map((block) => [block.id, block]));
  for (const operation of data.operations) {
    id(operation.id); timestamp(operation.createdAt); timestamp(operation.updatedAt);
    requireValue(Date.parse(operation.updatedAt) >= Date.parse(operation.createdAt), 'Die Änderung liegt vor der Erstellung der Erfassung.');
    requireValue(operation.status === 'applied' || operation.status === 'undone', 'Der Erfassungsstatus ist ungültig.');
    requireValue(Array.isArray(operation.items) && operation.items.length <= 10_000, 'Die Erfassungsbelege sind ungültig.');
    unique(operation.items.map((item) => item.itemId), 'Die Erfassungsbelege');
    unique(operation.items.map((item) => item.taskId), 'Die erfassten Aufgaben');
    for (const receipt of operation.items) {
      id(receipt.itemId); id(receipt.taskId); timestamp(receipt.appliedUpdatedAt);
      requireValue(!receiptTasks.has(receipt.taskId), 'Eine Aufgabe wird von mehreren Erfassungsbelegen beansprucht.');
      receiptTasks.add(receipt.taskId);
      requireValue(Array.isArray(receipt.blockIds) && receipt.blockIds.length <= 20_000, 'Die Zeitblockbelege sind ungültig.');
      receipt.blockIds.forEach(id); unique(receipt.blockIds, 'Die Zeitblockbelege');
      for (const blockId of receipt.blockIds) {
        requireValue(!receiptBlocks.has(blockId), 'Ein Zeitblock wird von mehreren Erfassungsbelegen beansprucht.');
        receiptBlocks.add(blockId);
        const block = blocks.get(blockId);
        requireValue(!block || block.taskId === receipt.taskId, 'Ein Zeitblockbeleg verweist auf eine andere Aufgabe.');
      }
      // Receipts deliberately survive deletion and undo as idempotency tombstones.
    }
  }
}

/** Return actionable unresolved questions instead of guessing missing information. */
export function validateCaptureItem(item: CaptureItem, zone = 'Europe/Berlin'): string[] {
  const questions = Array.isArray(item.questions) ? [...item.questions] : ['Die Rückfragen sind ungültig.'];
  const check = (condition: unknown, question: string) => { if (!condition) questions.push(question); };
  check(item.intent === 'create', 'Änderungen und Löschungen müssen ausdrücklich in der betroffenen Aufgabe vorgenommen werden.');
  check(typeof item.itemId === 'string' && !!item.itemId.trim() && item.itemId.length <= 128 && !/[\u0000-\u001f\u007f]/.test(item.itemId), 'Die Erfassung benötigt eine gültige Kennung.');
  check(typeof item.title === 'string' && !!item.title.trim() && item.title.length <= 500, 'Wie lautet der Titel der Aufgabe?');
  check(typeof item.description === 'string' && item.description.length <= 200_000, 'Bitte kürze die Aufgabenbeschreibung.');
  check(item.priority === null || ['low', 'normal', 'high'].includes(item.priority), 'Welche Priorität soll die Aufgabe haben?');
  check(item.estimatedMinutes === null || (Number.isInteger(item.estimatedMinutes) && item.estimatedMinutes! > 0 && item.estimatedMinutes! <= 1440), 'Wie viele Minuten dauert die Aufgabe (1–1440)?');
  check(item.dueDate === null || isDate(item.dueDate), 'An welchem gültigen Datum ist die Aufgabe fällig?');
  check(item.plannedDate === null || isDate(item.plannedDate), 'Für welchen gültigen Tag soll die Aufgabe geplant werden?');
  check(item.plannedWeek === null || (isDate(item.plannedWeek) && startOfWeek(item.plannedWeek) === item.plannedWeek), 'Welche am Montag beginnende Woche ist gemeint?');
  check(!(item.plannedDate !== null && item.plannedWeek !== null), 'Soll die Aufgabe einem Tag oder dem Wochenpool zugeordnet werden?');
  check(Array.isArray(item.suggestions) && item.suggestions.every((suggestion) => typeof suggestion === 'string' && suggestion.length <= 10_000), 'Die Vorschläge sind ungültig oder zu lang.');
  if (typeof item.description === 'string' && Array.isArray(item.suggestions) && item.suggestions.every((suggestion) => typeof suggestion === 'string')) {
    check([item.description, ...item.suggestions.map((suggestion) => `Vorschlag: ${suggestion}`)].filter(Boolean).join('\n\n').length <= 200_000,
      'Bitte kürze Beschreibung und Vorschläge zusammen auf höchstens 200.000 Zeichen.');
  }
  if (item.startTime !== null || item.durationMinutes !== null) {
    check(isDate(item.plannedDate), 'An welchem Tag beginnt der Zeitblock?');
    check(typeof item.startTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(item.startTime), 'Um wie viel Uhr beginnt der Zeitblock?');
    check(Number.isInteger(item.durationMinutes) && item.durationMinutes! > 0 && item.durationMinutes! <= 1440, 'Wie viele Minuten dauert der Zeitblock (1–1440)?');
    if (isDate(item.plannedDate) && typeof item.startTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(item.startTime)) {
      try { localToInstant(item.plannedDate, item.startTime, zone); }
      catch (error) { questions.push(error instanceof Error ? error.message : 'Die lokale Uhrzeit ist nicht eindeutig.'); }
    }
  }
  return [...new Set(questions)];
}
