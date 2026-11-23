import { useEffect, useId, useMemo, useState } from 'react';
import { AlertCircle, Bell, BellOff, CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, Link2, Pause, Play, Plus, Repeat2, RotateCcw, X } from 'lucide-react';
import { dateInZone, formatDate, formatTime, todayInZone } from '../planning/dates';
import { reminderOccurrences, reminderOverdueSummary, resolveReminderTime } from '../planning/reminders';
import type { Reminder, ReminderOccurrence, WorkspaceViewProps } from '../planning/types';
import { errorMessage } from '../planning/components/PlanningDialog';
import { boundedDay, frequencyLabels, reminderRelativeTime, reminderTimeLabel } from './presentation';
import { BrowserNotificationStatus } from './BrowserNotificationStatus';
import { useTheme } from '../themes/useTheme';
import './Reminders.css';

type ReminderTab = 'overdue' | 'today' | 'upcoming' | 'done';
const tabs: { id: ReminderTab; label: string; empty: string }[] = [
  { id: 'overdue', label: 'Überfällig', empty: 'Keine überfälligen Erinnerungen.' },
  { id: 'today', label: 'Heute', empty: 'Keine weiteren Erinnerungen für heute.' },
  { id: 'upcoming', label: 'Demnächst', empty: 'Keine Erinnerungen in den nächsten 42 Tagen.' },
  { id: 'done', label: 'Erledigt', empty: 'Noch keine quittierten Erinnerungen.' },
];

export function RemindersView({ planner, onEditReminder, onEditTask, onEditAppointment, onNavigate }: WorkspaceViewProps) {
  const id = useId();
  const [tab, setTab] = useState<ReminderTab>('overdue');
  const [now, setNow] = useState(() => new Date());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [snoozeMinutes, setSnoozeMinutes] = useState('15');
  const [historyLimit, setHistoryLimit] = useState(50);
  const [olderPage, setOlderPage] = useState<{ reminderId: string; from: string } | null>(null);
  const [showAllOpen, setShowAllOpen] = useState(true);
  const [selectedOccurrenceId, setSelectedOccurrenceId] = useState<string | null>(null);
  const data = planner.data;
  const horizon = useTheme(data.settings.theme) === 'nexus';
  const zone = data.settings.timeZone;
  const today = todayInZone(zone, now);
  const since = boundedDay(today, -28);
  const until = boundedDay(today, 42);
  const reminders = data.reminders ?? [];
  const receipts = data.reminderReceipts ?? [];
  const receiptById = useMemo(() => new Map(receipts.map(receipt => [receipt.id, receipt])), [receipts]);

  useEffect(() => {
    const refresh = () => setNow(new Date());
    const interval = window.setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(interval); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);

  const occurrences = useMemo(() => reminderOccurrences(data, since, until, now), [data, since, until, now]);
  const older = useMemo(() => reminderOverdueSummary(data, now), [data, now]);
  const done = useMemo<ReminderOccurrence[]>(() => receipts.filter(receipt => receipt.status !== 'pending').flatMap(receipt => {
    const reminder = reminders.find(item => item.id === receipt.reminderId);
    if (!reminder) return [];
    const resolved = resolveReminderTime(dateInZone(receipt.scheduledAt, reminder.timeZone), reminder.localStart.slice(11, 16), reminder.timeZone);
    return [{ id: receipt.id, reminder, scheduledAt: receipt.scheduledAt, effectiveAt: receipt.snoozedUntil ?? receipt.scheduledAt, status: receipt.status, adjusted: resolved.scheduledAt === receipt.scheduledAt && resolved.adjusted }];
  }).sort((left, right) => right.effectiveAt.localeCompare(left.effectiveAt)), [receipts, reminders]);
  const pending = occurrences.filter(occurrence => occurrence.status === 'pending');
  const overdue = pending.filter(occurrence => Date.parse(occurrence.effectiveAt) < now.getTime());
  const laterToday = pending.filter(occurrence => Date.parse(occurrence.effectiveAt) >= now.getTime() && dateInZone(occurrence.effectiveAt, zone) === today);
  const upcoming = pending.filter(occurrence => Date.parse(occurrence.effectiveAt) >= now.getTime() && dateInZone(occurrence.effectiveAt, zone) > today);
  const groups: Record<ReminderTab, ReminderOccurrence[]> = { overdue, today: laterToday, upcoming, done };
  const count: Record<ReminderTab, number> = { overdue: overdue.length + older.reduce((sum, summary) => sum + summary.count, 0), today: laterToday.length, upcoming: upcoming.length, done: done.length };
  const current = groups[tab];
  const visible = tab === 'done' ? current.slice(0, historyLimit) : current;
  const horizonVisible = horizon && showAllOpen
    ? [...pending].sort((left, right) => left.effectiveAt.localeCompare(right.effectiveAt))
    : visible;
  const selectedOccurrence = horizonVisible.find(occurrence => occurrence.id === selectedOccurrenceId) ?? horizonVisible[0];
  const selectedReceipt = selectedOccurrence ? receiptById.get(selectedOccurrence.id) : undefined;
  const selectedDescription = selectedOccurrence?.reminder.taskId
    ? data.tasks.find(task => task.id === selectedOccurrence.reminder.taskId)?.description
    : selectedOccurrence?.reminder.appointmentId
      ? data.appointments.find(appointment => appointment.id === selectedOccurrence.reminder.appointmentId)?.description
      : undefined;
  const openCount = count.overdue + count.today + count.upcoming;
  const horizonDayGroups = new Map<string, ReminderOccurrence[]>();
  for (const occurrence of horizonVisible) {
    const day = dateInZone(occurrence.effectiveAt, zone);
    const items = horizonDayGroups.get(day) ?? [];
    items.push(occurrence);
    horizonDayGroups.set(day, items);
  }
  const selectedSummary = older.find(summary => summary.reminder.id === olderPage?.reminderId);
  const oldFirstDate = selectedSummary ? dateInZone(selectedSummary.firstScheduledAt, zone) : since;
  const oldLastDate = selectedSummary ? dateInZone(selectedSummary.lastScheduledAt, zone) : since;
  const oldFrom = olderPage && olderPage.from > oldFirstDate ? olderPage.from : oldFirstDate;
  const oldUntil = boundedDay(oldFrom, 27) < oldLastDate ? boundedDay(oldFrom, 27) : oldLastDate;
  const olderVisible = useMemo(() => {
    if (!selectedSummary) return [];
    const cutoff = since;
    const { reminder } = selectedSummary;
    const candidates = new Map(reminderOccurrences(data, oldFrom, oldUntil, now).filter(occurrence =>
      occurrence.reminder.id === reminder.id && occurrence.status === 'pending' &&
      occurrence.scheduledAt >= selectedSummary.firstScheduledAt && occurrence.scheduledAt <= selectedSummary.lastScheduledAt &&
      dateInZone(occurrence.scheduledAt, zone) >= oldFrom && dateInZone(occurrence.scheduledAt, zone) <= oldUntil &&
      dateInZone(occurrence.effectiveAt, zone) < cutoff,
    ).map(occurrence => [occurrence.id, occurrence]));
    // Page by the original occurrence date, even when an old snooze moved it
    // outside that page's display-time range. Such receipts must stay reachable.
    for (const receipt of receipts) {
      if (receipt.reminderId !== reminder.id || receipt.status !== 'pending') continue;
      const scheduledDate = dateInZone(receipt.scheduledAt, zone);
      const effectiveAt = receipt.snoozedUntil ?? receipt.scheduledAt;
      if (scheduledDate < oldFrom || scheduledDate > oldUntil || dateInZone(effectiveAt, zone) >= cutoff) continue;
      const resolved = resolveReminderTime(dateInZone(receipt.scheduledAt, reminder.timeZone), reminder.localStart.slice(11, 16), reminder.timeZone);
      candidates.set(receipt.id, { id: receipt.id, reminder, scheduledAt: receipt.scheduledAt, effectiveAt, status: receipt.status, adjusted: resolved.scheduledAt === receipt.scheduledAt && resolved.adjusted });
    }
    return [...candidates.values()].sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt));
  }, [data, oldFrom, oldUntil, now, selectedSummary, receipts, since, zone]);

  async function perform(key: string, action: () => Promise<void>, success: string) {
    if (busy) return;
    setBusy(key); setError(''); setMessage('');
    try { await action(); setMessage(success); setNow(new Date()); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(null); }
  }

  async function dismissOlderPage() {
    const page = [...olderVisible];
    await perform('older-dismiss', async () => {
      let confirmed = 0;
      try {
        for (const occurrence of page) {
          await planner.acknowledgeReminder(occurrence, 'dismissed');
          confirmed++;
        }
      } catch (cause) {
        throw new Error(`${confirmed} von ${page.length} angezeigten Vorkommen wurden bestätigt verworfen. Die übrigen bleiben offen. ${errorMessage(cause)}`);
      }
    }, 'Die angezeigten älteren Vorkommen wurden verworfen.');
  }

  function linkedTarget(reminder: Reminder) {
    const task = reminder.taskId ? data.tasks.find(item => item.id === reminder.taskId) : undefined;
    const appointment = reminder.appointmentId ? data.appointments.find(item => item.id === reminder.appointmentId) : undefined;
    if (task) return <button type="button" className="reminders-link" disabled={Boolean(busy)} onClick={() => onEditTask(task)}><Link2 size={13} aria-hidden="true" /> Aufgabe: {task.title}</button>;
    if (appointment) return <button type="button" className="reminders-link" disabled={Boolean(busy)} onClick={() => onEditAppointment(appointment)}><CalendarDays size={13} aria-hidden="true" /> Termin: {appointment.title}</button>;
    return reminder.taskId || reminder.appointmentId ? <span className="reminders-meta">Verknüpfung nicht mehr vorhanden</span> : null;
  }

  function linkedSchedule(occurrence: ReminderOccurrence) {
    const relativeTime = reminderRelativeTime(occurrence, data);
    const { taskId, appointmentId } = occurrence.reminder;
    const targetType = taskId && data.timeBlocks.some(block => block.taskId === taskId) ? 'Zeitblocks'
      : appointmentId && data.appointments.some(appointment => appointment.id === appointmentId) ? 'Termins' : null;
    return <>
      {relativeTime && <p className="reminders-meta reminders-relative-time">{relativeTime}</p>}
      {targetType && occurrence.status === 'pending' && <p className="reminders-meta">Die separat festgelegte Uhrzeit bleibt beim Verschieben des {targetType} erhalten.</p>}
    </>;
  }

  function occurrenceActions(occurrence: ReminderOccurrence, detail = false) {
    return <div className="reminders-card-actions">
      {occurrence.status === 'pending' ? <>
        <button type="button" className="reminders-button reminders-button-done" disabled={Boolean(busy)} onClick={() => void perform(occurrence.id, () => planner.acknowledgeReminder(occurrence, 'done'), 'Dieses Erinnerungsvorkommen wurde erledigt.')}><Check size={16} aria-hidden="true" /> {detail ? 'Erledigt' : 'Erledigen'}</button>
        <button type="button" className="reminders-button reminders-button-snooze" disabled={Boolean(busy)} onClick={() => void perform(occurrence.id, () => planner.acknowledgeReminder(occurrence, 'pending', new Date(Math.max(Date.now(), Date.parse(occurrence.effectiveAt)) + Number(snoozeMinutes) * 60_000).toISOString()), 'Dieses Erinnerungsvorkommen wurde verschoben.')}><Clock3 size={16} aria-hidden="true" /> {detail && 'Später · '}{snoozeMinutes === '1440' ? '24 Std.' : snoozeMinutes === '60' ? '1 Std.' : `${snoozeMinutes} Min.`}{!detail && ' schlummern'}</button>
        <button type="button" className="reminders-button reminders-button-subtle" disabled={Boolean(busy)} onClick={() => void perform(occurrence.id, () => planner.acknowledgeReminder(occurrence, 'dismissed'), 'Dieses Erinnerungsvorkommen wurde verworfen.')}><X size={15} aria-hidden="true" /> Verwerfen</button>
      </> : <button type="button" className="reminders-button" disabled={Boolean(busy)} onClick={() => void perform(occurrence.id, () => planner.acknowledgeReminder(occurrence, 'pending', null), 'Dieses Erinnerungsvorkommen ist wieder offen.')}><RotateCcw size={15} aria-hidden="true" /> Wieder öffnen</button>}
      <button type="button" className="reminders-link" disabled={Boolean(busy)} onClick={() => onEditReminder(occurrence.reminder)}>{detail ? 'Bearbeiten' : 'Regel bearbeiten'}</button>
    </div>;
  }

  function occurrenceRow(occurrence: ReminderOccurrence) {
    const { reminder } = occurrence;
    const receipt = receiptById.get(occurrence.id);
    const snoozed = Boolean(receipt?.snoozedUntil);
    return <li key={occurrence.id} className={`reminders-card${occurrence.status !== 'pending' ? ' is-done' : ''}`}>
      <div className="reminders-card-schedule">
        <p className="reminders-time"><time dateTime={occurrence.effectiveAt} aria-label={reminderTimeLabel(occurrence.effectiveAt, zone)}><span>{formatDate(dateInZone(occurrence.effectiveAt, zone), { weekday: 'short', day: 'numeric', month: 'short' })}</span><strong>{formatTime(occurrence.effectiveAt, zone)}</strong></time></p>
        <span className={`reminders-card-icon${occurrence.status !== 'pending' ? ' is-done' : ''}`} aria-hidden="true">{occurrence.status === 'done' ? <Check size={15} /> : occurrence.status === 'dismissed' ? <X size={15} /> : <Bell size={15} />}</span>
      </div>
      <div className="reminders-card-content">
        <div className="reminders-card-heading"><h2>{reminder.title}</h2><span className="reminders-badge">{frequencyLabels[reminder.frequency]}</span>{!reminder.enabled && <span className="reminders-badge">Pausiert</span>}</div>
        {(snoozed || occurrence.status !== 'pending') && <div className="reminders-state">{snoozed && <span className="reminders-badge"><Clock3 size={12} aria-hidden="true" /> Geschlummert</span>}{occurrence.status !== 'pending' && <span className="reminders-badge">{occurrence.status === 'done' ? 'Erledigt' : 'Verworfen'}</span>}</div>}
        {snoozed && <p className="reminders-meta">Ursprünglich {reminderTimeLabel(occurrence.scheduledAt, zone)}.</p>}
        {reminder.timeZone !== zone && <p className="reminders-meta">Eigene Zeitzone: {reminder.timeZone} · {formatTime(occurrence.scheduledAt, reminder.timeZone)}</p>}
        {occurrence.adjusted && <p className="reminders-adjusted"><AlertCircle size={13} aria-hidden="true" /> Wegen Zeitumstellung auf eine gültige Minute angepasst.</p>}
        {linkedTarget(reminder)}
        {linkedSchedule(occurrence)}
        {occurrenceActions(occurrence)}
      </div>
    </li>;
  }

  if (planner.loading || planner.loadError) return <section className={`reminders-view${horizon ? ' reminders-horizon' : ''}`} aria-labelledby={`${id}-title`}><h1 id={`${id}-title`}>{horizon ? 'Erinnerungen' : 'Erinnerungszentrale'}</h1>{planner.loading ? <p role="status">Deine Erinnerungen werden geladen …</p> : <><p role="alert">{planner.loadError}</p><button type="button" className="reminders-button" disabled={Boolean(busy)} onClick={() => void perform('reload', planner.reload, 'Erinnerungen neu geladen.')}>Erneut laden</button>{error && <p role="alert">{error}</p>}</>}</section>;

  return <section className={`reminders-view${horizon ? ' reminders-horizon' : ''}`} aria-labelledby={`${id}-title`} aria-busy={Boolean(busy)}>
    <header className="reminders-header"><div><p className="reminders-eyebrow">{formatDate(today, { weekday: 'long', day: 'numeric', month: 'long' })}</p><h1 id={`${id}-title`}>{horizon ? 'Erinnerungen' : 'Erinnerungszentrale'}</h1>{horizon && <p className="reminders-intro">{openCount} offen</p>}</div><div className="reminders-header-actions">{horizon && <time className="reminders-header-date" dateTime={today}>{formatDate(today, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</time>}<button type="button" className="reminders-button reminders-button-primary" disabled={Boolean(busy)} onClick={() => onEditReminder()}><Plus size={20} aria-hidden="true" /> Neue Erinnerung</button></div></header>
    <BrowserNotificationStatus planner={planner} onOpenSettings={() => onNavigate('settings')} />
    <div className="reminders-toolbar"><div className="reminders-tabs" role="group" aria-label="Erinnerungen filtern">{horizon ? <>
      <button type="button" aria-pressed={showAllOpen || tab !== 'done'} className={showAllOpen || tab !== 'done' ? 'is-active' : ''} onClick={() => { setShowAllOpen(true); setTab('overdue'); }}>Offen</button>
      <button type="button" aria-pressed={!showAllOpen && tab === 'done'} className={!showAllOpen && tab === 'done' ? 'is-active' : ''} onClick={() => { setShowAllOpen(false); setTab('done'); }}>Erledigt<span>{count.done}</span></button>
    </> : tabs.map(item => <button key={item.id} type="button" aria-pressed={tab === item.id} className={tab === item.id ? 'is-active' : ''} onClick={() => setTab(item.id)}>{item.label}<span>{count[item.id]}</span></button>)}</div><label className="reminders-snooze"><span id={`${id}-snooze`}>Schlummerdauer</span><select aria-labelledby={`${id}-snooze`} value={snoozeMinutes} onChange={event => setSnoozeMinutes(event.target.value)}><option value="5">5 Minuten</option><option value="15">15 Minuten</option><option value="60">1 Stunde</option><option value="1440">24 Stunden</option></select></label></div>
    {horizon && (showAllOpen || tab !== 'done') && <div className="reminders-open-filters" role="group" aria-label="Offene Erinnerungen eingrenzen"><button type="button" aria-pressed={showAllOpen} onClick={() => { setShowAllOpen(true); setTab('overdue'); }}>Alle</button>{tabs.filter(item => item.id !== 'done').map(item => <button key={item.id} type="button" aria-pressed={!showAllOpen && tab === item.id} onClick={() => { setShowAllOpen(false); setTab(item.id); }}>{item.label}<span>{count[item.id]}</span></button>)}</div>}
    {(error || planner.error) && <div className="reminders-notice reminders-notice-error" role="alert"><AlertCircle size={17} aria-hidden="true" /><span>{error || planner.error} Der Vorgang ist nicht bestätigt gespeichert.</span>{planner.status === 'error' && <button type="button" className="reminders-button" disabled={Boolean(busy)} onClick={() => void perform('retry', async () => { if (!await planner.retry()) throw new Error('Das Speichern ist weiterhin nicht möglich.'); }, 'Änderungen gespeichert.')}>Erneut speichern</button>}</div>}
    <p className="reminders-operation" role="status" aria-live="polite">{busy ? 'Änderung wird gespeichert …' : message}</p>

    {tab === 'overdue' && older.length > 0 && <section className="reminders-older" aria-labelledby={`${id}-older`}><h2 id={`${id}-older`}><Clock3 size={17} aria-hidden="true" /> Ältere offene Vorkommen</h2><p>Mehr als 28 Tage zurück · bleiben bis zur Quittierung offen.</p><ul>{older.map(summary => <li key={summary.reminder.id}><div><strong>{summary.reminder.title}</strong><span>{summary.count} offene {summary.count === 1 ? 'Erinnerung' : 'Erinnerungen'} · {formatDate(dateInZone(summary.firstScheduledAt, zone), { day: 'numeric', month: 'short', year: 'numeric' })} bis {formatDate(dateInZone(summary.lastScheduledAt, zone), { day: 'numeric', month: 'short', year: 'numeric' })}</span></div><button type="button" className="reminders-button" onClick={() => setOlderPage({ reminderId: summary.reminder.id, from: dateInZone(summary.firstScheduledAt, zone) })}>Ältere Vorkommen ansehen</button></li>)}</ul>
      {selectedSummary && <div className="reminders-older-details"><div className="reminders-older-heading"><h3>{selectedSummary.reminder.title}</h3><button type="button" className="reminders-button" onClick={() => setOlderPage(null)} aria-label="Ältere Vorkommen schließen"><X size={16} aria-hidden="true" /></button></div><p>{formatDate(oldFrom)} bis {formatDate(oldUntil)} · {olderVisible.length} offene Vorkommen auf dieser Seite</p><div className="reminders-older-actions"><button type="button" className="reminders-button" disabled={Boolean(busy) || oldFrom <= oldFirstDate} onClick={() => setOlderPage({ reminderId: selectedSummary.reminder.id, from: boundedDay(oldFrom, -28) })}><ChevronLeft size={15} aria-hidden="true" /> Frühere</button><button type="button" className="reminders-button" disabled={Boolean(busy) || oldUntil >= oldLastDate} onClick={() => setOlderPage({ reminderId: selectedSummary.reminder.id, from: boundedDay(oldUntil, 1) })}>Spätere <ChevronRight size={15} aria-hidden="true" /></button><button type="button" className="reminders-button" disabled={Boolean(busy) || !olderVisible.length} onClick={() => void dismissOlderPage()}><Check size={15} aria-hidden="true" /> Diese {olderVisible.length} angezeigten verwerfen</button></div><p className="reminders-meta">Bestätigt nur die hier angezeigten älteren Vorkommen. Neuere Erinnerungen und verknüpfte Aufgaben bleiben offen.</p><ul className="reminders-list">{olderVisible.map(occurrenceRow)}</ul>{!olderVisible.length && <p>Keine offenen Vorkommen in diesem Zeitraum. Blättere zur nächsten Seite.</p>}</div>}
    </section>}

    <div className="reminders-results" aria-label={`${horizon && showAllOpen ? 'Offene' : tabs.find(item => item.id === tab)?.label} Erinnerungen`}>
      {horizon ? <div className="reminders-workspace"><div className="reminders-agenda">
        {horizonVisible.length ? [...horizonDayGroups].map(([day, items]) => <section key={day} className="reminders-day" aria-labelledby={`${id}-day-${day}`}><h2 id={`${id}-day-${day}`}>{day === today ? 'Heute' : day === boundedDay(today, 1) ? 'Morgen' : formatDate(day, { weekday: 'long', day: 'numeric', month: 'long', ...(day.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' as const } : {}) })}</h2><ul className="reminders-occurrences">{items.map(occurrence => <li key={occurrence.id}><button type="button" className={`reminders-occurrence${selectedOccurrence?.id === occurrence.id ? ' is-selected' : ''}`} aria-pressed={selectedOccurrence?.id === occurrence.id} aria-controls={`${id}-detail`} onClick={() => setSelectedOccurrenceId(occurrence.id)}><time dateTime={occurrence.effectiveAt}>{formatTime(occurrence.effectiveAt, zone)}</time><span className="reminders-occurrence-copy"><strong>{occurrence.reminder.title}</strong>{receiptById.get(occurrence.id)?.snoozedUntil && <small>Geschlummert</small>}{occurrence.status !== 'pending' && <small>{occurrence.status === 'done' ? 'Erledigt' : 'Verworfen'}</small>}</span><ChevronRight size={20} aria-hidden="true" /></button></li>)}</ul></section>) : !(tab === 'overdue' && older.length) && <div className="reminders-empty"><BellOff size={27} aria-hidden="true" /><h2>{showAllOpen ? 'Keine offenen Erinnerungen in den nächsten 42 Tagen.' : tabs.find(item => item.id === tab)?.empty}</h2></div>}
      </div>{selectedOccurrence && <aside id={`${id}-detail`} className="reminders-detail" aria-labelledby={`${id}-detail-title`}>
        <p className="reminders-detail-eyebrow">Ausgewählte Erinnerung</p>
        <h2 id={`${id}-detail-title`}>{selectedOccurrence.reminder.title}</h2>
        <p className="reminders-detail-time"><time dateTime={selectedOccurrence.effectiveAt}>
          <span>{dateInZone(selectedOccurrence.effectiveAt, zone) === today ? 'Heute' : reminderTimeLabel(selectedOccurrence.effectiveAt, zone).split(' · ')[0]}</span>
          <strong>{formatTime(selectedOccurrence.effectiveAt, zone)} Uhr</strong>
        </time></p>
        {selectedDescription && <p className="reminders-detail-description">{selectedDescription}</p>}
        <div className="reminders-detail-meta">
          <span className="reminders-badge">{frequencyLabels[selectedOccurrence.reminder.frequency]}</span>
          {!selectedOccurrence.reminder.enabled && <span className="reminders-badge">Pausiert</span>}
          {selectedOccurrence.status !== 'pending' && <span className="reminders-badge">{selectedOccurrence.status === 'done' ? 'Erledigt' : 'Verworfen'}</span>}
          {selectedReceipt?.snoozedUntil && <p className="reminders-meta">Geschlummert · ursprünglich {reminderTimeLabel(selectedOccurrence.scheduledAt, zone)}.</p>}
          {selectedOccurrence.reminder.timeZone !== zone && <p className="reminders-meta">Eigene Zeitzone: {selectedOccurrence.reminder.timeZone} · {formatTime(selectedOccurrence.scheduledAt, selectedOccurrence.reminder.timeZone)}</p>}
          {selectedOccurrence.adjusted && <p className="reminders-adjusted"><AlertCircle size={13} aria-hidden="true" /> Wegen Zeitumstellung auf eine gültige Minute angepasst.</p>}
          {linkedTarget(selectedOccurrence.reminder)}
          {linkedSchedule(selectedOccurrence)}
        </div>
        {occurrenceActions(selectedOccurrence, true)}
      </aside>}</div> : visible.length ? <ul className="reminders-list">{visible.map(occurrenceRow)}</ul> : !(tab === 'overdue' && older.length) && <div className="reminders-empty"><BellOff size={27} aria-hidden="true" /><h2>{tabs.find(item => item.id === tab)?.empty}</h2></div>}
      {tab === 'done' && done.length > historyLimit && <button type="button" className="reminders-button reminders-more" onClick={() => setHistoryLimit(value => value + 50)}>Weitere {Math.min(50, done.length - historyLimit)} anzeigen · {historyLimit} von {done.length}</button>}
    </div>
    <details className="reminders-help"><summary>Verhalten &amp; Wiederholungen</summary><p>Erledigen, Verwerfen und Schlummern gelten für ein Vorkommen. Verknüpfte Aufgaben behalten ihren Status.</p><p>Verpasste Vorkommen der letzten 28 Tage erscheinen einzeln, ältere je Erinnerung gesammelt. Alle Uhrzeiten in {zone}. Bei geschlossener App gibt es keine Meldungen.</p></details>
    <details className="reminders-rules"><summary><Repeat2 size={16} aria-hidden="true" /> {reminders.length} {reminders.length === 1 ? 'Erinnerungsregel' : 'Erinnerungsregeln'} · {reminders.filter(reminder => !reminder.enabled).length} pausiert</summary><p>Eine Pause stoppt neue Vorkommen. Bereits quittierte Vorkommen bleiben im Verlauf.</p>{reminders.length ? <ul>{[...reminders].sort((left, right) => left.localStart.localeCompare(right.localStart)).map(reminder => <li key={reminder.id}><div><strong>{reminder.title}</strong><span>{frequencyLabels[reminder.frequency]} · ab {formatDate(reminder.localStart.slice(0, 10), { day: 'numeric', month: 'short', year: 'numeric' })}, {reminder.localStart.slice(11)} · {reminder.timeZone}</span>{linkedTarget(reminder)}</div><div className="reminders-rule-actions"><button type="button" className="reminders-button" disabled={Boolean(busy)} aria-pressed={reminder.enabled} onClick={() => void perform(`rule-${reminder.id}`, () => planner.saveReminder({ ...reminder, enabled: !reminder.enabled, updatedAt: new Date().toISOString() }), reminder.enabled ? 'Die Erinnerungsregel wurde pausiert.' : 'Die Erinnerungsregel wurde aktiviert.')}>
      {reminder.enabled ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}{reminder.enabled ? 'Pausieren' : 'Aktivieren'}</button><button type="button" className="reminders-button" disabled={Boolean(busy)} onClick={() => onEditReminder(reminder)}>Bearbeiten</button></div></li>)}</ul> : <p>Lege deine erste Erinnerung an.</p>}</details>
  </section>;
}

export default RemindersView;
