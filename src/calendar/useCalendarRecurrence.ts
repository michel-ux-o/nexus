import { useEffect, useState } from 'react';
import { addDays, daysBetween, todayInZone } from '../planning/dates';
import type { Planner } from '../planning/types';

/** The store owns receipt-based idempotency, including React StrictMode replays. */
export function useCalendarRecurrence(planner: Planner, from: string, to: string) {
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const today = todayInZone(planner.data.settings.timeZone);
  const horizon = addDays(today, Math.min(42, daysBetween(today, '9999-12-31')));
  const end = to < horizon ? to : horizon;
  const rules = (planner.data.taskRules ?? []).map(rule => `${rule.id}:${rule.updatedAt}:${rule.paused}`).join('|');
  const materialize = planner.materializeRecurring;
  useEffect(() => {
    setError('');
    if (planner.loading || planner.loadError || from > end) return;
    let current = true;
    void materialize(from, end).catch(cause => {
      if (current) setError(cause instanceof Error ? cause.message : 'Wiederholte Aufgaben konnten nicht geladen werden.');
    });
    return () => { current = false; };
  }, [planner.loading, planner.loadError, materialize, from, end, rules, attempt]);
  return { recurrenceError: error, retryRecurring: () => setAttempt(value => value + 1) };
}
