import { dateInZone, formatTime } from '../dates';
import type { Appointment, Task, TimeBlock } from '../types';

export type WeekAgendaItem =
  | { kind: 'appointment'; entry: Appointment }
  | { kind: 'block'; entry: TimeBlock; task: Task | undefined };

export function weekDayTime(
  date: string, usedMinutes: number, tasks: readonly Task[], blockedTasks: ReadonlyMap<string, number>,
) {
  // Match capacityForDay: any assigned block replaces the estimate, even on a different day.
  const flexibleMinutes = tasks.reduce((total, task) => (
    task.plan?.kind === 'day' && task.plan.date === date && !blockedTasks.has(task.id)
      ? total + (task.estimatedMinutes ?? 0)
      : total
  ), 0);
  return { fixedMinutes: usedMinutes - flexibleMinutes, flexibleMinutes };
}

export function weekDayHighlights(
  date: string, zone: string, agenda: readonly WeekAgendaItem[], tasks: readonly Task[],
  routineRuleIds: ReadonlySet<string>, allDay: readonly Appointment[], due: readonly Task[],
) {
  const isRoutine = (task: Task) => !!task.morningRoutineDate || (!!task.ruleId && routineRuleIds.has(task.ruleId));
  const routines = tasks.filter(isRoutine).map(task => task.morningRoutineDate ? 'Morgenroutine' : task.title);
  const anchors = agenda.filter(item => item.kind === 'appointment' || !item.task || !isRoutine(item.task));
  const activities = anchors.slice(0, 2).map(item => {
    const { startAt } = item.entry;
    const title = item.kind === 'appointment' ? item.entry.title : item.task?.title ?? 'Zeitblock';
    const time = formatTime(startAt, zone);
    return { id: `${item.kind}-${item.entry.id}`, title, time: dateInZone(startAt, zone) < date ? `seit ${time}` : time, startAt };
  });
  const otherTasks = tasks.filter(task => !isRoutine(task));
  const nextTask = otherTasks.find(task => task.status !== 'done') ?? otherTasks[0];
  const fallback = allDay[0] ? `Ganztägig · ${allDay[0].title}`
    : nextTask?.title ?? (due[0] ? `Fällig · ${due[0].title}` : routines.length ? 'Nur Routinen' : 'Noch frei');
  return { activities, remainingActivities: anchors.length - activities.length, routines, fallback };
}
