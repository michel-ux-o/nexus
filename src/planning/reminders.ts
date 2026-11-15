import { addDays, dateInZone, dayBoundary, dayBounds, daysBetween, isDate, isTimeZone, localToInstant, todayInZone } from './dates';
import type { PlanningData, Reminder, ReminderOccurrence, ReminderReceipt } from './types';

/** Stable and compact even for imported identifiers of the maximum supported length. */
export function reminderOccurrenceId(reminderId: string, scheduledAt: string): string {
  const input = `${reminderId}\u0000${new Date(scheduledAt).toISOString()}`;
  const hash = (seed: bigint): string => {
    let value = seed;
    for (let i = 0; i < input.length; i++) value = BigInt.asUintN(64, (value ^ BigInt(input.charCodeAt(i))) * 1099511628211n);
    return value.toString(16).padStart(16, '0');
  };
  return `reminder-${hash(14695981039346656037n)}${hash(7809847782465536322n)}`;
}

const resolved = new Map<string, { scheduledAt: string; adjusted: boolean }>();
/** Repeated wall times choose the later instant; gaps advance to the first real minute. */
export function resolveReminderTime(date: string, time: string, zone: string): { scheduledAt: string; adjusted: boolean } {
  const key = `${zone}\u0000${date}T${time}`;
  const cached = resolved.get(key);
  if (cached) return cached;
  let result: { scheduledAt: string; adjusted: boolean };
  try { result = { scheduledAt: localToInstant(date, time, zone), adjusted: false }; }
  catch (error) {
    // Invalid syntax and zones must not be mistaken for a daylight-saving gap.
    if (!isDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || !isTimeZone(zone)) throw error;
    try { result = { scheduledAt: localToInstant(date, time, zone, 'later'), adjusted: true }; }
    catch {
      const wall = Date.parse(`${date}T${time}:00.000Z`);
      let found: string | null = null;
      // Includes the largest historical skipped day, without an unbounded search.
      for (let offset = 1; offset <= 2880; offset++) {
        const next = new Date(wall + offset * 60_000).toISOString();
        try { found = localToInstant(next.slice(0, 10), next.slice(11, 16), zone, 'later'); break; }
        catch { /* Advance only this recurring occurrence, never the rule. */ }
      }
      if (found === null) throw error;
      result = { scheduledAt: found, adjusted: true };
    }
  }
  if (resolved.size >= 20_000) resolved.clear();
  resolved.set(key, result);
  return result;
}

function occursOn(reminder: Reminder, date: string): boolean {
  const first = reminder.localStart.slice(0, 10);
  return date >= first && (reminder.frequency === 'daily' || (reminder.frequency === 'weekly' ? daysBetween(first, date) % 7 === 0 : date === first));
}
function occurrence(reminder: Reminder, scheduledAt: string, adjusted: boolean, receipt?: ReminderReceipt): ReminderOccurrence {
  return {
    id: receipt?.id ?? reminderOccurrenceId(reminder.id, scheduledAt), reminder, scheduledAt,
    effectiveAt: receipt?.snoozedUntil ?? scheduledAt, status: receipt?.status ?? 'pending', adjusted,
  };
}
function receiptKey(reminderId: string, instant: string): string { return `${reminderId}\u0000${Date.parse(instant)}`; }
function receiptsByReminder(data: PlanningData): Map<string, ReminderReceipt[]> {
  const result = new Map<string, ReminderReceipt[]>();
  for (const receipt of data.reminderReceipts ?? []) {
    const items = result.get(receipt.reminderId);
    if (items) items.push(receipt); else result.set(receipt.reminderId, [receipt]);
  }
  return result;
}

/** Inclusive display-zone dates; receipts also restore snoozes from outside the requested range. */
export function reminderOccurrences(data: PlanningData, fromDate: string, toDate: string, _now = new Date()): ReminderOccurrence[] {
  if (!isDate(fromDate) || !isDate(toDate) || toDate < fromDate) throw new Error('Der Erinnerungszeitraum ist ungültig.');
  const from = dayBoundary(fromDate, data.settings.timeZone);
  const to = dayBounds(toDate, data.settings.timeZone)[1];
  const receipts = new Map((data.reminderReceipts ?? []).map((receipt) => [receiptKey(receipt.reminderId, receipt.scheduledAt), receipt]));
  const groupedReceipts = receiptsByReminder(data);
  const result = new Map<string, ReminderOccurrence>();
  const inRange = (item: ReminderOccurrence) => Date.parse(item.effectiveAt) >= from && Date.parse(item.effectiveAt) < to;
  for (const reminder of data.reminders ?? []) {
    if (reminder.enabled && from < to) {
      const first = reminder.localStart.slice(0, 10);
      let date = dateInZone(new Date(from), reminder.timeZone);
      // A skipped civil day can resolve into the following day.
      if (date > '0001-01-01') date = addDays(date, -1);
      if (date < first) date = first;
      const ownLast = dateInZone(new Date(to - 1), reminder.timeZone);
      const last = ownLast.length > 10 ? '9999-12-31' : ownLast;
      if (reminder.frequency === 'weekly' && date > first) date = addDays(date, (7 - daysBetween(first, date) % 7) % 7);
      if (reminder.frequency === 'once') date = first;
      while (date <= last) {
        if (occursOn(reminder, date)) {
          const resolvedTime = resolveReminderTime(date, reminder.localStart.slice(11, 16), reminder.timeZone);
          const item = occurrence(reminder, resolvedTime.scheduledAt, resolvedTime.adjusted, receipts.get(receiptKey(reminder.id, resolvedTime.scheduledAt)));
          if (inRange(item)) result.set(receiptKey(reminder.id, item.scheduledAt), item);
        }
        const step = reminder.frequency === 'weekly' ? 7 : 1;
        if (reminder.frequency === 'once' || daysBetween(date, last) < step) break;
        date = addDays(date, step);
      }
    }
    // Authoritative receipts survive rule edits. Disabled rules retain their history.
    for (const receipt of groupedReceipts.get(reminder.id) ?? []) {
      if (!reminder.enabled && receipt.status === 'pending') continue;
      const localDate = dateInZone(receipt.scheduledAt, reminder.timeZone);
      let adjusted = false;
      if (occursOn(reminder, localDate)) {
        const current = resolveReminderTime(localDate, reminder.localStart.slice(11, 16), reminder.timeZone);
        adjusted = current.scheduledAt === receipt.scheduledAt && current.adjusted;
      }
      const item = occurrence(reminder, receipt.scheduledAt, adjusted, receipt);
      if (inRange(item)) result.set(receiptKey(reminder.id, item.scheduledAt), item);
    }
  }
  return [...result.values()].sort((left, right) => Date.parse(left.effectiveAt) - Date.parse(right.effectiveAt) || left.id.localeCompare(right.id));
}

export interface ReminderOverdueSummary { reminder: Reminder; count: number; firstScheduledAt: string; lastScheduledAt: string }

/** Count old pending occurrences arithmetically, without materializing years of history. */
export function reminderOverdueSummary(data: PlanningData, now = new Date()): ReminderOverdueSummary[] {
  const today = todayInZone(data.settings.timeZone, now);
  const cutoffDate = today <= '0001-01-29' ? '0001-01-01' : addDays(today, -28);
  const cutoff = dayBoundary(cutoffDate, data.settings.timeZone);
  const summaries: ReminderOverdueSummary[] = [];
  const groupedReceipts = receiptsByReminder(data);
  for (const reminder of data.reminders ?? []) {
    if (!reminder.enabled) continue;
    const firstDate = reminder.localStart.slice(0, 10);
    let lastDate = dateInZone(new Date(cutoff), reminder.timeZone);
    const step = reminder.frequency === 'weekly' ? 7 : 1;
    if (lastDate < firstDate) continue;
    if (reminder.frequency === 'once') lastDate = firstDate;
    else if (reminder.frequency === 'weekly') lastDate = addDays(lastDate, -(daysBetween(firstDate, lastDate) % 7));
    const at = (date: string) => resolveReminderTime(date, reminder.localStart.slice(11, 16), reminder.timeZone).scheduledAt;
    while (lastDate >= firstDate && Date.parse(at(lastDate)) >= cutoff) {
      if (reminder.frequency === 'once' || lastDate === '0001-01-01') { lastDate = ''; break; }
      lastDate = addDays(lastDate, -step);
    }
    const total = lastDate >= firstDate ? (reminder.frequency === 'once' ? 1 : Math.floor(daysBetween(firstDate, lastDate) / step) + 1) : 0;
    let count = total;
    const excluded = new Set<string>();
    const extra: string[] = [];
    for (const receipt of groupedReceipts.get(reminder.id) ?? []) {
      const localDate = dateInZone(receipt.scheduledAt, reminder.timeZone);
      const belongs = localDate >= firstDate && localDate <= lastDate && occursOn(reminder, localDate) && Date.parse(at(localDate)) === Date.parse(receipt.scheduledAt);
      const pending = receipt.status === 'pending' && Date.parse(receipt.snoozedUntil ?? receipt.scheduledAt) < cutoff;
      if (belongs && !pending) { count--; excluded.add(localDate); }
      if (!belongs && pending) { count++; extra.push(receipt.scheduledAt); }
    }
    if (count <= 0) continue;
    let first = firstDate; let last = lastDate;
    while (first <= lastDate && excluded.has(first)) first = addDays(first, step);
    while (last >= first && excluded.has(last)) last = addDays(last, -step);
    const instants = [...extra, ...(first <= last ? [at(first), at(last)] : [])].sort();
    if (instants.length) summaries.push({ reminder, count, firstScheduledAt: instants[0], lastScheduledAt: instants[instants.length - 1] });
  }
  return summaries;
}
