import { dayBounds, localTime } from '../dates';

export const TASK_DRAG_TYPE = 'application/x-nexus-task-id';
export const ENTRY_DRAG_TYPE = 'application/x-nexus-timeline-entry';
export const GRID_MINUTES = 15;

export interface TimelineRange { start: number; end: number; minutes: number }
export interface TimelineTick { minute: number; label: string }
export interface TimelineInterval { key: string; start: number; end: number }
export interface TimelinePosition extends TimelineInterval { column: number; columns: number }

const ranges = new Map<string, TimelineRange>();

/** The axis follows real minutes, so spring/autumn clock changes stay unambiguous. */
export function timelineRange(date: string, zone: string): TimelineRange {
  const key = `${zone}/${date}`;
  const cached = ranges.get(key);
  if (cached) return cached;
  const [start, end] = dayBounds(date, zone);
  const range = { start, end, minutes: (end - start) / 60_000 };
  if (ranges.size >= 100) ranges.clear();
  ranges.set(key, range);
  return range;
}

export function timelineTicks(range: TimelineRange, zone: string): TimelineTick[] {
  const ticks: TimelineTick[] = [];
  for (let minute = 0; minute < range.minutes; minute++) {
    const label = localTime(new Date(range.start + minute * 60_000), zone);
    if (minute === 0 || label.endsWith(':00')) ticks.push({ minute, label });
  }
  const counts = new Map<string, number>();
  for (const tick of ticks) counts.set(tick.label, (counts.get(tick.label) ?? 0) + 1);
  const formatter = new Intl.DateTimeFormat('de-DE', { timeZone: zone, timeZoneName: 'shortOffset' });
  return ticks.map(tick => counts.get(tick.label)! > 1 ? {
    ...tick,
    label: `${tick.label} ${formatter.formatToParts(new Date(range.start + tick.minute * 60_000)).find(part => part.type === 'timeZoneName')?.value ?? ''}`,
  } : tick);
}

export function clipToTimeline(startAt: string, durationMinutes: number, range: TimelineRange): { start: number; end: number } | null {
  const start = Math.max(range.start, Date.parse(startAt));
  const end = Math.min(range.end, Date.parse(startAt) + durationMinutes * 60_000);
  return end > start ? { start: (start - range.start) / 60_000, end: (end - range.start) / 60_000 } : null;
}

export function snapMinute(minute: number, total: number): number {
  return Math.max(0, Math.min(Math.max(0, total - GRID_MINUTES), Math.round(minute / GRID_MINUTES) * GRID_MINUTES));
}

/** Give each overlapping entry its own column, including chained overlaps. */
export function positionIntervals(intervals: TimelineInterval[]): TimelinePosition[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start || b.end - a.end || a.key.localeCompare(b.key));
  const result: TimelinePosition[] = [];
  let group: TimelinePosition[] = [];
  let columnEnds: number[] = [];
  let groupEnd = -1;
  function finish() {
    for (const item of group) item.columns = columnEnds.length;
    result.push(...group);
    group = []; columnEnds = [];
  }
  for (const item of sorted) {
    if (item.start >= groupEnd && group.length) finish();
    let column = columnEnds.findIndex(end => end <= item.start);
    if (column < 0) column = columnEnds.length;
    columnEnds[column] = item.end;
    group.push({ ...item, column, columns: 1 });
    groupEnd = Math.max(groupEnd, item.end);
  }
  finish();
  return result;
}
