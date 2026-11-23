import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import {
  AlertTriangle, ArrowRight, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight,
  Clock3, GripVertical, Inbox, Link2, Mic, Plus, Repeat2, Sparkles, Target,
} from 'lucide-react';
import { TaskList } from '../components/TaskList';
import {
  addDays, dateInZone, formatDate, formatTime, isDate, startOfWeek,
  todayInZone, weekDates,
} from '../dates';
import {
  allDayAppointmentsForDay, conflictsForDay, inboxTasks, tasksForDay, timedAppointmentsForDay, weekPool,
} from '../selectors';
import { capacityForDay } from '../capacity';
import { blocksForCalendarDay } from '../../calendar/calendarModel';
import { useCalendarRecurrence } from '../../calendar/useCalendarRecurrence';
import { TASK_DRAG_TYPE as taskDragType } from '../timeline/layout';
import type { Appointment, PlannerViewProps, Task, TaskPlan, TimeBlock, WeekPlan } from '../types';
import { weekDayHighlights, weekDayTime, type WeekAgendaItem } from './weekPresentation';
import './WeekView.css';

export type WeekViewProps = PlannerViewProps & {
  weekStart: string;
  onWeekChange: (weekStart: string) => void;
  onOpenDay: (date: string) => void;
};

function dateLabel(date: string, options: Intl.DateTimeFormatOptions): string {
  return formatDate(date, { day: undefined, month: undefined, year: undefined, ...options });
}

function durationLabel(minutes: number): string {
  const rounded = Math.round(minutes);
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  if (!hours) return `${rest} Min.`;
  return rest ? `${hours} Std. ${rest} Min.` : `${hours} Std.`;
}

function planKey(plan: TaskPlan): string {
  if (!plan) return 'inbox';
  return plan.kind === 'day' ? `day:${plan.date}` : `week:${plan.weekStart}`;
}

function planLabel(plan: TaskPlan): string {
  if (!plan) return 'im Eingang';
  return plan.kind === 'day'
    ? `am ${dateLabel(plan.date, { weekday: 'short', day: 'numeric', month: 'short' })}`
    : `in der Woche ab ${dateLabel(plan.weekStart, { day: 'numeric', month: 'short' })}`;
}

function planFromKey(key: string): TaskPlan {
  if (key.startsWith('day:')) return { kind: 'day', date: key.slice(4) };
  if (key.startsWith('week:')) return { kind: 'week', weekStart: key.slice(5) };
  return null;
}

function intervalLabel(entry: Appointment | TimeBlock, date: string, zone: string): string {
  const end = new Date(Date.parse(entry.startAt) + entry.durationMinutes * 60_000);
  const firstDay = dateInZone(entry.startAt, zone);
  const lastDay = dateInZone(end, zone);
  const start = firstDay < date
    ? `seit ${dateLabel(firstDay, { weekday: 'short' })}, ${formatTime(entry.startAt, zone)}`
    : formatTime(entry.startAt, zone);
  const finish = `${formatTime(end.toISOString(), zone)}${lastDay > date
    ? ` (${dateLabel(lastDay, { weekday: 'short' })})`
    : ''}`;
  return `${start} – ${finish}`;
}

function uniqueTasks(tasks: Task[]): Task[] {
  return [...new Map(tasks.map(task => [task.id, task])).values()];
}

function DayHighlights({ activities, remainingActivities, routines, fallback }: ReturnType<typeof weekDayHighlights>) {
  return <span className="week-day-preview-copy">
    {activities.length > 0 ? (
      <span className="week-day-activities">
        {activities.map(({ id, title, time, startAt }, index) => (
          <span className="week-day-activity" key={id} title={`${time} ${title}`}>
            {index > 0 && <span aria-hidden="true">·</span>}
            <time dateTime={startAt}>{time}</time><strong>{title}</strong>
          </span>
        ))}
        {remainingActivities > 0 && <span className="week-day-more-activities">+{remainingActivities}<span className="week-sr-only"> weitere feste Einträge</span></span>}
      </span>
    ) : <strong className="week-day-fallback">{fallback}</strong>}
    {routines.length > 0 && (
      <span className="week-day-routines" title={routines.join(' · ')}>
        <Repeat2 size={15} aria-hidden="true" />
        <span className="week-day-routines-label">Routinen</span>
        <span className="week-day-routines-list">{routines.slice(0, 2).join(' · ')}{routines.length > 2 && ` · +${routines.length - 2}`}</span>
      </span>
    )}
  </span>;
}

interface TaskPlacementProps {
  task: Task;
  dates: string[];
  weekStart: string;
  blockCount: number;
  busy: boolean;
  onMove: (task: Task, plan: TaskPlan) => Promise<void>;
  onDrag: (taskId: string | null) => void;
}

function TaskPlacement({ task, dates, weekStart, blockCount, busy, onMove, onDrag }: TaskPlacementProps) {
  const id = useId();
  const current = planKey(task.plan);
  const [target, setTarget] = useState(current);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => { setTarget(current); }, [current]);

  const hasCurrentOption = current === 'inbox'
    || current === `week:${weekStart}`
    || dates.some(date => current === `day:${date}`);
  const changed = target !== current;
  const warningId = `${id}-warning`;
  const targetPlan = planFromKey(target);
  const keepsBlocks = targetPlan?.kind === 'day' || (targetPlan?.kind === 'week' && task.plan?.kind === 'week');

  async function submit() {
    if (!changed || busy || submitting) return;
    setSubmitting(true);
    try { await onMove(task, planFromKey(target)); }
    finally { setSubmitting(false); }
  }

  return (
    <div className="week-placement">
      <div className="week-placement-title-row">
        <button type="button" className="week-task-drag" draggable={!busy} disabled={busy}
          aria-label={`„${task.title}“ auf einen Tag ziehen. Alternativ Planung mit dem Auswahlfeld ändern.`}
          title="Auf einen Tag ziehen · oder Auswahlfeld verwenden"
          onDragStart={event => { event.dataTransfer.setData(taskDragType, task.id); event.dataTransfer.effectAllowed = 'move'; onDrag(task.id); }}
          onDragEnd={() => onDrag(null)}><GripVertical size={16} aria-hidden="true" /></button>
        <label htmlFor={id} className="week-placement-title">{task.title}</label>
      </div>
      <div className="week-placement-controls">
        <select
          id={id}
          value={target}
          disabled={busy || submitting}
          aria-label={`Planung für „${task.title}“`}
          aria-describedby={changed && blockCount > 0 ? warningId : undefined}
          onChange={event => setTarget(event.target.value)}
        >
          {!hasCurrentOption && <option value={current}>Aktuell {planLabel(task.plan)}</option>}
          <option value="inbox">Eingang · ohne Planung</option>
          <option value={`week:${weekStart}`}>Wochenpool · ohne Tag</option>
          {dates.map(date => (
            <option key={date} value={`day:${date}`}>
              {dateLabel(date, { weekday: 'long', day: 'numeric', month: 'short' })}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="week-button week-placement-submit"
          disabled={!changed || busy || submitting}
          onClick={() => { void submit(); }}
          aria-label={`„${task.title}“ verschieben`}
        >
          <ArrowRight size={15} aria-hidden="true" />
          <span>{submitting ? 'Wird verschoben …' : 'Verschieben'}</span>
        </button>
      </div>
      {changed && blockCount > 0 && (
        <p className="week-placement-warning" id={warningId}>
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{keepsBlocks
            ? `${blockCount === 1 ? 'Der Zeitblock wird' : `Alle ${blockCount} Zeitblöcke werden`} um denselben Tagesabstand mitverschoben; Uhrzeit und Dauer bleiben erhalten.`
            : `Ohne konkreten Zieltag ${blockCount === 1 ? 'wird der Zeitblock' : `werden alle ${blockCount} Zeitblöcke`} dieser Aufgabe entfernt.`} Die Fälligkeit bleibt unverändert.</span>
        </p>
      )}
    </div>
  );
}

export function WeekView({
  planner, notes, weekStart, onWeekChange, onOpenDay, onEditTask,
  onEditAppointment, onEditBlock, onOpenNote, onDictate, onAI,
}: WeekViewProps) {
  const viewId = useId();
  const { data } = planner;
  const zone = data.settings.timeZone;
  const today = todayInZone(zone);
  const start = startOfWeek(isDate(weekStart) ? weekStart : today);
  const currentWeek = startOfWeek(today);
  const dates = useMemo(() => weekDates(start), [start]);
  const lastDate = dates.at(-1) ?? start;
  const rangeLabel = `${dateLabel(start, { day: 'numeric', month: start.slice(0, 7) === lastDate.slice(0, 7) ? undefined : 'long', year: start.slice(0, 4) === lastDate.slice(0, 4) ? undefined : 'numeric' })} – ${dateLabel(lastDate, { day: 'numeric', month: 'long', year: 'numeric' })}`;
  const [activeDate, setActiveDate] = useState(() => dates.includes(today) ? today : start);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropDate, setDropDate] = useState<string | null>(null);
  const [expandedDate, setExpandedDate] = useState<string | null>(null);
  const goalsField = useRef<HTMLTextAreaElement>(null);
  const { recurrenceError, retryRecurring } = useCalendarRecurrence(planner, start, lastDate);

  useEffect(() => {
    setActiveDate(previous => dates.includes(previous) ? previous : dates.includes(today) ? today : start);
    setMessage('');
    setActionError(null);
    setDraggingId(null);
    setDropDate(null);
    setExpandedDate(null);
  }, [dates, start, today]);

  const pool = useMemo(() => weekPool(data, start), [data.tasks, start]);
  const inbox = useMemo(() => inboxTasks(data), [data.tasks, data.timeBlocks]);
  const taskMap = useMemo(() => new Map(data.tasks.map(task => [task.id, task])), [data.tasks]);
  const blockCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const block of data.timeBlocks) counts.set(block.taskId, (counts.get(block.taskId) ?? 0) + 1);
    return counts;
  }, [data.timeBlocks]);

  const days = useMemo(() => dates.map(date => {
    const tasks = tasksForDay(data, date);
    const agenda: WeekAgendaItem[] = [
      ...timedAppointmentsForDay(data, date).map(entry => ({ kind: 'appointment' as const, entry })),
      ...blocksForCalendarDay(data, date).map(entry => ({ kind: 'block' as const, entry, task: taskMap.get(entry.taskId) })),
    ]
      .sort((a, b) => Date.parse(a.entry.startAt) - Date.parse(b.entry.startAt)
        || a.entry.id.localeCompare(b.entry.id));
    const capacity = capacityForDay(data, date);
    return {
      date, tasks, agenda,
      allDay: allDayAppointmentsForDay(data, date),
      due: data.tasks.filter(task => task.dueDate === date),
      capacity,
      time: weekDayTime(date, capacity.usedMinutes, tasks, blockCounts),
      minutes: capacity.usedMinutes,
      available: capacity.availableMinutes,
      conflicts: conflictsForDay(data, date),
    };
  }), [data, dates, taskMap, blockCounts]);
  const routineRuleIds = useMemo(() => new Set(data.taskRules?.filter(rule => rule.frequency !== 'weekly').map(rule => rule.id)), [data.taskRules]);

  const weekTasks = useMemo(() => uniqueTasks([
    ...pool, ...days.flatMap(day => day.tasks),
  ]), [pool, days]);
  const completed = weekTasks.filter(task => task.status === 'done').length;
  const overdue = weekTasks.filter(task => task.status !== 'done' && task.dueDate !== null && task.dueDate < today);
  const weekFixedMinutes = days.reduce((total, day) => total + day.time.fixedMinutes, 0);
  const weekFlexibleMinutes = days.reduce((total, day) => total + day.time.flexibleMinutes, 0);
  const week: WeekPlan = data.weeks.find(item => item.weekStart === start)
    ?? { weekStart: start, goals: '', review: '' };
  const [weekDraft, setWeekDraft] = useState<WeekPlan>(week);
  useEffect(() => { setWeekDraft(week); }, [week.weekStart, week.goals, week.review]);
  const draft = weekDraft.weekStart === start ? weekDraft : week;
  const linkedNotes = useMemo(() => {
    const ids = new Set(weekTasks.flatMap(task => task.noteIds));
    return notes.filter(note => ids.has(note.id));
  }, [notes, weekTasks]);

  async function moveTask(task: Task, plan: TaskPlan) {
    if (movingId || planKey(task.plan) === planKey(plan)) return;
    setMovingId(task.id);
    setActionError(null);
    setMessage('');
    try {
      await planner.moveTask(task.id, plan);
      setMessage(`„${task.title}“ ist jetzt ${planLabel(plan)}. Die Fälligkeit bleibt unverändert.`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Die Aufgabe konnte nicht verschoben werden. Bitte erneut versuchen.');
    } finally {
      setMovingId(null);
    }
  }

  function dragOver(event: DragEvent<HTMLElement>, date: string) {
    if (movingId || !event.dataTransfer.types.includes(taskDragType)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropDate(date);
  }

  function dropTask(event: DragEvent<HTMLElement>, date: string) {
    if (!event.dataTransfer.types.includes(taskDragType)) return;
    event.preventDefault();
    const task = taskMap.get(event.dataTransfer.getData(taskDragType));
    setDraggingId(null); setDropDate(null);
    if (task) void moveTask(task, { kind: 'day', date });
  }

  function updateWeek(field: 'goals' | 'review', value: string) {
    const updated = { ...draft, [field]: value };
    setWeekDraft(updated);
    setActionError(null);
    try { planner.updateWeek(updated); }
    catch (error) {
      setActionError(error instanceof Error ? error.message : 'Die Wochenplanung konnte nicht aktualisiert werden.');
    }
  }

  function openGoals() {
    const field = goalsField.current;
    const panel = field?.closest('details');
    if (panel) panel.open = true;
    field?.focus();
  }

  async function reload() {
    setReloading(true);
    setActionError(null);
    try { await planner.reload(); }
    catch (error) {
      setActionError(error instanceof Error ? error.message : 'Die Planung konnte nicht geladen werden.');
    } finally { setReloading(false); }
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % dates.length;
    else if (event.key === 'ArrowLeft') next = (index + dates.length - 1) % dates.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = dates.length - 1;
    else return;
    event.preventDefault();
    setActiveDate(dates[next]);
    document.getElementById(`${viewId}-tab-${dates[next]}`)?.focus();
  }

  function placements(tasks: Task[]) {
    return tasks.map(task => (
      <TaskPlacement
        key={task.id} task={task} dates={dates} weekStart={start}
        blockCount={blockCounts.get(task.id) ?? 0} busy={movingId !== null}
        onMove={moveTask}
        onDrag={taskId => { setDraggingId(taskId); if (!taskId) setDropDate(null); }}
      />
    ));
  }

  return (
    <div className="week-view" aria-busy={planner.loading}>
      <header className="week-heading">
        <div className="week-heading-copy">
          <span className="week-eyebrow"><span aria-hidden="true" /> 04 / WOCHENPLAN</span>
          <h1>Diese <em>Woche</em><span aria-hidden="true">.</span></h1>
        </div>
        <div className="week-heading-actions" aria-label="Wochenaktionen">
          <button type="button" className="week-button week-button-primary" onClick={() => onEditTask(undefined, { plan: { kind: 'week', weekStart: start } })} disabled={planner.loading || !!planner.loadError}>
            <Plus size={17} aria-hidden="true" /> Aufgabe
          </button>
          <button type="button" className="week-button" onClick={() => onEditAppointment(undefined, activeDate)} disabled={planner.loading || !!planner.loadError}>
            <CalendarDays size={16} aria-hidden="true" /> Termin
          </button>
          <button type="button" className="week-button" onClick={() => onEditBlock(undefined, { date: activeDate })} disabled={planner.loading || !!planner.loadError}>
            <Plus size={16} aria-hidden="true" /> Zeitblock
          </button>
          <button type="button" className="week-button" aria-label="Aufgaben diktieren" onClick={onDictate} disabled={planner.loading || !!planner.loadError}>
            <Mic size={16} aria-hidden="true" /> <span>Diktieren</span>
          </button>
          <button type="button" className="week-button week-button-ai" aria-label="Mit KI planen" onClick={onAI} disabled={planner.loading || !!planner.loadError}>
            <Sparkles size={16} aria-hidden="true" /> KI planen
          </button>
        </div>
      </header>

      <div className="week-toolbar">
        <div className="week-navigation" aria-label="Woche wechseln">
          <button type="button" className="week-button week-icon-button" aria-label="Vorherige Woche" onClick={() => onWeekChange(addDays(start, -7))}>
            <ChevronLeft size={19} aria-hidden="true" />
          </button>
          <div className="week-navigation-period" aria-live="polite">
            <strong>{rangeLabel}</strong>
          </div>
          <button type="button" className="week-button week-icon-button" aria-label="Nächste Woche" onClick={() => onWeekChange(addDays(start, 7))}>
            <ChevronRight size={19} aria-hidden="true" />
          </button>
          <button type="button" className="week-button week-current-button" onClick={() => { setActiveDate(today); onWeekChange(currentWeek); }} disabled={start === currentWeek}>
            Aktuelle Woche
          </button>
        </div>
        <label className="week-date-picker">
          <span>Woche ab</span>
          <input type="date" value={start} aria-label="Woche auswählen" onChange={event => { if (isDate(event.target.value)) onWeekChange(startOfWeek(event.target.value)); }} />
        </label>
        <span className="week-timezone"><Clock3 size={14} aria-hidden="true" /> {zone}</span>
      </div>

      {planner.loadError && (
        <div className="week-alert week-alert-error" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <div><strong>Planung konnte nicht geladen werden.</strong><p>{planner.loadError}</p></div>
          <button type="button" className="week-button" disabled={reloading} onClick={() => { void reload(); }}>{reloading ? 'Wird geladen …' : 'Erneut laden'}</button>
        </div>
      )}
      {actionError && <p className="week-alert week-alert-error" role="alert"><AlertTriangle size={17} aria-hidden="true" /> {actionError}</p>}
      {recurrenceError && <div className="week-alert week-alert-error" role="alert"><p>{recurrenceError}</p><button type="button" className="week-button" onClick={retryRecurring}>Wiederholungen erneut laden</button></div>}
      <div className="week-announcement" role="status" aria-live="polite">{message}</div>

      {planner.loading ? <p className="week-loading" role="status">Deine Wochenplanung wird geladen …</p> : !planner.loadError && (
        <>
          <div className="week-overview" aria-label="Wochenüberblick">
            <div className="week-overview-item">
              <CheckCircle2 size={18} aria-hidden="true" />
              <div><strong>{completed} / {weekTasks.length}</strong><span>erledigt</span></div>
            </div>
            <div className="week-overview-item">
              <CalendarDays size={18} aria-hidden="true" />
              <div><strong>{durationLabel(weekFixedMinutes)}</strong><span>feste Zeit</span></div>
            </div>
            <div className="week-overview-item">
              <Clock3 size={18} aria-hidden="true" />
              <div><strong>{durationLabel(weekFlexibleMinutes)}</strong><span>flexibel eingeplant</span></div>
            </div>
            <div className="week-overview-item">
              <Inbox size={18} aria-hidden="true" />
              <div><strong>{pool.length}</strong><span>ohne Tag</span></div>
            </div>
            {overdue.length > 0 && (
              <div className="week-overview-item week-overview-overdue">
                <AlertTriangle size={18} aria-hidden="true" />
                <div><strong>{overdue.length}</strong><span>überfällig</span></div>
              </div>
            )}
            <button type="button" className="week-text-button week-goals-jump" onClick={openGoals}>
              <Target size={16} aria-hidden="true" /> Wochenziele bearbeiten
            </button>
          </div>

          <div className="week-workspace">
          <div className="week-agenda-column">
          <div className="week-mobile-tabs" role="tablist" aria-label="Tag der Woche auswählen">
            {dates.map((date, index) => (
              <button
                key={date} type="button" role="tab" id={`${viewId}-tab-${date}`}
                aria-selected={date === activeDate} aria-controls={`${viewId}-day-${date}`}
                tabIndex={date === activeDate ? 0 : -1}
                className={`${date === activeDate ? 'is-active' : ''} ${date === today ? 'is-today' : ''}`}
                onClick={() => setActiveDate(date)} onKeyDown={event => onTabKeyDown(event, index)}
              >
                <span>{dateLabel(date, { weekday: 'short' })}</span>
                <strong>{dateLabel(date, { day: 'numeric' })}</strong>
                {date === today && <span className="week-sr-only">Heute</span>}
              </button>
            ))}
          </div>

          <header className="week-days-label">
            <h2>Tage der Woche</h2><span aria-hidden="true">Geplante Zeit</span>
          </header>
          <div className="week-days" key={start} aria-label="Montag bis Sonntag">
            {days.map(day => {
              const isToday = day.date === today;
              const dayDone = day.tasks.filter(task => task.status === 'done').length;
              const overBudget = day.minutes > day.available;
              const highlights = weekDayHighlights(day.date, zone, day.agenda, day.tasks, routineRuleIds, day.allDay, day.due);
              const fixedTime = durationLabel(day.time.fixedMinutes);
              const flexibleTime = durationLabel(day.time.flexibleMinutes);
              return (
                <section
                  key={day.date} id={`${viewId}-day-${day.date}`}
                  className={`week-day ${day.date === activeDate ? 'is-active' : ''} ${isToday ? 'is-today' : ''} ${expandedDate === day.date ? 'is-expanded' : ''} ${dropDate === day.date ? 'is-drop-target' : ''} ${draggingId ? 'can-drop-task' : ''}`}
                  role="tabpanel" aria-labelledby={`${viewId}-tab-${day.date}`}
                  onDragOver={event => dragOver(event, day.date)} onDrop={event => dropTask(event, day.date)}
                  onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropDate(null); }}
                >
                  <header className="week-day-heading">
                    <button type="button" className="week-day-open" onClick={() => onOpenDay(day.date)} aria-label={`${dateLabel(day.date, { weekday: 'long', day: 'numeric', month: 'long' })} in der Tagesansicht öffnen`}>
                      <span className="week-day-name"><span className="week-day-name-long">{dateLabel(day.date, { weekday: 'long' })}</span><span className="week-day-name-short" aria-hidden="true">{dateLabel(day.date, { weekday: 'short' })}</span></span>
                      <span className="week-day-number">{dateLabel(day.date, { day: 'numeric' })}<span className="week-day-month">{dateLabel(day.date, { month: 'short' })}</span></span>
                      {isToday && <span className="week-today-label">Heute</span>}
                    </button>
                    <button type="button" className="week-day-preview" aria-expanded={expandedDate === day.date} aria-controls={`${viewId}-details-${day.date}`} onClick={() => { setActiveDate(day.date); setExpandedDate(previous => previous === day.date ? null : day.date); }}>
                      <span className="week-sr-only">Tagesdetails für {dateLabel(day.date, { weekday: 'long', day: 'numeric', month: 'long' })}</span>
                      <DayHighlights {...highlights} />
                      <span className={`week-day-preview-duration${overBudget ? ' is-over-budget' : ''}`}>
                        <span className="week-day-time"><strong>{fixedTime}</strong><span>fest</span></span>
                        <span className="week-day-time"><strong>{flexibleTime}</strong><span>flexibel</span></span>
                        {overBudget && <span className="week-sr-only">Über Tagesbudget</span>}
                        {day.conflicts.length > 0 && <span className="week-day-preview-conflicts"><AlertTriangle size={12} aria-hidden="true" /> {day.conflicts.length === 1 ? 'Zeitkonflikt' : `${day.conflicts.length} Zeitkonflikte`}</span>}
                      </span>
                      <ChevronRight size={18} aria-hidden="true" />
                    </button>
                    <button type="button" className="week-button week-icon-button week-day-quick-add" aria-label={`Aufgabe für ${dateLabel(day.date, { weekday: 'long', day: 'numeric', month: 'long' })} erstellen`} onClick={() => onEditTask(undefined, { plan: { kind: 'day', date: day.date } })}>
                      <Plus size={16} aria-hidden="true" />
                    </button>
                  </header>
                  <div className="week-day-highlights"><DayHighlights {...highlights} /></div>
                  <div className={`week-day-capacity ${overBudget ? 'is-over-budget' : ''}`}>
                    <div className="week-day-time-details">
                      <span className="week-day-time"><strong>{fixedTime}</strong><span>fest</span></span>
                      <span className="week-day-time"><strong>{flexibleTime}</strong><span>flexibel</span></span>
                    </div>
                    <span>{durationLabel(day.available)} verfügbar</span>
                    <meter min={0} max={Math.max(1, day.available)} value={Math.min(day.minutes, Math.max(1, day.available))} aria-label={`${durationLabel(day.minutes)} von ${durationLabel(day.available)} am ${dateLabel(day.date, { weekday: 'long' })} eingeplant`} />
                    {overBudget && <span className="week-capacity-warning">{durationLabel(day.minutes - day.available)} über der verfügbaren Zeit</span>}
                    {day.capacity.outsideMinutes > 0 && <span className="week-capacity-warning">{durationLabel(day.capacity.outsideMinutes)} außerhalb verfügbarer Zeitfenster</span>}
                    {day.capacity.unestimatedCount > 0 && <span>{day.capacity.unestimatedCount} {day.capacity.unestimatedCount === 1 ? 'Aufgabe' : 'Aufgaben'} ohne Schätzung</span>}
                  </div>

                  {day.conflicts.length > 0 && (
                    <details className="week-day-conflicts">
                      <summary><AlertTriangle size={14} aria-hidden="true" /> {day.conflicts.length === 1 ? 'Zeitkonflikt' : `${day.conflicts.length} Zeitkonflikte`}</summary>
                      <ul>{day.conflicts.map((conflict, index) => <li key={`${conflict.ids.join('-')}-${index}`}>{conflict.message}</li>)}</ul>
                    </details>
                  )}

                  <div className="week-day-body" id={`${viewId}-details-${day.date}`}>
                    {day.allDay.length > 0 && <div className="week-all-day" aria-label="Ganztägige Termine">
                      {day.allDay.map(appointment => <button key={appointment.id} type="button" onClick={() => onEditAppointment(appointment)}><span>Ganztägig</span><strong>{appointment.title}</strong></button>)}
                    </div>}
                    {day.due.length > 0 && <div className="week-due" aria-label="Fälligkeiten">
                      {day.due.map(task => <button key={task.id} type="button" className={task.status === 'done' ? 'is-done' : ''} onClick={() => onEditTask(task)}><span>Fällig{task.status === 'done' ? ' · erledigt' : ''}</span><strong>{task.title}</strong></button>)}
                    </div>}
                    <div className="week-day-section-title"><Clock3 size={13} aria-hidden="true" /><h2>Agenda</h2><span>{day.agenda.length}</span></div>
                    {day.agenda.length ? (
                      <ol className="week-agenda">
                        {day.agenda.map(item => (
                          <li key={`${item.kind}-${item.entry.id}`} className={`week-agenda-item week-agenda-${item.kind} ${item.kind === 'block' && item.task?.status === 'done' ? 'is-done' : ''}`}>
                            <button type="button" className="week-agenda-edit" onClick={() => item.kind === 'appointment' ? onEditAppointment(item.entry) : onEditBlock(item.entry)} aria-label={`${item.kind === 'appointment' ? `Termin „${item.entry.title}“` : `Zeitblock für „${item.task?.title ?? 'Aufgabe'}“`} bearbeiten`}>
                              <time dateTime={item.entry.startAt}>{intervalLabel(item.entry, day.date, zone)}</time>
                              <strong>{item.kind === 'appointment' ? item.entry.title : item.task?.title ?? 'Verknüpfte Aufgabe'}</strong>
                              <span>{item.kind === 'appointment' ? 'Termin' : 'Zeitblock'} · {durationLabel(item.entry.durationMinutes)}{dateInZone(item.entry.startAt, zone) !== dateInZone(new Date(Date.parse(item.entry.startAt) + item.entry.durationMinutes * 60_000 - 1), zone) ? ' gesamt' : ''}</span>
                            </button>
                            {item.kind === 'block' && item.task && (
                              <button type="button" className="week-agenda-task-link" onClick={() => onEditTask(item.task)}><Link2 size={12} aria-hidden="true" /> Aufgabe öffnen</button>
                            )}
                          </li>
                        ))}
                      </ol>
                    ) : <p className="week-day-empty">Keine Termine</p>}

                    <div className="week-day-section-title week-tasks-title"><CheckCircle2 size={13} aria-hidden="true" /><h2>Aufgaben</h2><span>{dayDone}/{day.tasks.length}</span></div>
                    <TaskList tasks={day.tasks} planner={planner} onEditTask={onEditTask} compact emptyText="Noch frei" />
                    {day.tasks.length > 0 && (
                      <details className="week-day-move">
                        <summary>Planung ändern <ArrowRight size={13} aria-hidden="true" /></summary>
                        <div className="week-day-move-list">{placements(day.tasks)}</div>
                      </details>
                    )}
                  </div>
                  <footer className="week-day-footer">
                    <button type="button" className="week-text-button" onClick={() => onEditAppointment(undefined, day.date)}><Plus size={13} aria-hidden="true" /> Termin</button>
                    <button type="button" className="week-text-button" onClick={() => onEditBlock(undefined, { date: day.date })}><Plus size={13} aria-hidden="true" /> Zeitblock</button>
                  </footer>
                </section>
              );
            })}
          </div>

          <details className="week-capacity-info">
            <summary>Wie wird die Zeit berechnet?</summary>
            <p className="week-time-explanation">Feste Zeit umfasst Termine mit Uhrzeit und Zeitblöcke. Bei Überschneidungen zählen gemeinsame Minuten einmal. Flexibel eingeplant ist die Schätzung einer Tagesaufgabe ohne eigenen Zeitblock. Ganztägige Termine und Fälligkeiten belegen keine Minuten. {data.settings.capacity?.enabled ? 'Zeitfenster und Puffer bestimmen die Kapazität.' : 'Es gelten deine Tagesbudgets.'} Alle Uhrzeiten in {zone}.</p>
          </details>
          </div>

          <div className="week-lower-grid">
            <section className={`week-panel week-pool${pool.length ? '' : ' is-empty'}`} aria-labelledby={`${viewId}-pool-heading`}>
              <header className="week-panel-heading">
                <div><h2 id={`${viewId}-pool-heading`}><span className="week-section-index" aria-hidden="true">01</span> Wochenpool <span className="week-count">{pool.length || 'leer'}</span></h2></div>
                <button type="button" className="week-button week-icon-button" aria-label="Aufgabe zum Wochenpool hinzufügen" onClick={() => onEditTask(undefined, { plan: { kind: 'week', weekStart: start } })}><Plus size={17} aria-hidden="true" /></button>
              </header>
              {pool.length > 0 && <>
                <p className="week-pool-description">Noch keinem Tag zugeordnet</p>
                <TaskList tasks={pool} planner={planner} onEditTask={onEditTask} compact />
                <details className="week-pool-distribute"><summary>Auf Tage verteilen <ArrowRight size={14} aria-hidden="true" /></summary><div className="week-pool-placements">{placements(pool)}</div></details>
              </>}
              <details className="week-inbox">
                <summary><Inbox size={16} aria-hidden="true" /><span>Aus dem Eingang einplanen</span><span className="week-count">{inbox.length}</span></summary>
                <TaskList tasks={inbox} planner={planner} onEditTask={onEditTask} compact emptyText="Im Eingang liegen keine ungeplanten Aufgaben." />
                {inbox.length > 0 && <div className="week-pool-placements">{placements(inbox)}</div>}
              </details>
            </section>

            <section className="week-reflection-group" aria-label="Ziele und Rückblick">
            <details className="week-panel week-reflection">
              <summary className="week-reflection-summary"><span className="week-section-index" aria-hidden="true">02</span><span id={`${viewId}-goals-heading`}>Wochenziele</span><ChevronRight className="week-reflection-marker" size={17} aria-hidden="true" /></summary>
              <div className="week-reflection-content">
              <label className="week-writing-field">
                <span>Wochenziele</span>
                <textarea ref={goalsField} value={draft.goals} onChange={event => updateWeek('goals', event.target.value)} rows={3} placeholder="Was ist dir wichtig?" aria-label="Wochenziele" />
              </label>
              </div>
            </details>
            <details className="week-panel week-reflection">
              <summary className="week-review-summary"><span className="week-section-index" aria-hidden="true">03</span><span>Rückblick</span><ChevronRight className="week-reflection-marker" size={17} aria-hidden="true" /></summary>
              <div className="week-reflection-content">
              <label className="week-writing-field">
                <span>Wochenrückblick</span>
                <textarea value={draft.review} onChange={event => updateWeek('review', event.target.value)} rows={3} placeholder="Was lief gut?" aria-label="Wochenrückblick" />
              </label>
              </div>
            </details>
              <p className={`week-save-state ${planner.status === 'error' ? 'has-error' : ''}`} role="status">
                {planner.status === 'saved' && <CheckCircle2 size={14} aria-hidden="true" />}
                {planner.status === 'error' && <AlertTriangle size={14} aria-hidden="true" />}
                {planner.status === 'saving' ? 'Wird gespeichert …' : planner.status === 'error' ? 'Speichern fehlgeschlagen · Eingaben bleiben erhalten' : 'Gespeichert'}
              </p>
              {linkedNotes.length > 0 && (
                <details className="week-linked-notes">
                  <summary><Link2 size={15} aria-hidden="true" /> Verknüpfte Notizen <span className="week-count">{linkedNotes.length}</span></summary>
                  <div>{linkedNotes.map(note => <button key={note.id} type="button" className="week-note-link" onClick={() => onOpenNote(note.id)}><Link2 size={14} aria-hidden="true" /><span>{note.title || 'Ohne Titel'}{note.deletedAt && <small>Im Papierkorb</small>}</span><ArrowRight size={14} aria-hidden="true" /></button>)}</div>
                </details>
              )}
            </section>
          </div>
          </div>
        </>
      )}
    </div>
  );
}
