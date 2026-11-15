import { dayBounds, localToInstant } from './dates';
import { conflictsForDay } from './selectors';
import type { PlanningData } from './types';

export interface DayCapacity {
  availableMinutes: number; usedMinutes: number; remainingMinutes: number;
  outsideMinutes: number; unestimatedCount: number; conflictCount: number;
}
type Interval = [number, number];
function unionMinutes(intervals: Interval[]): number {
  const sorted = intervals.filter(([start, end]) => start < end).sort((left, right) => left[0] - right[0]);
  if (!sorted.length) return 0;
  let total = 0; let [start, end] = sorted[0];
  for (const interval of sorted.slice(1)) {
    if (interval[0] > end) { total += end - start; [start, end] = interval; }
    else end = Math.max(end, interval[1]);
  }
  return (total + end - start) / 60_000;
}
function clip([start, end]: Interval, [from, to]: Interval): Interval { return [Math.max(start, from), Math.min(end, to)]; }

/** Fixed time is unioned; estimates count only on their primary planning day. */
export function capacityForDay(data: PlanningData, date: string): DayCapacity {
  const range = dayBounds(date, data.settings.timeZone);
  const settings = data.settings.capacity;
  const weekday = ((new Date(`${date}T12:00:00.000Z`).getUTCDay() + 6) % 7) + 1;
  const window = settings?.windows.find((item) => item.weekday === weekday && item.enabled);
  let available = data.days.find((day) => day.date === date)?.availableMinutes ?? data.settings.defaultAvailableMinutes;
  let working: Interval = range;
  if (settings?.enabled) {
    if (window) {
      // A transition inside a recurring availability window uses its actual elapsed time.
      const resolve = (time: string, later: boolean): number => {
        try { return Date.parse(localToInstant(date, time, data.settings.timeZone, later ? 'later' : 'earlier')); }
        catch {
          // A missing wall minute contributes no phantom capacity; advance to the first real minute.
          const [hours, minutes] = time.split(':').map(Number);
          for (let minute = hours * 60 + minutes + 1; minute < 1440; minute++) {
            try { return Date.parse(localToInstant(date, `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`, data.settings.timeZone, later ? 'later' : 'earlier')); }
            catch { /* Keep looking within this civil day. */ }
          }
          return range[1];
        }
      };
      working = clip([resolve(window.start, false), resolve(window.end, true)], range);
      available = Math.max(0, (working[1] - working[0]) / 60_000 - settings.bufferMinutes);
    } else { working = [range[0], range[0]]; available = 0; }
  }
  const intervals: Interval[] = [...data.timeBlocks, ...data.appointments.filter((item) => !item.allDay)]
    .map((item) => clip([Date.parse(item.startAt), Date.parse(item.startAt) + item.durationMinutes * 60_000], range));
  const fixed = unionMinutes(intervals);
  const blockedTasks = new Set(data.timeBlocks.map((block) => block.taskId));
  const unblocked = data.tasks.filter((task) => task.plan?.kind === 'day' && task.plan.date === date && !blockedTasks.has(task.id));
  const used = fixed + unblocked.reduce((total, task) => total + (task.estimatedMinutes ?? 0), 0);
  const inside = unionMinutes(intervals.map((interval) => clip(interval, working)));
  return {
    availableMinutes: available, usedMinutes: used, remainingMinutes: available - used,
    outsideMinutes: settings?.enabled ? fixed - inside : 0,
    unestimatedCount: unblocked.filter((task) => task.estimatedMinutes === null).length,
    conflictCount: conflictsForDay(data, date).length,
  };
}
