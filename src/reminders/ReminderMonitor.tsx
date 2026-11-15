import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, X } from 'lucide-react';
import { todayInZone } from '../planning/dates';
import { reminderOccurrences } from '../planning/reminders';
import type { Planner, ReminderOccurrence } from '../planning/types';
import { boundedDay, reminderTimeLabel } from './presentation';
import './Reminders.css';

export interface ReminderMonitorProps { planner: Planner; onOpen: () => void }

function notificationAllowed(planner: Planner): boolean {
  return !planner.loading && !planner.loadError && planner.data.settings.notifications === true &&
    typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

/** Delivery is recorded first; rendering, focus changes and reloads cannot replay it. */
export function ReminderMonitor({ planner, onOpen }: ReminderMonitorProps) {
  const plannerRef = useRef(planner);
  const openRef = useRef(onOpen);
  const running = useRef(false);
  const mounted = useRef(false);
  const attempted = useRef(new Map<string, string>());
  const [notice, setNotice] = useState<{ title: string; detail: string; error?: boolean } | null>(null);
  plannerRef.current = planner;
  openRef.current = onOpen;

  const check = useCallback(async () => {
    const current = plannerRef.current;
    if (running.current || !notificationAllowed(current)) return;
    running.current = true;
    try {
      const now = new Date();
      const zone = current.data.settings.timeZone;
      const today = todayInZone(zone, now);
      const receipts = new Map((current.data.reminderReceipts ?? []).map(receipt => [receipt.id, receipt]));
      const due = reminderOccurrences(current.data, boundedDay(today, -28), today, now).filter(occurrence =>
        occurrence.status === 'pending' && occurrence.reminder.enabled && Date.parse(occurrence.effectiveAt) <= now.getTime() &&
        !receipts.get(occurrence.id)?.notifiedAt && attempted.current.get(occurrence.id) !== occurrence.effectiveAt,
      );
      const committed: ReminderOccurrence[] = [];
      let failed = false;
      for (const occurrence of due) {
        if (!mounted.current || !notificationAllowed(plannerRef.current)) break;
        const fresh = plannerRef.current.data;
        const freshReceipt = (fresh.reminderReceipts ?? []).find(receipt => receipt.id === occurrence.id);
        const rule = (fresh.reminders ?? []).find(reminder => reminder.id === occurrence.reminder.id);
        if (!rule?.enabled || freshReceipt?.notifiedAt || (freshReceipt && freshReceipt.status !== 'pending') || (freshReceipt?.snoozedUntil && Date.parse(freshReceipt.snoozedUntil) > Date.now())) continue;
        try { await plannerRef.current.markReminderNotified(occurrence); }
        catch { failed = true; break; }
        const after = (plannerRef.current.data.reminderReceipts ?? []).find(receipt => receipt.id === occurrence.id);
        if (after && (after.status !== 'pending' || (after.snoozedUntil ?? after.scheduledAt) !== occurrence.effectiveAt)) continue;
        attempted.current.set(occurrence.id, occurrence.effectiveAt);
        committed.push(occurrence);
      }
      if (!mounted.current || !notificationAllowed(plannerRef.current)) return;
      const latestData = plannerRef.current.data;
      const deliverable = committed.filter(occurrence => {
        const rule = (latestData.reminders ?? []).find(reminder => reminder.id === occurrence.reminder.id);
        const receipt = (latestData.reminderReceipts ?? []).find(item => item.id === occurrence.id);
        return rule?.enabled && (!receipt || (receipt.status === 'pending' && (receipt.snoozedUntil ?? receipt.scheduledAt) === occurrence.effectiveAt));
      });
      if (!deliverable.length) {
        if (failed) setNotice({ title: 'Erinnerungsmeldung nicht bestätigt', detail: 'Der Meldungsbeleg konnte nicht gespeichert werden. Die Erinnerung bleibt in der Zentrale sichtbar.', error: true });
        return;
      }
      const first = deliverable[0];
      const title = deliverable.length === 1 ? first.reminder.title : `${deliverable.length} Erinnerungen sind fällig`;
      const description = deliverable.length === 1 ? reminderTimeLabel(first.effectiveAt, zone) : `${first.reminder.title} und ${deliverable.length - 1} weitere`;
      const detail = failed ? `${description} · Weitere Meldungsbelege konnten nicht gespeichert werden.` : description;
      setNotice({ title, detail, error: failed });
      try {
        const notification = new Notification(title, { body: detail, tag: `nexus-reminder-${first.id}` });
        notification.onclick = () => { window.focus(); openRef.current(); notification.close(); };
      } catch {
        setNotice({ title, detail: `${detail} · Die Browsermeldung konnte nicht angezeigt werden.` });
      }
    } catch {
      if (mounted.current) setNotice({ title: 'Erinnerungsmeldung nicht bestätigt', detail: 'Der Meldungsbeleg konnte nicht gespeichert werden. Die Erinnerung bleibt in der Zentrale sichtbar.', error: true });
    } finally { running.current = false; }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const refresh = () => { void check(); };
    const interval = window.setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    void check();
    return () => {
      mounted.current = false;
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [check]);

  useEffect(() => { if (!planner.loading && planner.data.settings.notifications) void check(); }, [planner.loading, planner.data.settings.notifications, check]);
  useEffect(() => { if (!planner.data.settings.notifications) setNotice(null); }, [planner.data.settings.notifications]);
  useEffect(() => {
    const receipts = new Map((planner.data.reminderReceipts ?? []).map(receipt => [receipt.id, receipt]));
    for (const id of attempted.current.keys()) {
      if (!receipts.get(id)?.notifiedAt) attempted.current.delete(id);
    }
  }, [planner.data.reminderReceipts]);

  if (!notice) return null;
  return <aside className={`reminder-snackbar${notice.error ? ' is-error' : ''}`} aria-label="Fällige Erinnerungen">
    <Bell size={20} aria-hidden="true" /><div role="status" aria-live="polite"><strong>{notice.title}</strong><p>{notice.detail}</p></div>
    <button type="button" className="reminders-button" onClick={() => { setNotice(null); onOpen(); }}>Ansehen</button>
    <button type="button" className="reminders-button reminder-snackbar-close" aria-label="Erinnerungshinweis schließen" onClick={() => setNotice(null)}><X size={18} aria-hidden="true" /></button>
  </aside>;
}

export default ReminderMonitor;
