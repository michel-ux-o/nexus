import { addDays, dateInZone, daysBetween, localSubMinute, localTime, localToInstant } from './dates';
import type { PlanningData, TaskPlan, TimeBlock } from './types';

export function samePlan(left: TaskPlan, right: TaskPlan): boolean {
  return left === null ? right === null : right !== null && left.kind === right.kind
    && (left.kind === 'day' ? right.kind === 'day' && left.date === right.date : right.kind === 'week' && left.weekStart === right.weekStart);
}

/** Pure: resolve every target before the caller publishes any part of a move. */
export function moveTaskBlocks(data: PlanningData, taskId: string, previous: TaskPlan, target: TaskPlan, onlyBlockIds?: ReadonlySet<string>): TimeBlock[] {
  if (samePlan(previous, target)) return data.timeBlocks;
  const blocks = data.timeBlocks.filter((block) => block.taskId === taskId);
  if (!blocks.length) return data.timeBlocks;
  if (target === null || (target.kind === 'week' && previous?.kind !== 'week')) {
    return data.timeBlocks.filter((block) => block.taskId !== taskId);
  }
  const zone = data.settings.timeZone;
  const earliest = blocks.reduce((first, block) => Date.parse(block.startAt) < Date.parse(first.startAt) ? block : first);
  const anchor = previous?.kind === 'day' ? previous.date
    : target.kind === 'week' && previous?.kind === 'week' ? previous.weekStart : dateInZone(earliest.startAt, zone);
  const difference = daysBetween(anchor, target.kind === 'day' ? target.date : target.weekStart);
  const shifted = new Map(blocks.filter((block) => !onlyBlockIds || onlyBlockIds.has(block.id)).map((block) => {
    const date = addDays(dateInZone(block.startAt, zone), difference);
    try {
      const instant = Date.parse(localToInstant(date, localTime(block.startAt, zone), zone));
      const remainder = localSubMinute(block.startAt, zone);
      return [block.id, { ...block, startAt: new Date(instant + remainder).toISOString() }] as const;
    } catch (error) {
      throw new Error(`Zeitblock „${block.id}“ kann am ${date} nicht mitverschoben werden: ${error instanceof Error ? error.message : 'Die Zielzeit ist nicht eindeutig.'}`);
    }
  }));
  return data.timeBlocks.map((block) => shifted.get(block.id) ?? block);
}
