import type { Note } from '../types';
import { addDays, localToInstant, startOfWeek, todayInZone } from '../planning/dates';
import { emptyPlanning, type PlanningData, type Task } from '../planning/types';

/** Create fresh fictional data only; the caller owns the atomic write and empty-workspace check. */
export function createDemoWorkspace(now = new Date()): { notes: Note[]; planning: PlanningData } {
  const at = now.toISOString();
  const planning = emptyPlanning();
  const zone = planning.settings.timeZone;
  const today = todayInZone(zone, now);
  const tomorrow = addDays(today, 1);
  const notes: Note[] = [
    { id: 'demo-note-start', title: 'Willkommen in deinem Beispiel-Arbeitsbereich', content: '# Ein ruhiger Ort für deine Gedanken\n\nDies sind ausdrücklich fiktive Beispieldaten. Du kannst alles bearbeiten oder löschen.\n\n- Sammle Ideen unter Notizen.\n- Plane Aufgaben unabhängig von ihrer Fälligkeit.\n- Reserviere in der Tagesplanung Zeit für das Wesentliche.\n\nEine JSON-Sicherung überträgt den vollständigen Arbeitsbereich. Deine Daten bleiben lokal in diesem Browser.', tags: ['Beispiel', 'Start'], pinned: true, createdAt: at, updatedAt: at, deletedAt: null, revisions: [] },
    { id: 'demo-note-project', title: 'Beispielprojekt · eine kleine Idee', content: '# Ein freier Nachmittag\n\nFiktive Idee: Eine kleine Leseecke gestalten.\n\n## Nächste Schritte\n- Einen guten Platz auswählen\n- Vorhandene Dinge sichten\n- Eine Skizze machen\n\nDiese Notiz ist mit einer Beispielaufgabe verknüpft.', tags: ['Beispiel', 'Idee'], pinned: false, createdAt: at, updatedAt: at, deletedAt: null, revisions: [] },
  ];
  const base = (id: string, title: string, patch: Partial<Task> = {}): Task => ({ id, title, description: 'Fiktive Beispielaufgabe – frei bearbeitbar.', status: 'open', priority: 'normal', estimatedMinutes: 30, dueDate: null, plan: null, subtasks: [], noteIds: [], tags: ['Beispiel'], createdAt: at, updatedAt: at, ...patch });
  planning.tasks = [
    base('demo-task-idea', 'Eine Idee in Ruhe ausarbeiten', { priority: 'high', estimatedMinutes: 45, plan: { kind: 'day', date: today }, dueDate: tomorrow, noteIds: ['demo-note-project'], subtasks: [{ id: 'demo-subtask-sketch', title: 'Eine erste Skizze anlegen', done: false, suggestion: false }, { id: 'demo-subtask-review', title: 'Nächsten Schritt festhalten', done: false, suggestion: false }] }),
    base('demo-task-review', 'Kurz auf den Tag schauen', { estimatedMinutes: 10, plan: { kind: 'day', date: today }, ruleId: 'demo-rule-review', occurrenceDate: today }),
    base('demo-task-week', 'Zeit für etwas Schönes finden', { priority: 'low', plan: { kind: 'week', weekStart: startOfWeek(today) }, estimatedMinutes: 60 }),
    base('demo-task-inbox', 'Einen neuen Gedanken festhalten', { estimatedMinutes: null }),
    base('demo-task-done', 'Den Beispiel-Arbeitsbereich entdecken', { status: 'done', plan: { kind: 'day', date: today }, estimatedMinutes: 5 }),
  ];
  planning.appointments = [
    { id: 'demo-appointment-break', title: 'Beispiel · eine kleine Pause', description: 'Fiktiver Termin zum Erkunden des Kalenders.', startAt: localToInstant(today, '14:00', zone), durationMinutes: 30, createdAt: at, updatedAt: at },
    { id: 'demo-appointment-day', title: 'Beispiel · freier Ideentag', description: 'Fiktiver ganztägiger Eintrag. Er belegt keine Stundenkapazität.', startAt: localToInstant(tomorrow, '12:00', zone), durationMinutes: 1, allDay: { startDate: tomorrow, endDate: addDays(tomorrow, 1) }, createdAt: at, updatedAt: at },
  ];
  planning.timeBlocks = [{ id: 'demo-block-idea', taskId: 'demo-task-idea', startAt: localToInstant(today, '10:00', zone), durationMinutes: 45, createdAt: at, updatedAt: at }];
  planning.days = [{ date: today, priorityTaskIds: ['demo-task-idea', 'demo-task-review'], note: 'Beispiel: Heute zählt ein klarer nächster Schritt.', review: '', availableMinutes: 480 }];
  planning.weeks = [{ weekStart: startOfWeek(today), goals: 'Beispiel: Raum für eine eigene Idee schaffen.', review: '' }];
  planning.taskRules = [{ id: 'demo-rule-review', frequency: 'daily', startDate: today, endDate: null, paused: false, template: { title: 'Kurz auf den Tag schauen', description: 'Fiktives tägliches Ritual. Die Regel kann in den Einstellungen pausiert werden.', priority: 'normal', estimatedMinutes: 10, tags: ['Beispiel'], subtasks: [], noteIds: [], dueOffsetDays: null }, createdAt: at, updatedAt: at }];
  planning.recurrenceReceipts = [{ ruleId: 'demo-rule-review', date: today, taskId: 'demo-task-review' }];
  planning.reminders = [{ id: 'demo-reminder-idea', title: 'Beispiel · an die kleine Idee denken', localStart: `${tomorrow}T09:00`, timeZone: zone, frequency: 'once', enabled: true, taskId: 'demo-task-idea', appointmentId: null, createdAt: at, updatedAt: at }];
  planning.settings.onboardingDone = true;
  return { notes, planning };
}
