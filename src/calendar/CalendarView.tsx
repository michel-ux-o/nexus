import { subtaskProgress } from '../planning/subtasks';
import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { AlertTriangle, ArrowLeft, ArrowRight, Bell, CalendarDays, ChevronLeft, ChevronRight, Clock3, Link2, Plus, Square } from 'lucide-react';
import { addDays, formatDate, formatTime, isDate, localToInstant, todayInZone } from '../planning/dates';
import { capacityForDay } from '../planning/capacity';
import { reminderOccurrences } from '../planning/reminders';
import { Timeline } from '../planning/timeline/Timeline';
import type { WorkspaceViewProps } from '../planning/types';
import { calendarDates, entriesForCalendarDay, shiftCalendarDate, type CalendarEntry, type CalendarMode } from './calendarModel';
import { useCalendarRecurrence } from './useCalendarRecurrence';
import './CalendarView.css';

const modeLabels: Record<CalendarMode, string> = { month: 'Monat', week: 'Woche', day: 'Tag' };
const previousLabels: Record<CalendarMode, string> = { month: 'Vorheriger Monat', week: 'Vorherige Woche', day: 'Vorheriger Tag' };
const nextLabels: Record<CalendarMode, string> = { month: 'Nächster Monat', week: 'Nächste Woche', day: 'Nächster Tag' };
const kindLabels: Record<CalendarEntry['kind'], string> = {
  appointment: 'Termin', 'all-day': 'Ganztägig', due: 'Fälligkeit', block: 'Bearbeitungsblock', planned: 'Tagesplanung',
};

function dayLabel(date: string): string {
  return formatDate(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function minutesLabel(minutes: number): string {
  const value = Math.max(0, Math.round(minutes));
  return value >= 60 ? `${Math.floor(value / 60)} Std.${value % 60 ? ` ${value % 60} Min.` : ''}` : `${value} Min.`;
}

export interface CalendarViewProps extends WorkspaceViewProps {
  selectedDate?: string;
  onSelectedDateChange?: (date: string) => void;
  onOpenDay?: (date: string) => void;
}

export function CalendarView({
  planner, notes, onEditTask, onEditAppointment, onEditBlock, onOpenNote, onEditReminder,
  selectedDate, onSelectedDateChange, onOpenDay,
}: CalendarViewProps) {
  const id = useId();
  const zone = planner.data.settings.timeZone;
  const today = todayInZone(zone);
  const [localDate, setLocalDate] = useState(today);
  const date = selectedDate && isDate(selectedDate) ? selectedDate : localDate;
  const [mode, setMode] = useState<CalendarMode>('month');
  const [error, setError] = useState('');
  const [reloading, setReloading] = useState(false);
  const dates = useMemo(() => calendarDates(date, mode), [date, mode]);
  const days = useMemo(() => dates.map(day => ({
    date: day, entries: entriesForCalendarDay(planner.data, day), capacity: capacityForDay(planner.data, day),
  })), [dates, planner.data]);
  const { recurrenceError, retryRecurring } = useCalendarRecurrence(planner, dates[0], dates[dates.length - 1]);
  const busy = planner.loading || Boolean(planner.loadError);
  const activeDay = days.find(day => day.date === date);
  const dayTasks = activeDay?.entries.filter(entry => entry.kind === 'due' || entry.kind === 'planned') ?? [];
  const dayReminders = useMemo(() => onOpenDay
    ? reminderOccurrences(planner.data, date, date).filter(item => item.status === 'pending')
    : [], [planner.data, date, onOpenDay]);
  const period = mode === 'month'
    ? formatDate(date, { month: 'long', year: 'numeric' })
    : mode === 'week'
      ? `${formatDate(dates[0], { day: 'numeric', month: 'short' })} – ${formatDate(dates[6], { day: 'numeric', month: 'short', year: 'numeric' })}`
      : formatDate(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  function setDate(next: string) {
    setLocalDate(next);
    onSelectedDateChange?.(next);
  }

  function selectDay(day: string, showDayView = false) {
    setDate(day);
    if (showDayView || !onOpenDay) setMode('day');
  }

  function navigate(direction: -1 | 1) {
    setError('');
    try { setDate(shiftCalendarDate(date, mode, direction)); }
    catch { setError('Dieser Zeitraum liegt außerhalb des unterstützten Kalenders.'); }
  }

  function newAppointment(day: string, allDay = false) {
    setError('');
    setDate(day);
    if (allDay) {
      onEditAppointment(undefined, day, { allDay: { startDate: day, endDate: addDays(day, 1) } });
      return;
    }
    try { onEditAppointment(undefined, day, { startAt: localToInstant(day, '09:00', zone), durationMinutes: 60 }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Bitte wähle eine eindeutige Uhrzeit im Terminformular.'); }
  }

  function openEntry(entry: CalendarEntry) {
    if ('appointment' in entry) onEditAppointment(entry.appointment);
    else if (entry.kind === 'block') onEditBlock(entry.block);
    else onEditTask(entry.task);
  }

  function modesKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const modes: CalendarMode[] = ['month', 'week', 'day'];
    const next = event.key === 'ArrowRight' ? (index + 1) % 3
      : event.key === 'ArrowLeft' ? (index + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : null;
    if (next === null) return;
    event.preventDefault();
    setMode(modes[next]);
    document.getElementById(`${id}-${modes[next]}`)?.focus();
  }

  async function reload() {
    setReloading(true); setError('');
    try { await planner.reload(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Der Kalender konnte nicht geladen werden.'); }
    finally { setReloading(false); }
  }

  function entryButton(entry: CalendarEntry, day: string) {
    const done = 'task' in entry && entry.task?.status === 'done';
    const Icon = entry.kind === 'appointment' || entry.kind === 'block' ? Clock3
      : entry.kind === 'all-day' ? CalendarDays : Square;
    return <button
      key={entry.id} type="button"
      className={`nexus-calendar-entry is-${entry.kind}${done ? ' is-done' : ''}${entry.kind === 'due' && !done && day < today ? ' is-overdue' : ''}`}
      onClick={() => { setDate(day); openEntry(entry); }}
      aria-label={`${kindLabels[entry.kind]}: ${entry.title}, ${entry.label}${done ? ', erledigt' : ''}. Bearbeiten`}
    >
      <span><Icon size={13} aria-hidden="true" />{entry.label}</span><strong>{entry.title}</strong>
    </button>;
  }

  return <div className="nexus-calendar" aria-busy={planner.loading}>
    {onOpenDay && <button type="button" className="nexus-calendar-return" onClick={() => onOpenDay(date)}><ArrowLeft size={18} aria-hidden="true" /> Tagesübersicht</button>}
    <header className="nexus-calendar-heading">
      <h1>Kalender<span aria-hidden="true">.</span></h1>
      <div className="nexus-calendar-create-actions">
        <button type="button" className="nexus-calendar-button is-primary" disabled={busy} onClick={() => newAppointment(date)}><Plus size={16} aria-hidden="true" /> Termin</button>
        <button type="button" className="nexus-calendar-button" disabled={busy} onClick={() => onEditBlock(undefined, { date })}><Plus size={16} aria-hidden="true" /> Zeitblock</button>
      </div>
    </header>

    <div className="nexus-calendar-toolbar">
      <div className="nexus-calendar-navigation" aria-label="Kalenderzeitraum wechseln">
        <button type="button" className="nexus-calendar-icon" aria-label={previousLabels[mode]} onClick={() => navigate(-1)}><ChevronLeft size={19} aria-hidden="true" /></button>
        <h2 aria-live="polite">{period}</h2>
        <button type="button" className="nexus-calendar-icon" aria-label={nextLabels[mode]} onClick={() => navigate(1)}><ChevronRight size={19} aria-hidden="true" /></button>
        <button type="button" className="nexus-calendar-button" onClick={() => setDate(today)}>Heute</button>
      </div>
      <div className="nexus-calendar-modes" role="tablist" aria-label="Kalenderansicht">
        {(['month', 'week', 'day'] as const).map((value, index) => <button
          key={value} id={`${id}-${value}`} type="button" role="tab" aria-selected={mode === value}
          aria-controls={`${id}-content`} tabIndex={mode === value ? 0 : -1}
          onClick={() => setMode(value)} onKeyDown={event => modesKeyDown(event, index)}
        >{modeLabels[value]}</button>)}
      </div>
    </div>

    <div className="nexus-calendar-meta">
      <details className="nexus-calendar-key">
        <summary>Legende</summary>
        <div className="nexus-calendar-key-content">
          <ul className="nexus-calendar-legend" aria-label="Eintragsarten">
            {(Object.keys(kindLabels) as CalendarEntry['kind'][]).map(kind => <li key={kind} className={`is-${kind}`}><span aria-hidden="true" />{kindLabels[kind]}</li>)}
          </ul>
          <p>Fälligkeit und Planung sind unabhängig. Ganztägige Termine belegen keine Zeitkapazität.</p>
        </div>
      </details>
      <span>{zone}</span>
    </div>

    {planner.loadError && <div className="nexus-calendar-alert" role="alert"><AlertTriangle size={18} aria-hidden="true" /><div><strong>Kalender konnte nicht geladen werden.</strong><p>{planner.loadError}</p></div><button type="button" className="nexus-calendar-button" disabled={reloading} onClick={() => void reload()}>{reloading ? 'Wird geladen …' : 'Erneut laden'}</button></div>}
    {error && <p className="nexus-calendar-alert" role="alert"><AlertTriangle size={17} aria-hidden="true" />{error}</p>}
    {recurrenceError && <div className="nexus-calendar-alert" role="alert"><p>{recurrenceError}</p><button type="button" className="nexus-calendar-button" onClick={retryRecurring}>Wiederholungen erneut laden</button></div>}
    {planner.loading ? <p className="nexus-calendar-loading" role="status">Dein Kalender wird geladen …</p> : !planner.loadError && <>
      <div className={`nexus-calendar-workspace is-${mode}${onOpenDay ? ' has-agenda' : ''}`}>
      <section id={`${id}-content`} role="tabpanel" aria-labelledby={`${id}-${mode}`} className={`nexus-calendar-content is-${mode}`}>
        {mode !== 'day' ? <>
          <div className="nexus-calendar-weekdays" aria-hidden="true">{dates.slice(0, 7).map(day => <span key={day}>{formatDate(day, { weekday: 'short' })}</span>)}</div>
          <div className="nexus-calendar-grid">
            {days.map(day => {
              const outside = mode === 'month' && day.date.slice(0, 7) !== date.slice(0, 7);
              const limit = mode === 'month' ? 3 : day.entries.length;
              const remaining = day.entries.length - limit;
              return <section key={day.date} className={`nexus-calendar-cell${outside ? ' is-outside' : ''}${day.date === today ? ' is-today' : ''}${day.date === date ? ' is-selected' : ''}`} aria-label={dayLabel(day.date)}>
                <header>
                  <button type="button" className="nexus-calendar-date" aria-current={day.date === today ? 'date' : undefined} aria-pressed={day.date === date} aria-label={`${dayLabel(day.date)} ${onOpenDay ? 'auswählen' : 'in der Tagesansicht öffnen'}${day.date === today ? ', heute' : ''}`} onClick={() => selectDay(day.date)}>
                    <span className="nexus-calendar-mobile-weekday">{formatDate(day.date, { weekday: 'short' })}</span>
                    <time dateTime={day.date}>{formatDate(day.date, { day: 'numeric' })}</time>
                    {mode === 'week' && <span>{formatDate(day.date, { month: 'short' })}</span>}
                  </button>
                  <button type="button" className="nexus-calendar-cell-add" aria-label={`Termin am ${dayLabel(day.date)} erstellen`} onClick={() => newAppointment(day.date)}><Plus size={13} aria-hidden="true" /></button>
                </header>
                <div className="nexus-calendar-entries">{day.entries.slice(0, limit).map(entry => entryButton(entry, day.date))}</div>
                {remaining > 0 && <button type="button" className="nexus-calendar-more" onClick={() => selectDay(day.date, true)} aria-label={`${remaining} weitere Einträge am ${dayLabel(day.date)} öffnen`}>+ {remaining} weitere</button>}
                <button type="button" className="nexus-calendar-empty-slot" aria-label={`Freie Fläche am ${dayLabel(day.date)}: Termin um 09:00 erstellen`} onClick={() => newAppointment(day.date)}><Plus size={14} aria-hidden="true" /><span>Termin erstellen</span></button>
                {mode === 'week' && <div className={`nexus-calendar-capacity${day.capacity.remainingMinutes < 0 ? ' is-over' : ''}`}><Clock3 size={12} aria-hidden="true" /><span>{minutesLabel(day.capacity.usedMinutes)} / {minutesLabel(day.capacity.availableMinutes)}<small>{day.capacity.remainingMinutes < 0 ? `${minutesLabel(-day.capacity.remainingMinutes)} überplant` : `${minutesLabel(day.capacity.remainingMinutes)} frei`}</small><meter min={0} max={Math.max(1, day.capacity.availableMinutes)} value={Math.min(day.capacity.usedMinutes, Math.max(1, day.capacity.availableMinutes))} aria-label={`${minutesLabel(day.capacity.usedMinutes)} von ${minutesLabel(day.capacity.availableMinutes)} eingeplant`} /></span></div>}
              </section>;
            })}
          </div>
        </> : <>
          <div className="nexus-calendar-day-actions">
            <button type="button" className="nexus-calendar-button" onClick={() => newAppointment(date, true)}><CalendarDays size={15} aria-hidden="true" /> Ganztägiger Termin</button>
            <button type="button" className="nexus-calendar-button" onClick={() => onEditTask(undefined, { plan: { kind: 'day', date } })}><Plus size={15} aria-hidden="true" /> Aufgabe für diesen Tag</button>
            {activeDay && <span className={`nexus-calendar-day-capacity${activeDay.capacity.remainingMinutes < 0 ? ' is-over' : ''}`}>{minutesLabel(activeDay.capacity.usedMinutes)} von {minutesLabel(activeDay.capacity.availableMinutes)} eingeplant{activeDay.capacity.unestimatedCount > 0 ? ` · ${activeDay.capacity.unestimatedCount} ohne Schätzung` : ''}</span>}
          </div>
          {dayTasks.length > 0 && <section className="nexus-calendar-day-tasks" aria-label="Fälligkeiten und Tagesplanung">
            {dayTasks.map(entry => <div key={entry.id} className="nexus-calendar-task-row">
              {entryButton(entry, date)}
              {'task' in entry && entry.task && entry.task.noteIds.map(noteId => {
                const note = notes.find(item => item.id === noteId);
                return note ? <button key={noteId} type="button" className="nexus-calendar-note" onClick={() => onOpenNote(noteId)}><Link2 size={12} aria-hidden="true" />{note.title || 'Ohne Titel'}{note.deletedAt ? ' · Papierkorb' : ''}</button> : null;
              })}
            </div>)}
          </section>}
          <Timeline planner={planner} date={date} onEditAppointment={onEditAppointment} onEditBlock={onEditBlock} />
        </>}
      </section>
      {onOpenDay && mode !== 'day' && <aside className="nexus-calendar-agenda" aria-label={`Agenda für ${dayLabel(date)}`}>
        <h2 aria-live="polite">{formatDate(date, { weekday: 'long', day: 'numeric' })}</h2>
        <div className="nexus-calendar-agenda-list">
          {activeDay?.entries.map(entry => {
            const task = 'task' in entry ? entry.task : undefined;
            const progress = subtaskProgress(task?.subtasks ?? []);
            const duration = 'appointment' in entry && !entry.appointment.allDay ? entry.appointment.durationMinutes
              : entry.kind === 'block' ? entry.block.durationMinutes : task?.estimatedMinutes ?? null;
            const Icon = entry.kind === 'appointment' || entry.kind === 'block' ? Clock3
              : entry.kind === 'all-day' ? CalendarDays : Square;
            return <button key={entry.id} type="button" className={`nexus-calendar-agenda-entry is-${entry.kind}${task?.status === 'done' ? ' is-done' : ''}`} onClick={() => openEntry(entry)} aria-label={`${kindLabels[entry.kind]}: ${entry.title}. Bearbeiten`}>
              <Icon size={19} aria-hidden="true" />
              <span className="nexus-calendar-agenda-time">{entry.kind === 'block' ? formatTime(entry.block.startAt, zone) : entry.kind === 'planned' ? 'Geplant' : entry.label}</span>
              <span className="nexus-calendar-agenda-description"><strong>{entry.title}</strong><small>{kindLabels[entry.kind]}{duration !== null ? ` · ${minutesLabel(duration)}` : ''}{task?.subtasks.length ? ` · ${progress.done}/${progress.total} Unteraufgaben` : ''}</small></span>
            </button>;
          })}
          {dayReminders.map(item => <button key={item.id} type="button" className="nexus-calendar-agenda-entry is-reminder" onClick={() => onEditReminder(item.reminder)} aria-label={`Erinnerung: ${item.reminder.title}. Bearbeiten`}>
            <Bell size={19} aria-hidden="true" /><span className="nexus-calendar-agenda-time">{formatTime(item.effectiveAt, zone)}</span><span className="nexus-calendar-agenda-description"><strong>{item.reminder.title}</strong><small>Erinnerung{item.adjusted ? ' · Zeitumstellung berücksichtigt' : ''}</small></span>
          </button>)}
          {!activeDay?.entries.length && !dayReminders.length && <p className="nexus-calendar-agenda-empty">Für diesen Tag ist noch nichts eingetragen.</p>}
        </div>
        <button type="button" className="nexus-calendar-open-day" onClick={() => onOpenDay(date)}>Diesen Tag öffnen <ArrowRight size={18} aria-hidden="true" /></button>
        <button type="button" className="nexus-calendar-agenda-timeline" onClick={() => setMode('day')}>Zeitverlauf im Kalender</button>
      </aside>}
      </div>
    </>}
  </div>;
}

export default CalendarView;
