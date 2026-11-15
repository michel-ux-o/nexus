import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, PointerEvent } from 'react';
import { AlertTriangle, CalendarDays, Clock3, GripHorizontal, Plus, RotateCcw } from 'lucide-react';
import type { Appointment, PlannerViewProps, TimeBlock } from '../types';
import { addDays, dateInZone, formatDate, formatTime, localToInstant } from '../dates';
import { conflictsForDay } from '../selectors';
import { clipToTimeline, ENTRY_DRAG_TYPE, GRID_MINUTES, positionIntervals, snapMinute, TASK_DRAG_TYPE, timelineRange, timelineTicks } from './layout';
import './Timeline.css';

export type TimelineProps = Pick<PlannerViewProps, 'planner' | 'onEditAppointment' | 'onEditBlock'> & { date: string };
type Entry = { kind: 'appointment'; item: Appointment; title: string } | { kind: 'block'; item: TimeBlock; title: string };
type Attempt = { kind: 'appointment'; item: Appointment; title: string } | { kind: 'block'; item: TimeBlock; title: string };
type ResizeDraft = { block: TimeBlock; title: string; startY: number; initialDuration: number; duration: number; pointerId: number };
const PIXELS_PER_MINUTE = 1.05;

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Die Änderung konnte nicht gespeichert werden. Bitte erneut versuchen.';
}

export function Timeline({ planner, date, onEditAppointment, onEditBlock }: TimelineProps) {
  const id = useId();
  const zone = planner.data.settings.timeZone;
  const range = useMemo(() => timelineRange(date, zone), [date, zone]);
  const ticks = useMemo(() => timelineTicks(range, zone), [range, zone]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);
  const resizeRef = useRef<ResizeDraft | null>(null);
  const suppressResizeClick = useRef(false);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [failed, setFailed] = useState<Attempt | null>(null);
  const [hoverMinute, setHoverMinute] = useState<number | null>(null);
  const [resize, setResize] = useState<ResizeDraft | null>(null);
  const [selectedTask, setSelectedTask] = useState('');
  const [resizeBlockId, setResizeBlockId] = useState('');
  const [startTime, setStartTime] = useState('09:00');
  const [duration, setDuration] = useState('30');
  const [clockChoice, setClockChoice] = useState<'' | 'earlier' | 'later'>('');
  const [selectedMinute, setSelectedMinute] = useState<number | null>(null);
  const disabled = busy || !!failed || planner.loading || !!planner.loadError;
  const tasksById = new Map(planner.data.tasks.map(task => [task.id, task]));
  const allDay = planner.data.appointments.filter(item => item.allDay && item.allDay.startDate <= date && item.allDay.endDate > date);
  const entries: Entry[] = [
    ...planner.data.appointments.filter(item => !item.allDay).map(item => ({ kind: 'appointment' as const, item, title: item.title })),
    ...planner.data.timeBlocks.map(item => ({ kind: 'block' as const, item: resize?.block.id === item.id ? { ...item, durationMinutes: resize.duration } : item, title: tasksById.get(item.taskId)?.title ?? 'Verknüpfte Aufgabe fehlt' })),
  ].filter(entry => clipToTimeline(entry.item.startAt, entry.item.durationMinutes, range))
    .sort((a, b) => Date.parse(a.item.startAt) - Date.parse(b.item.startAt) || a.item.id.localeCompare(b.item.id));
  const positions = new Map(positionIntervals(entries.map(entry => ({ key: `${entry.kind}-${entry.item.id}`, ...clipToTimeline(entry.item.startAt, entry.item.durationMinutes, range)! }))).map(position => [position.key, position]));
  const conflicts = conflictsForDay(planner.data, date);
  const conflictIds = new Set(conflicts.flatMap(conflict => conflict.ids));
  const nowMinute = (now - range.start) / 60_000;
  const isCurrentDay = now >= range.start && now < range.end;
  const taskOptions = planner.data.tasks.filter(task => task.status !== 'done');
  const resizeBlocks = entries.filter((entry): entry is Extract<Entry, { kind: 'block' }> => entry.kind === 'block');
  const selectedResizeBlock = resizeBlocks.find(entry => entry.item.id === resizeBlockId);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const morning = ticks.find(tick => tick.label === '07:00')?.minute ?? 0;
    if (scrollRef.current) scrollRef.current.scrollTop = morning * PIXELS_PER_MINUTE;
    setHoverMinute(null); setSelectedMinute(null); setResizeBlockId(''); setStatus('');
    resizeRef.current = null; setResize(null);
  }, [date, ticks]);

  useEffect(() => {
    if (!failed || busy || planner.status !== 'saved') return;
    const saved = failed.kind === 'block'
      ? planner.data.timeBlocks.find(item => item.id === failed.item.id)
      : planner.data.appointments.find(item => item.id === failed.item.id);
    // A global retry can commit the same optimistic draft while this view stays open.
    if (saved && saved.startAt === failed.item.startAt && saved.durationMinutes === failed.item.durationMinutes
      && (failed.kind === 'block' ? 'taskId' in saved && saved.taskId === failed.item.taskId : 'title' in saved && saved.title === failed.item.title)) {
      setFailed(null); setError(''); setStatus(`„${failed.title}“ gespeichert.`);
    }
  }, [failed, busy, planner.status, planner.data.timeBlocks, planner.data.appointments]);

  function openEntry(entry: Entry | Attempt) {
    if (failed?.item.id === entry.item.id) { setFailed(null); setError(''); }
    if (entry.kind === 'appointment') onEditAppointment(entry.item);
    else onEditBlock(entry.item);
  }

  async function commit(attempt: Attempt) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(''); setStatus('Änderung wird gespeichert …');
    try {
      if (attempt.kind === 'appointment') await planner.saveAppointment(attempt.item);
      else await planner.saveTimeBlock(attempt.item);
      setFailed(null); setStatus(`„${attempt.title}“ gespeichert.`);
    } catch (cause) {
      setFailed(attempt); setError(message(cause)); setStatus('');
    } finally { busyRef.current = false; setBusy(false); }
  }

  function createBlock(taskId: string, startAt: string, minutes?: number) {
    const task = planner.data.tasks.find(item => item.id === taskId);
    if (!task) throw new Error('Wähle eine noch vorhandene Aufgabe.');
    if (task.status === 'done') throw new Error('Diese Aufgabe ist bereits erledigt. Öffne sie zuerst wieder.');
    const stamp = new Date().toISOString();
    void commit({ kind: 'block', title: task.title, item: { id: crypto.randomUUID(), taskId, startAt, durationMinutes: minutes ?? task.estimatedMinutes ?? 30, createdAt: stamp, updatedAt: stamp } });
  }

  function moveEntry(entry: Entry, minute: number) {
    const startAt = new Date(range.start + minute * 60_000).toISOString();
    void commit({ ...entry, item: { ...entry.item, startAt, updatedAt: new Date().toISOString() } } as Attempt);
  }

  function minuteAt(clientY: number) {
    const bounds = canvasRef.current?.getBoundingClientRect();
    return bounds ? snapMinute((clientY - bounds.top) / bounds.height * range.minutes, range.minutes) : 0;
  }

  function chooseTime(minute: number) {
    const startAt = new Date(range.start + minute * 60_000).toISOString();
    setSelectedMinute(minute); setStartTime(formatTime(startAt, zone));
    const earlier = localToInstant(date, formatTime(startAt, zone), zone, 'earlier');
    const later = localToInstant(date, formatTime(startAt, zone), zone, 'later');
    setClockChoice(earlier === later ? '' : startAt === later ? 'later' : 'earlier');
    onEditAppointment(undefined, date, { startAt, durationMinutes: 60 });
  }

  function acceptsDrop(event: DragEvent) {
    return event.dataTransfer.types.includes(TASK_DRAG_TYPE) || event.dataTransfer.types.includes(ENTRY_DRAG_TYPE);
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    if (disabled || !acceptsDrop(event)) return;
    event.preventDefault(); setHoverMinute(null); setError('');
    const minute = minuteAt(event.clientY);
    try {
      const taskId = event.dataTransfer.getData(TASK_DRAG_TYPE);
      if (taskId) createBlock(taskId, new Date(range.start + minute * 60_000).toISOString());
      else {
        const parsed = JSON.parse(event.dataTransfer.getData(ENTRY_DRAG_TYPE)) as { kind: string; id: string };
        const entry = entries.find(item => item.kind === parsed.kind && item.item.id === parsed.id);
        if (!entry) throw new Error('Dieser Eintrag ist nicht mehr vorhanden.');
        moveEntry(entry, minute);
      }
    } catch (cause) { setError(message(cause)); }
  }

  function startResize(event: PointerEvent<HTMLButtonElement>, entry: Extract<Entry, { kind: 'block' }>) {
    if (disabled || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    suppressResizeClick.current = event.currentTarget.classList.contains('nexus-timeline-resize');
    const draft: ResizeDraft = { block: entry.item, title: entry.title, startY: event.clientY, initialDuration: entry.item.durationMinutes, duration: entry.item.durationMinutes, pointerId: event.pointerId };
    resizeRef.current = draft; setResize(draft); event.currentTarget.setPointerCapture(event.pointerId);
  }

  function resizeDuration(event: PointerEvent<HTMLButtonElement>) {
    const draft = resizeRef.current;
    if (!draft || event.pointerId !== draft.pointerId) return;
    const minutes = Math.round((draft.initialDuration + (event.clientY - draft.startY) / PIXELS_PER_MINUTE) / GRID_MINUTES) * GRID_MINUTES;
    const next = { ...draft, duration: Math.max(GRID_MINUTES, Math.min(1440, minutes)) };
    resizeRef.current = next; setResize(next);
  }

  function finishResize(event: PointerEvent<HTMLButtonElement>, cancelled = false) {
    const draft = resizeRef.current;
    if (!draft || draft.pointerId !== event.pointerId) return;
    resizeRef.current = null; setResize(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!cancelled && draft.duration !== draft.initialDuration) void commit({ kind: 'block', title: draft.title, item: { ...draft.block, durationMinutes: draft.duration } });
  }

  function moveWithKey(event: KeyboardEvent<HTMLButtonElement>, entry: Entry) {
    if (disabled || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const delta = (event.key === 'ArrowDown' ? 1 : -1) * (event.shiftKey ? 60 : GRID_MINUTES);
    const current = (Date.parse(entry.item.startAt) - range.start) / 60_000;
    const next = current + delta;
    if (next < 0 || next >= range.minutes) { setError('Für einen anderen Tag nutze bitte das vollständige Formular.'); return; }
    moveEntry(entry, next);
  }

  function intervalLabel(entry: Entry) {
    const end = new Date(Date.parse(entry.item.startAt) + entry.item.durationMinutes * 60_000).toISOString();
    const startDay = dateInZone(entry.item.startAt, zone);
    const endDay = dateInZone(end, zone);
    return `${startDay !== date ? `${formatDate(startDay, { day: 'numeric', month: 'short' })}, ` : ''}${formatTime(entry.item.startAt, zone)} – ${endDay !== date ? `${formatDate(endDay, { day: 'numeric', month: 'short' })}, ` : ''}${formatTime(end, zone)}`;
  }

  return <section className="nexus-timeline" aria-labelledby={`${id}-title`}>
    <header className="nexus-timeline-heading">
      <div><p className="nexus-timeline-eyebrow">ZEITRAUM / {zone}</p><h2 id={`${id}-title`}>Dein Tagesverlauf</h2></div>
      <div className="nexus-timeline-actions">
        {isCurrentDay && <button type="button" className="nexus-timeline-button" onClick={() => { if (scrollRef.current) scrollRef.current.scrollTop = Math.max(0, nowMinute * PIXELS_PER_MINUTE - 100); }}><Clock3 size={15} aria-hidden="true" /> Jetzt</button>}
        <button type="button" className="nexus-timeline-button" onClick={() => onEditAppointment(undefined, date)}><Plus size={15} aria-hidden="true" /> Termin</button>
        <button type="button" className="nexus-timeline-button" onClick={() => onEditBlock(undefined, { date })}><Plus size={15} aria-hidden="true" /> Zeitblock</button>
      </div>
    </header>

    {allDay.length > 0 && <div className="nexus-timeline-allday"><h3><CalendarDays size={14} aria-hidden="true" /> Ganztägig</h3><ul>{allDay.map(item => <li key={item.id}><button type="button" onClick={() => onEditAppointment(item)}><strong>{item.title}</strong><span>{formatDate(item.allDay!.startDate, { day: 'numeric', month: 'short' })}{addDays(item.allDay!.endDate, -1) !== item.allDay!.startDate ? ` – ${formatDate(addDays(item.allDay!.endDate, -1), { day: 'numeric', month: 'short' })}` : ''} · ohne Zeitbelegung</span></button></li>)}</ul></div>}

    <form className="nexus-timeline-create" onSubmit={event => {
      event.preventDefault(); if (disabled) return;
      try {
        const minutes = Number(duration);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error('Bitte eine Dauer von 1 bis 1440 ganzen Minuten eingeben.');
        createBlock(selectedTask, localToInstant(date, startTime, zone, clockChoice || undefined), minutes);
      } catch (cause) { setError(message(cause)); }
    }}>
      <label className="nexus-timeline-task"><span className="nexus-timeline-sr">Aufgabe für Zeitblock auswählen</span><select aria-label="Aufgabe für Zeitblock auswählen" value={selectedTask} disabled={disabled} onChange={event => {
        setSelectedTask(event.target.value);
        const task = planner.data.tasks.find(item => item.id === event.target.value);
        setDuration(String(task?.estimatedMinutes ?? 30));
      }}><option value="">Aufgabe auswählen</option>{taskOptions.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>
      <label><span>Beginn</span><input type="time" aria-label="Beginn des neuen Zeitblocks" required value={startTime} disabled={disabled} onChange={event => setStartTime(event.target.value)} /></label>
      <label><span>Minuten</span><input type="number" aria-label="Dauer des neuen Zeitblocks in Minuten" min="1" max="1440" required value={duration} disabled={disabled} onChange={event => setDuration(event.target.value)} /></label>
      <button className="nexus-timeline-button" type="submit" disabled={!selectedTask || disabled}><Plus size={14} aria-hidden="true" /> Zeitblock einfügen</button>
      {range.minutes !== 1440 && <label className="nexus-timeline-dst"><span>Zeitumstellung · doppelte Uhrzeit</span><select value={clockChoice} disabled={disabled} onChange={event => setClockChoice(event.target.value as typeof clockChoice)}><option value="">Bei Bedarf auswählen</option><option value="earlier">Frühere Uhrzeit</option><option value="later">Spätere Uhrzeit</option></select></label>}
    </form>

    {selectedMinute !== null && <div className="nexus-timeline-selected" role="group" aria-label="Eintrag an gewählter Uhrzeit erstellen"><strong>{formatTime(new Date(range.start + selectedMinute * 60_000).toISOString(), zone)} Uhr</strong><div className="nexus-timeline-actions">
      <button type="button" className="nexus-timeline-button" onClick={() => onEditAppointment(undefined, date, { startAt: new Date(range.start + selectedMinute * 60_000).toISOString(), durationMinutes: 60 })}>Termin hier erstellen</button>
      <button type="button" className="nexus-timeline-button" onClick={() => onEditBlock(undefined, { date, startAt: new Date(range.start + selectedMinute * 60_000).toISOString(), durationMinutes: Number(duration) >= 1 && Number(duration) <= 1440 ? Number(duration) : 30, ...(selectedTask ? { taskId: selectedTask } : {}) })}>Zeitblock hier erstellen</button>
      <button type="button" className="nexus-timeline-button" onClick={() => setSelectedMinute(null)}>Schließen</button></div></div>}

    {error && <div className="nexus-timeline-error" role="alert"><AlertTriangle size={16} aria-hidden="true" /><div><p>{failed ? 'Änderung noch nicht gespeichert: ' : ''}{error}</p>{failed && <><p>Dein Entwurf für „{failed.title}“ bleibt erhalten. Eine Wiederholung verwendet denselben Eintrag.</p><div className="nexus-timeline-actions"><button type="button" className="nexus-timeline-button" disabled={busy} onClick={() => void commit(failed)}><RotateCcw size={14} aria-hidden="true" /> Speichern wiederholen</button><button type="button" className="nexus-timeline-button" disabled={busy} onClick={() => openEntry(failed)}>Entwurf im Formular öffnen</button></div></>}</div></div>}
    <p className="nexus-timeline-status" role="status" aria-live="polite">{status}</p>
    {conflicts.length > 0 && <details className="nexus-timeline-conflicts"><summary><AlertTriangle size={14} aria-hidden="true" /> {conflicts.length} {conflicts.length === 1 ? 'Überschneidung' : 'Überschneidungen'} prüfen</summary><ul>{conflicts.map((conflict, index) => <li key={index}>{conflict.message}</li>)}</ul></details>}

    <div className="nexus-timeline-touch-resize">
      <label htmlFor={`${id}-resize-block`}>Zeitblock-Dauer ändern</label>
      <select id={`${id}-resize-block`} value={selectedResizeBlock ? resizeBlockId : ''} disabled={disabled || !resizeBlocks.length} onChange={event => setResizeBlockId(event.target.value)}>
        <option value="">Zeitblock auswählen</option>
        {resizeBlocks.map(entry => <option key={entry.item.id} value={entry.item.id}>{intervalLabel(entry)} · {entry.title}</option>)}
      </select>
      {selectedResizeBlock && <>
        <span className="nexus-timeline-touch-duration" aria-live="polite">{selectedResizeBlock.item.durationMinutes} Minuten</span>
        <div className="nexus-timeline-touch-controls">
          <button type="button" className="nexus-timeline-button" disabled={disabled || selectedResizeBlock.item.durationMinutes <= 1} onClick={() => void commit({ ...selectedResizeBlock, item: { ...selectedResizeBlock.item, durationMinutes: Math.max(1, selectedResizeBlock.item.durationMinutes - GRID_MINUTES) } })}>− 15 Min.</button>
          <button type="button" className="nexus-timeline-touch-grip" disabled={disabled} aria-label={`Dauer von ${selectedResizeBlock.title} durch Ziehen ändern, aktuell ${selectedResizeBlock.item.durationMinutes} Minuten`}
            onPointerDown={event => startResize(event, selectedResizeBlock)} onPointerMove={resizeDuration} onPointerUp={event => finishResize(event)} onPointerCancel={event => finishResize(event, true)} onLostPointerCapture={() => { resizeRef.current = null; setResize(null); }}><GripHorizontal size={20} aria-hidden="true" /> Ziehen</button>
          <button type="button" className="nexus-timeline-button" disabled={disabled || selectedResizeBlock.item.durationMinutes >= 1440} onClick={() => void commit({ ...selectedResizeBlock, item: { ...selectedResizeBlock.item, durationMinutes: Math.min(1440, selectedResizeBlock.item.durationMinutes + GRID_MINUTES) } })}>+ 15 Min.</button>
        </div>
      </>}
    </div>

    <div className="nexus-timeline-scroll" ref={scrollRef} tabIndex={0} role="region" aria-label={`Stundenraster für ${formatDate(date)} in ${zone}`} aria-describedby={`${id}-help`}>
      <div className="nexus-timeline-canvas" ref={canvasRef} style={{ height: Math.max(1, range.minutes) * PIXELS_PER_MINUTE }}
        onClick={event => { if ((event.target as HTMLElement).closest('button') || disabled) return; chooseTime(minuteAt(event.clientY)); }}
        onDragOver={event => { if (!disabled && acceptsDrop(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setHoverMinute(minuteAt(event.clientY)); } }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHoverMinute(null); }} onDrop={drop}>
        <div className="nexus-timeline-minutes" aria-hidden="true" />
        {ticks.map(tick => <div className="nexus-timeline-hour" key={tick.minute} style={{ top: tick.minute * PIXELS_PER_MINUTE }}><button type="button" disabled={disabled} aria-label={`Eintrag um ${tick.label} erstellen`} onClick={() => chooseTime(tick.minute)}>{tick.label}</button></div>)}
        <div className="nexus-timeline-events">
          {entries.map(entry => {
            const position = positions.get(`${entry.kind}-${entry.item.id}`)!;
            const hasConflict = conflictIds.has(entry.item.id);
            const done = entry.kind === 'block' && tasksById.get(entry.item.taskId)?.status === 'done';
            const short = position.end - position.start < 45;
            return <div key={`${entry.kind}-${entry.item.id}`} className={`nexus-timeline-entry is-${entry.kind}${hasConflict ? ' has-conflict' : ''}${done ? ' is-done' : ''}${short ? ' is-short' : ''}`}
              style={{ top: position.start * PIXELS_PER_MINUTE, height: Math.max(23, (position.end - position.start) * PIXELS_PER_MINUTE - 2), left: `${position.column / position.columns * 100}%`, width: `calc(${100 / position.columns}% - 4px)` }}>
              <button type="button" className="nexus-timeline-entry-edit" disabled={busy} draggable={!disabled && !resize} onDragStart={event => {
                if (disabled || resize) { event.preventDefault(); return; }
                event.dataTransfer.setData(ENTRY_DRAG_TYPE, JSON.stringify({ kind: entry.kind, id: entry.item.id })); event.dataTransfer.effectAllowed = 'move';
              }} onDragEnd={() => setHoverMinute(null)} onClick={() => openEntry(entry)} onKeyDown={event => moveWithKey(event, entry)} aria-describedby={`${id}-help`}
                aria-label={`${entry.kind === 'appointment' ? 'Termin' : 'Zeitblock'} ${entry.title}, ${intervalLabel(entry)}, ${entry.item.durationMinutes} Minuten${hasConflict ? ', Überschneidung' : ''}. Bearbeiten`}>
                <span className="nexus-timeline-entry-time">{intervalLabel(entry)}</span><strong>{entry.title}</strong>{!short && <span className="nexus-timeline-entry-meta">{entry.kind === 'appointment' ? 'Termin' : 'Zeitblock'} · {entry.item.durationMinutes} Min.{done ? ' · erledigt' : ''}{hasConflict ? ' · Überschneidung' : ''}</span>}
              </button>
              {entry.kind === 'block' && <button type="button" className="nexus-timeline-resize" disabled={disabled} aria-label={`Dauer von ${entry.title} ändern, aktuell ${entry.item.durationMinutes} Minuten. Pfeil hoch verkürzt, Pfeil runter verlängert um 15 Minuten.`}
                onPointerDown={event => startResize(event, entry)} onPointerMove={resizeDuration} onPointerUp={event => finishResize(event)} onPointerCancel={event => finishResize(event, true)} onLostPointerCapture={() => { resizeRef.current = null; setResize(null); }}
                onKeyDown={event => {
                  if (event.key === 'Escape') { resizeRef.current = null; setResize(null); return; }
                  if (!['ArrowUp', 'ArrowDown'].includes(event.key) || disabled) return;
                  event.preventDefault();
                  const minutes = Math.max(1, Math.min(1440, entry.item.durationMinutes + (event.key === 'ArrowDown' ? 1 : -1) * (event.shiftKey ? 60 : GRID_MINUTES)));
                  if (minutes !== entry.item.durationMinutes) void commit({ kind: 'block', title: entry.title, item: { ...entry.item, durationMinutes: minutes } });
                }} onClick={event => { if (event.detail > 0 && suppressResizeClick.current) { suppressResizeClick.current = false; return; } onEditBlock(entry.item); }}><GripHorizontal size={14} aria-hidden="true" /></button>}
            </div>;
          })}
        </div>
        {isCurrentDay && <div className="nexus-timeline-now" style={{ top: nowMinute * PIXELS_PER_MINUTE }}><span>Jetzt {formatTime(new Date(now).toISOString(), zone)}</span></div>}
        {hoverMinute !== null && <div className="nexus-timeline-drop" style={{ top: hoverMinute * PIXELS_PER_MINUTE }}><span>{formatTime(new Date(range.start + hoverMinute * 60_000).toISOString(), zone)}</span></div>}
      </div>
    </div>
    <p id={`${id}-help`} className="nexus-timeline-help">Aufgaben oder Blöcke auf eine Uhrzeit ziehen · Raster 15 Min. Am unteren Blockrand ziehen, um die Dauer zu ändern. Klick öffnet das Formular. Tastatur: Alt + ↑/↓ verschiebt; am Dauerrand ↑/↓ ändert die Dauer, mit Umschalt jeweils 60 Min.</p>
    {range.minutes !== 1440 && <p className="nexus-timeline-help">Zeitumstellung: Dieser Tag hat {range.minutes / 60} Stunden. Doppelte Stunden sind mit ihrem UTC-Versatz gekennzeichnet.</p>}
    <details className="nexus-timeline-agenda"><summary>Termine & Zeitblöcke als Liste <span>{entries.length}</span></summary>{entries.length ? <ol>{entries.map(entry => <li key={`${entry.kind}-${entry.item.id}`}><button type="button" onClick={() => openEntry(entry)}><time dateTime={entry.item.startAt}>{intervalLabel(entry)}</time><strong>{entry.title}</strong><span>{entry.kind === 'appointment' ? 'Termin' : 'Zeitblock'} · {entry.item.durationMinutes} Min.{conflictIds.has(entry.item.id) ? ' · Überschneidung' : ''}</span></button></li>)}</ol> : <p>Keine festen Zeiten an diesem Tag.</p>}</details>
  </section>;
}
