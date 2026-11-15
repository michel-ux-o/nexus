import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Save, Trash2 } from 'lucide-react';
import type { Note } from '../../types';
import type { Planner, Priority, RecurrenceFrequency, Reminder, Subtask, Task, TaskPlan, TaskRule, TaskSaveOptions, TaskStatus } from '../types';
import { addDays, formatDate, isDate, localToInstant, startOfWeek, todayInZone } from '../dates';
import { DeleteConfirmation, errorMessage, PlanningDialog, SaveFailure } from './PlanningDialog';
import { calendarDayDifference, taskTags } from './formValues';
import { SubtaskEditor } from './SubtaskEditor';
import './FormPolish.css';

export interface TaskDialogProps {
  planner: Planner;
  notes: Note[];
  task?: Task;
  defaults?: Partial<Task>;
  onClose: () => void;
}

interface TaskDraft {
  id: string; createdAt: string; title: string; description: string; status: TaskStatus;
  priority: Priority; estimatedMinutes: string; dueDate: string; planKind: 'none' | 'day' | 'week';
  plannedDate: string; plannedWeek: string; subtasks: Subtask[]; noteIds: string[]; tags: string;
}

function initialDraft(task: Task | undefined, defaults: Partial<Task> | undefined, zone: string): TaskDraft {
  const source = task ?? defaults;
  const today = todayInZone(zone);
  return {
    id: task?.id ?? crypto.randomUUID(), createdAt: task?.createdAt ?? new Date().toISOString(),
    title: source?.title ?? '', description: source?.description ?? '', status: source?.status ?? 'open', priority: source?.priority ?? null,
    estimatedMinutes: source?.estimatedMinutes == null ? '' : String(source.estimatedMinutes), dueDate: source?.dueDate ?? '',
    planKind: source?.plan?.kind ?? 'none', plannedDate: source?.plan?.kind === 'day' ? source.plan.date : today,
    plannedWeek: source?.plan?.kind === 'week' ? source.plan.weekStart : startOfWeek(today),
    subtasks: structuredClone(source?.subtasks ?? []), noteIds: [...(source?.noteIds ?? [])], tags: (source?.tags ?? []).join(', '),
  };
}

function planFromDraft(draft: TaskDraft): TaskPlan {
  if (draft.planKind === 'day') return { kind: 'day', date: draft.plannedDate };
  if (draft.planKind === 'week') return { kind: 'week', weekStart: startOfWeek(draft.plannedWeek) };
  return null;
}

export function TaskDialog({ planner, notes, task, defaults, onClose }: TaskDialogProps) {
  const prefix = useId();
  const [draft, setDraft] = useState(() => initialDraft(task, defaults, planner.data.settings.timeZone));
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [noteSearch, setNoteSearch] = useState('');
  const [validation, setValidation] = useState('');
  const [moreOptions, setMoreOptions] = useState(Boolean((task ?? defaults)?.description || (task ?? defaults)?.subtasks?.length || (task ?? defaults)?.noteIds?.length));
  const [initialRule] = useState(() => planner.data.taskRules?.find((rule) => rule.id === task?.ruleId));
  const [initialReminder] = useState(() => planner.data.reminders?.find((reminder) => reminder.taskId === task?.id));
  const [ruleIdentity] = useState(() => ({ id: initialRule?.id ?? crypto.randomUUID(), createdAt: initialRule?.createdAt ?? new Date().toISOString() }));
  const [reminderIdentity] = useState(() => ({ id: initialReminder?.id ?? crypto.randomUUID(), createdAt: initialReminder?.createdAt ?? new Date().toISOString() }));
  const [frequency, setFrequency] = useState<RecurrenceFrequency | ''>(initialRule?.frequency ?? '');
  const [ruleStart, setRuleStart] = useState(initialRule?.startDate ?? draft.plannedDate);
  const [ruleEnd, setRuleEnd] = useState(initialRule?.endDate ?? '');
  const [paused, setPaused] = useState(initialRule?.paused ?? false);
  const [ruleDirty, setRuleDirty] = useState(false);
  const [updateTemplate, setUpdateTemplate] = useState(false);
  const [reminderEnabled, setReminderEnabled] = useState(Boolean(initialReminder?.enabled));
  const [reminderTime, setReminderTime] = useState(initialReminder?.localStart ?? '');
  const [reminderDirty, setReminderDirty] = useState(false);
  const [reminderOpen, setReminderOpen] = useState(Boolean(initialReminder?.enabled));
  const [recurrenceOpen, setRecurrenceOpen] = useState(Boolean(initialRule));

  function patch(values: Partial<TaskDraft>) {
    setDraft((current) => ({ ...current, ...values })); setValidation('');
    if (!initialRule && values.plannedDate !== undefined) setRuleStart(values.plannedDate);
  }

  let planChanged = false;
  try { planChanged = Boolean(task) && JSON.stringify(task?.plan) !== JSON.stringify(planFromDraft(draft)); } catch { /* Invalid dates are shown before saving. */ }
  const affectedBlocks = planChanged ? planner.data.timeBlocks.filter((block) => block.taskId === task?.id).length : 0;
  const filteredNotes = [...notes].sort((a, b) => Number(Boolean(a.deletedAt)) - Number(Boolean(b.deletedAt)))
    .filter((note) => `${note.title} ${note.tags.join(' ')}`.toLocaleLowerCase('de').includes(noteSearch.toLocaleLowerCase('de')));
  const missingNoteIds = draft.noteIds.filter((id) => !notes.some((note) => note.id === id));
  const linkedReminderCount = planner.data.reminders?.filter((reminder) => reminder.taskId === task?.id).length ?? 0;

  function validate(): string {
    if (!draft.title.trim()) return 'Gib der Aufgabe einen Titel.';
    if (draft.estimatedMinutes !== '' && (!Number.isInteger(Number(draft.estimatedMinutes)) || Number(draft.estimatedMinutes) < 1 || Number(draft.estimatedMinutes) > 1440)) return 'Die geschätzte Dauer muss zwischen 1 und 1.440 ganzen Minuten liegen oder leer bleiben.';
    if (draft.dueDate && !isDate(draft.dueDate)) return 'Wähle ein gültiges Fälligkeitsdatum oder lasse es leer.';
    if (draft.planKind === 'day' && !isDate(draft.plannedDate)) return 'Wähle einen gültigen Bearbeitungstag.';
    if (draft.planKind === 'week' && !isDate(draft.plannedWeek)) return 'Wähle eine gültige Planungswoche.';
    if (draft.subtasks.some((item) => !item.title.trim() || item.children?.some(child => !child.title.trim()))) return 'Gib jeder Unteraufgabe und jedem Schritt einen Titel oder entferne den leeren Eintrag.';
    if (taskTags(draft.tags).length > 20 || taskTags(draft.tags).some((tag) => tag.length > 64)) return 'Verwende höchstens 20 Tags mit jeweils höchstens 64 Zeichen.';
    if (frequency && (ruleDirty || !initialRule || updateTemplate)) {
      if (!initialRule && draft.planKind !== 'day') return 'Wähle für den Beginn der Wiederholung ausdrücklich einen Bearbeitungstag.';
      if (!isDate(ruleStart)) return 'Wähle ein gültiges Anfangsdatum für die Wiederholung.';
      if (ruleEnd && (!isDate(ruleEnd) || ruleEnd < ruleStart)) return 'Das Ende der Wiederholung muss am oder nach dem Anfang liegen.';
    }
    if (reminderDirty && reminderEnabled) {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(reminderTime)) return 'Wähle Datum und Uhrzeit der Erinnerung.';
      try { localToInstant(reminderTime.slice(0, 10), reminderTime.slice(11), initialReminder?.timeZone ?? planner.data.settings.timeZone); }
      catch (cause) { return errorMessage(cause); }
    }
    return '';
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const invalid = validate();
    if (invalid) { setMoreOptions(true); setReminderOpen(true); setRecurrenceOpen(true); setValidation(invalid); return; }
    setError(''); setBusy('save');
    try {
      const now = new Date().toISOString();
      const savedTask: Task = {
        id: draft.id, createdAt: draft.createdAt, updatedAt: new Date().toISOString(),
        title: draft.title.trim(), description: draft.description, status: draft.status, priority: draft.priority,
        estimatedMinutes: draft.estimatedMinutes === '' ? null : Number(draft.estimatedMinutes), dueDate: draft.dueDate || null,
        plan: planFromDraft(draft), subtasks: draft.subtasks.map((item) => ({
          ...item, title: item.title.trim(),
          ...(item.children?.length ? { children: item.children.map(child => ({ ...child, title: child.title.trim() })), done: item.children.every(child => child.done) } : {}),
        })), noteIds: [...draft.noteIds], tags: taskTags(draft.tags),
        ...(task?.ruleId ? { ruleId: task.ruleId } : {}), ...(task?.occurrenceDate ? { occurrenceDate: task.occurrenceDate } : {}),
        ...(task?.morningRoutineDate ? { morningRoutineDate: task.morningRoutineDate } : {}),
      };
      const options: TaskSaveOptions = {};
      if (ruleDirty || updateTemplate) {
        if (!frequency) options.rule = null;
        else {
          const template: TaskRule['template'] = initialRule && !updateTemplate ? initialRule.template : {
            title: savedTask.title, description: savedTask.description, priority: savedTask.priority,
            estimatedMinutes: savedTask.estimatedMinutes, tags: savedTask.tags ?? [], noteIds: [...savedTask.noteIds],
            subtasks: savedTask.subtasks.map(({ title, suggestion, children }) => ({ title, suggestion, ...(children?.length ? { children: children.map(child => ({ title: child.title, suggestion: child.suggestion })) } : {}) })),
            dueOffsetDays: savedTask.dueDate ? calendarDayDifference(task?.occurrenceDate ?? ruleStart, savedTask.dueDate) : null,
          };
          options.rule = { ...ruleIdentity, frequency, startDate: initialRule ? ruleStart : draft.plannedDate, endDate: ruleEnd || null, paused, template, updatedAt: now };
        }
      }
      if (reminderDirty) options.reminder = reminderEnabled ? {
        ...reminderIdentity, title: initialReminder?.title ?? savedTask.title, localStart: reminderTime,
        timeZone: initialReminder?.timeZone ?? planner.data.settings.timeZone, frequency: initialReminder?.frequency ?? 'once',
        enabled: true, taskId: savedTask.id, appointmentId: null, updatedAt: now,
      } satisfies Reminder : null;
      await planner.saveTask(savedTask, options);
      onClose();
    } catch (cause) { setError(errorMessage(cause)); setBusy(null); }
  }

  async function deleteTask() {
    if (!task || busy) return;
    setBusy('delete'); setError('');
    try { await planner.deleteTask(task.id); onClose(); }
    catch (cause) { setError(errorMessage(cause)); setBusy(null); }
  }

  const backup = `NEXUS – Aufgabenentwurf\nNoch nicht bestätigt gespeichert.\n\n${JSON.stringify({ ...draft, ruleId: task?.ruleId, occurrenceDate: task?.occurrenceDate, recurrence: { ...ruleIdentity, frequency, ruleStart, ruleEnd, paused, ruleDirty, updateTemplate }, reminder: { ...reminderIdentity, reminderEnabled, reminderTime, reminderDirty, timeZone: initialReminder?.timeZone ?? planner.data.settings.timeZone } }, null, 2)}`;
  return <PlanningDialog title={task ? 'Aufgabe bearbeiten' : 'Neue Aufgabe'} eyebrow="AUFGABEN & PLANUNG" busy={Boolean(busy)} onClose={onClose} onSubmit={(event) => void save(event)}
    footer={<>
      {task && <button type="button" className="danger-button planning-delete-trigger" disabled={Boolean(busy)} onClick={() => setConfirmDelete(true)}><Trash2 size={16} aria-hidden="true" /> Aufgabe löschen</button>}
      <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={onClose}>Abbrechen</button>
      <button type="submit" className="primary-button" disabled={Boolean(busy) || planner.loading || Boolean(planner.loadError)}><Save size={16} aria-hidden="true" /> {busy === 'save' ? 'Wird gespeichert …' : error ? 'Erneut speichern' : 'Aufgabe speichern'}</button>
    </>}>
    <fieldset className="planning-inputs task-dialog-inputs" disabled={Boolean(busy)}>
      <label className="field" htmlFor={`${prefix}-title`}><span>Titel</span><input id={`${prefix}-title`} required maxLength={500} autoFocus value={draft.title} onChange={(event) => patch({ title: event.target.value })} placeholder="Was möchtest du erledigen?" /></label>
      <fieldset className="planning-fieldset">
        <legend>Planung · wann möchtest du daran arbeiten?</legend>
        <label className="field"><span>Einplanung</span><select aria-label="Einplanung" value={draft.planKind} onChange={(event) => patch({ planKind: event.target.value as TaskDraft['planKind'] })}><option value="none">Noch nicht eingeplant · Aufgabenpool</option><option value="day">An einem bestimmten Tag</option><option value="week">In einer bestimmten Woche</option></select></label>
        {draft.planKind === 'day' && <label className="field"><span>Geplanter Bearbeitungstag</span><input type="date" required value={draft.plannedDate} onChange={(event) => patch({ plannedDate: event.target.value })} /></label>}
      {draft.planKind === 'week' && <fieldset className="planning-fieldset"><legend>Wochenzuordnung</legend>
        <label className="field"><span>Planungswoche · einen Tag der Woche wählen</span><input type="date" required value={draft.plannedWeek} onChange={(event) => patch({ plannedWeek: isDate(event.target.value) ? startOfWeek(event.target.value) : event.target.value })} /></label>
        {isDate(draft.plannedWeek) && <p className="planning-help">Montag, {formatDate(startOfWeek(draft.plannedWeek))} bis Sonntag, {formatDate(addDays(startOfWeek(draft.plannedWeek), 6))}.</p>}
      </fieldset>}
        <p className="planning-help">Planung und Fälligkeit sind unabhängig. Ein anderer Bearbeitungstag verändert das Fälligkeitsdatum nicht.</p>
        {affectedBlocks > 0 && <p className="planning-warning" role="status">{draft.planKind === 'none' || (draft.planKind === 'week' && task?.plan?.kind !== 'week')
          ? `Beim Verschieben in den ${draft.planKind === 'week' ? 'Wochenpool' : 'Eingang'} werden ${affectedBlocks === 1 ? 'der vorhandene Zeitblock' : `alle ${affectedBlocks} vorhandenen Zeitblöcke`} entfernt, weil es dort keinen konkreten Zieltag gibt.`
          : `${affectedBlocks === 1 ? 'Der vorhandene Zeitblock wird' : `Alle ${affectedBlocks} vorhandenen Zeitblöcke werden`} um die gleiche Kalenderdifferenz mitverschoben. Lokale Uhrzeiten und Dauer bleiben erhalten. Bei einer ungültigen Zielzeit wird nichts verschoben.`} Das Fälligkeitsdatum bleibt erhalten.</p>}
      </fieldset>
        <label className="field"><span>Fälligkeitsdatum · optional</span><input type="date" value={draft.dueDate} onChange={(event) => patch({ dueDate: event.target.value })} /></label>
        <label className="field"><span>Geschätzte Dauer in Minuten · optional</span><input type="number" inputMode="numeric" min="1" max="1440" step="1" value={draft.estimatedMinutes} onChange={(event) => patch({ estimatedMinutes: event.target.value })} placeholder="Keine Schätzung" /></label>
      <div className="planning-two-columns">
        <label className="field"><span>Status</span><select aria-label="Status" value={draft.status} onChange={(event) => patch({ status: event.target.value as TaskStatus })}><option value="open">Offen</option><option value="progress">In Bearbeitung</option><option value="done">Erledigt</option></select></label>
        <label className="field"><span>Priorität</span><select aria-label="Priorität" value={draft.priority ?? ''} onChange={(event) => patch({ priority: (event.target.value || null) as Priority })}><option value="">Keine Priorität</option><option value="low">Niedrig</option><option value="normal">Normal</option><option value="high">Hoch</option></select></label>
      </div>
      <details className="planning-more-options" open={reminderOpen} onToggle={(event) => setReminderOpen(event.currentTarget.open)} onInvalidCapture={(event) => { event.currentTarget.open = true; setReminderOpen(true); }}>
        <summary>Erinnerung <span>{reminderEnabled ? `Aktiv${reminderTime ? ` · ${reminderTime.replace('T', ' ')}` : ''}` : 'Keine Erinnerung aktiv'}</span></summary>
        <div className="planning-more-body">
        <label className="planning-check"><input type="checkbox" checked={reminderEnabled} onChange={(event) => { setReminderEnabled(event.target.checked); setReminderDirty(true); setValidation(''); }} /><span>{linkedReminderCount > 1 ? 'Verknüpfte Erinnerungen beibehalten' : 'An diese Aufgabe erinnern'}</span></label>
        {reminderEnabled && <label className="field"><span>Erinnerungszeit</span><input type="datetime-local" step="60" required value={reminderTime} onChange={(event) => { setReminderTime(event.target.value); setReminderDirty(true); setValidation(''); }} /></label>}
        {reminderEnabled && <p className="planning-help">Ortszeit in {initialReminder?.timeZone ?? planner.data.settings.timeZone}.{initialReminder?.frequency === 'daily' ? ' Diese Erinnerung wiederholt sich täglich.' : initialReminder?.frequency === 'weekly' ? ' Diese Erinnerung wiederholt sich wöchentlich.' : ''} Erinnerungen erscheinen, während NEXUS geöffnet ist.</p>}
        {linkedReminderCount > 1 && <p className="planning-help">Die erste Erinnerungszeit wird hier bearbeitet. Weitere Erinnerungen findest du im Bereich Erinnerungen. Ausschalten entfernt alle Erinnerungen dieser Aufgabe.</p>}
        </div>
      </details>
      <details className="planning-more-options" open={recurrenceOpen} onToggle={(event) => setRecurrenceOpen(event.currentTarget.open)} onInvalidCapture={(event) => { event.currentTarget.open = true; setRecurrenceOpen(true); }}>
        <summary>Wiederholung <span>{frequency ? `${frequency === 'daily' ? 'Täglich' : frequency === 'weekdays' ? 'Werktags' : 'Wöchentlich'}${paused ? ' · pausiert' : ''}${ruleStart ? ` · ab ${ruleStart}` : ''}${ruleEnd ? ` · bis ${ruleEnd}` : ''}` : 'Keine Wiederholung'}</span></summary>
        <div className="planning-more-body">
        <label className="field"><span>Aufgabe wiederholen</span><select value={frequency} onChange={(event) => { setFrequency(event.target.value as RecurrenceFrequency | ''); setRuleDirty(true); setValidation(''); }}><option value="">Keine Wiederholung</option><option value="daily">Täglich</option><option value="weekdays">Werktags · Montag bis Freitag</option><option value="weekly">Wöchentlich</option></select></label>
        {frequency && <>
          <div className="planning-two-columns">
            <label className="field"><span>Wiederholung ab</span><input type="date" required value={initialRule ? ruleStart : draft.planKind === 'day' ? draft.plannedDate : ''} onChange={(event) => { setRuleStart(event.target.value); if (!initialRule) patch({ planKind: 'day', plannedDate: event.target.value }); setRuleDirty(true); setValidation(''); }} /></label>
            <label className="field"><span>Wiederholung bis · optional</span><input type="date" min={ruleStart || undefined} value={ruleEnd} onChange={(event) => { setRuleEnd(event.target.value); setRuleDirty(true); setValidation(''); }} /></label>
          </div>
          <label className="planning-check"><input type="checkbox" checked={paused} onChange={(event) => { setPaused(event.target.checked); setRuleDirty(true); }} /><span>Wiederholungsregel pausieren</span></label>
          {initialRule && <label className="planning-check"><input type="checkbox" checked={updateTemplate} onChange={(event) => setUpdateTemplate(event.target.checked)} /><span>Aktuelle Aufgabenfelder für künftige Vorkommen übernehmen</span></label>}
          <p className="planning-help">Jedes Vorkommen ist eine eigene Aufgabe. Regeländerungen gelten für neue Vorkommen; vorhandene Aufgaben behalten Status, Frist und Planung.{task?.occurrenceDate ? ` Dieses Vorkommen gehört zum ${formatDate(task.occurrenceDate)}.` : ''}</p>
        </>}
        {initialRule && !frequency && <p className="planning-help">Beim Speichern wird die Regel pausiert. Die Zuordnung dieses Vorkommens bleibt erhalten.</p>}
        </div>
      </details>
      <details className="planning-more-options" open={moreOptions} onToggle={(event) => setMoreOptions(event.currentTarget.open)} onInvalidCapture={(event) => { event.currentTarget.open = true; setMoreOptions(true); }}>
        <summary>Weitere Optionen <span>Beschreibung, Tags, Unteraufgaben und Notizen</span></summary>
        <div className="planning-more-body">
      <label className="field"><span>Beschreibung · optional</span><textarea rows={4} maxLength={100000} value={draft.description} onChange={(event) => patch({ description: event.target.value })} /></label>
      <label className="field"><span>Aufgaben-Tags · mit Komma trennen</span><input maxLength={1318} value={draft.tags} onChange={(event) => patch({ tags: event.target.value })} placeholder="z. B. Arbeit, Privat" /></label>
      <SubtaskEditor value={draft.subtasks} onChange={subtasks => patch({ subtasks })} disabled={Boolean(busy)} />
      <fieldset className="planning-fieldset"><legend>Verknüpfte Notizen</legend>
        <p className="planning-help">Ausgewählte Notizen werden verknüpft. Ihr Text wird durch dieses Formular nicht verändert.</p>
        {notes.length > 6 && <label className="field"><span>Notizen nach Titel oder Tags filtern</span><input type="search" value={noteSearch} onChange={(event) => setNoteSearch(event.target.value)} /></label>}
        <div className="planning-note-options">{filteredNotes.map((note) => <label className="planning-check planning-note-option" key={note.id}>
          <input type="checkbox" checked={draft.noteIds.includes(note.id)} onChange={(event) => patch({ noteIds: event.target.checked ? [...draft.noteIds, note.id] : draft.noteIds.filter((id) => id !== note.id) })} />
          <span>{note.title.trim() || 'Unbenannte Notiz'}{note.deletedAt && <small>Im Papierkorb · Verknüpfung bleibt erhalten</small>}</span>
        </label>)}</div>
        {filteredNotes.length === 0 && <p className="planning-help">{notes.length === 0 ? 'Noch keine Notizen vorhanden.' : 'Keine Notiz passt zu diesem Filter.'}</p>}
        {missingNoteIds.map((id) => <label className="planning-check" key={id}><input type="checkbox" checked onChange={() => patch({ noteIds: draft.noteIds.filter((noteId) => noteId !== id) })} /><span>Nicht mehr verfügbare Notiz · Verknüpfung entfernen</span></label>)}
        <p className="planning-help">{draft.noteIds.length} {draft.noteIds.length === 1 ? 'Notiz verknüpft' : 'Notizen verknüpft'}.</p>
      </fieldset>
        </div>
      </details>
    </fieldset>
    {validation && <p className="planning-warning" role="alert">{validation}</p>}
    <SaveFailure error={error} draft={backup} filename="nexus-aufgabenentwurf" />
    {confirmDelete && <DeleteConfirmation noun="Aufgabe" details="Zugehörige Zeitblöcke und Tagesprioritäten werden ebenfalls entfernt. Verknüpfte Notizen bleiben erhalten." busy={Boolean(busy)} onCancel={() => setConfirmDelete(false)} onConfirm={() => void deleteTask()} />}
    <p className="planning-operation-status" role="status">{busy === 'save' ? 'Wird gespeichert. Bitte warte auf den Abschluss.' : busy === 'delete' ? 'Wird gelöscht. Bitte warte auf den Abschluss.' : 'Änderungen werden erst mit „Aufgabe speichern“ übernommen.'}</p>
  </PlanningDialog>;
}
