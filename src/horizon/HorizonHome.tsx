import { getWorkspaceScope } from '../auth/workspaceScope';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type TouchEvent } from 'react';
import { ArrowRight, ArrowUpRight, Bell, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Circle, Expand, Focus, LoaderCircle, Mic, Plus, RotateCcw, X } from 'lucide-react';
import type { Planner, Reminder, Subtask, Task, WorkspaceViewProps } from '../planning/types';
import type { Note, SaveStatus } from '../types';
import { dateInZone, formatDate, formatTime } from '../planning/dates';
import { appointmentsForDay } from '../planning/selectors';
import { reminderOccurrences } from '../planning/reminders';
import { subtaskProgress, setSubtaskDone, subtaskState } from '../planning/subtasks';
import { SubtaskChecklist } from '../planning/components/SubtaskChecklist';
import { useCalendarRecurrence } from '../calendar/useCalendarRecurrence';
import { emptyHorizonDraft, horizonDayBlocks, horizonDayNotes, horizonDayTasks, horizonDraftsForWorkspace, horizonNextReminder, horizonNextTaskId, horizonNextTimedItem, horizonNotePreview, horizonRecommendTask, horizonRoutineTask, horizonTaskBlock, horizonTaskDate, parseHorizonDrafts, type HorizonDayDraft, type HorizonDraftBook } from './homeModel';
import { HorizonDayStrip } from './HorizonDayStrip';
import { emitHorizonScene } from './sceneEvents';
import './HorizonHome.css';

export interface HorizonHomeProps extends WorkspaceViewProps {
  date: string;
  onDateChange: (date: string) => void;
  onOpenCalendar: (date: string) => void;
  onSearch: () => void;
  onFocusChange?: (focus: boolean) => void;
  initialFocusTaskId?: string;
  onCaptureNote?: (title: string, content: string, date: string, operationId?: string) => Promise<void>;
  workspaceEpoch?: number;
  noteStatus?: SaveStatus;
}

type CaptureMode = 'task' | 'note' | 'reminder';
type HomeCommit = { region: 'tasks' | 'calendar' | 'focus' | 'notes' | 'reminders' | 'home'; action: 'add' | 'complete' | 'restore' | 'update'; item: string };
interface HomeOperation {
  key: string;
  action: () => Promise<void>;
  success: string;
  commit: HomeCommit;
  epoch: number;
  source: 'planning' | 'notes';
  finish?: () => void;
  matches?: (planner: Planner, notes: Note[]) => boolean;
}

// Session drafts survive route unmounts. Replacing the workspace invalidates identities,
// including task-specific subtask drafts, without discarding free-standing draft text.
function draftStorageKey() {
  const scope = getWorkspaceScope();
  return scope.userId ? 'nexus.horizon.day-drafts.v1:' + scope.userId : 'nexus.horizon.day-drafts.v1';
}
let draftEpoch: number | undefined;
let draftBook: HorizonDraftBook | undefined;
let storageUnavailable = false;
const draftListeners = new Set<() => void>();
function readDraftBook(epoch: number): HorizonDraftBook {
  if (!draftBook) {
    let serialized: string | null = null;
    let storedEpoch = 0;
    try {
      serialized = sessionStorage.getItem(draftStorageKey());
      const source = serialized ? JSON.parse(serialized) : null;
      if (typeof source?.workspaceEpoch === 'number') storedEpoch = source.workspaceEpoch;
    } catch { storageUnavailable = true; }
    draftBook = parseHorizonDrafts(serialized);
    if (storedEpoch !== epoch) {
      draftBook = horizonDraftsForWorkspace(draftBook);
      try { sessionStorage.setItem(draftStorageKey(), JSON.stringify({ ...draftBook, workspaceEpoch: epoch })); }
      catch { storageUnavailable = true; }
    }
    draftEpoch = epoch;
  } else if (draftEpoch !== epoch) {
    draftBook = horizonDraftsForWorkspace(draftBook);
    draftEpoch = epoch;
    try { sessionStorage.setItem(draftStorageKey(), JSON.stringify({ ...draftBook, workspaceEpoch: epoch })); }
    catch { storageUnavailable = true; }
  }
  return draftBook;
}
function writeDraftBook(epoch: number, update: (book: HorizonDraftBook) => HorizonDraftBook) {
  if (draftEpoch !== epoch || !draftBook) return;
  draftBook = update(draftBook);
  try { sessionStorage.setItem(draftStorageKey(), JSON.stringify({ ...draftBook, workspaceEpoch: epoch })); storageUnavailable = false; }
  catch { storageUnavailable = true; }
  draftListeners.forEach(listener => listener());
}
function subscribeDrafts(listener: () => void) { draftListeners.add(listener); return () => { draftListeners.delete(listener); }; }

/** Remote changes must not invalidate unsent inline capture or subtask text. */
export function hasHorizonDrafts(): boolean {
  let book = draftBook;
  if (!book) {
    try { book = parseHorizonDrafts(sessionStorage.getItem(draftStorageKey())); }
    catch { return true; }
  }
  return Object.values(book.days).some(draft => !!(draft.taskTitle || draft.noteTitle || draft.noteContent || draft.reminderTitle))
    || Object.values(book.subtasks).some(draft => !!draft.title);
}

/** Call when replacing workspace data, including when Home is currently unmounted. */
export function resetHorizonDraftIdentities() {
  let book = draftBook;
  if (!book) {
    try { book = parseHorizonDrafts(sessionStorage.getItem(draftStorageKey())); }
    catch { storageUnavailable = true; book = parseHorizonDrafts(null); }
  }
  draftBook = horizonDraftsForWorkspace(book);
  try { sessionStorage.setItem(draftStorageKey(), JSON.stringify({ ...draftBook, workspaceEpoch: draftEpoch ?? 0 })); }
  catch { storageUnavailable = true; }
  draftListeners.forEach(listener => listener());
}

export function HorizonHome({ planner, notes, date, onDateChange, onOpenCalendar, onFocusChange, initialFocusTaskId, onCaptureNote, workspaceEpoch = 0, noteStatus, onNavigate, onEditTask, onEditAppointment, onEditBlock, onEditReminder, onOpenNote, onCreateNote, onDictate, onQuickCapture }: HorizonHomeProps) {
  const book = useSyncExternalStore(subscribeDrafts, () => readDraftBook(workspaceEpoch));
  const draft = book.days[date] ?? emptyHorizonDraft();
  const [capture, setCapture] = useState<CaptureMode | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [outsideTaskId, setOutsideTaskId] = useState<string | null>(null);
  const [morningFocusDismissed, setMorningFocusDismissed] = useState<string | null>(null);
  const [subtasksOpen, setSubtasksOpen] = useState(true);
  const [focusMode, setFocusMode] = useState(false);
  const [focusDirection, setFocusDirection] = useState<'previous' | 'next' | 'stationary'>('stationary');
  const [focusRevision, setFocusRevision] = useState(0);
  const [fullTitle, setFullTitle] = useState(false);
  const [titleOverflows, setTitleOverflows] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [now, setNow] = useState(Date.now);
  const [calendarExpanded, setCalendarExpanded] = useState(false);
  const [remindersExpanded, setRemindersExpanded] = useState(false);
  const lock = useRef(false);
  const focusDialog = useRef<HTMLDialogElement>(null);
  const focusTrigger = useRef<HTMLButtonElement>(null);
  const inlineTitle = useRef<HTMLHeadingElement>(null);
  const focusSwipeStart = useRef<{ x: number; y: number } | null>(null);
  const latestPlanner = useRef(planner);
  const pendingCommits = useRef(new Map<string, HomeOperation>());
  const retryOperation = useRef<HomeOperation | null>(null);
  const previousFocusMode = useRef(false);
  latestPlanner.current = planner;
  const timeZone = planner.data.settings.timeZone;
  const ready = !planner.loading && !planner.loadError;
  const disabled = busy !== null || !ready;
  const today = dateInZone(new Date(now), timeZone);
  const todayTime = date === today ? now : null;
  const tasks = useMemo(() => horizonDayTasks(planner.data, date), [planner.data, date]);
  const routineTasks = tasks.filter(horizonRoutineTask).sort((left, right) => Number(Boolean(right.morningRoutineDate)) - Number(Boolean(left.morningRoutineDate)));
  const otherTasks = tasks.filter(task => !horizonRoutineTask(task));
  const focusTasks = [...routineTasks, ...otherTasks];
  const dayNotes = useMemo(() => horizonDayNotes(notes, tasks, date, timeZone)
    .map(note => ({ ...note, preview: horizonNotePreview(note.content) })), [notes, tasks, date, timeZone]);
  const reminders = useMemo(() => reminderOccurrences(planner.data, date, date), [planner.data, date]);
  const appointments = useMemo(() => appointmentsForDay(planner.data, date), [planner.data, date]);
  const blocks = useMemo(() => horizonDayBlocks(planner.data, date), [planner.data, date]);
  const calendarItems = [
    ...appointments.map(appointment => ({ kind: 'appointment' as const, allDay: Boolean(appointment.allDay), appointment, id: appointment.id, title: appointment.title, startAt: appointment.startAt, durationMinutes: appointment.durationMinutes })),
    ...blocks.map(block => ({ kind: 'block' as const, allDay: false, block, id: block.id, title: tasks.find(task => task.id === block.taskId)?.title ?? 'Zeitblock', startAt: block.startAt, durationMinutes: block.durationMinutes })),
  ].sort((left, right) => Number(right.allDay) - Number(left.allDay) || Date.parse(left.startAt) - Date.parse(right.startAt));
  const nextCalendarItem = horizonNextTimedItem(calendarItems.filter(item => !item.allDay), todayTime)
    ?? calendarItems.find(item => item.allDay);
  const nextReminder = horizonNextReminder(reminders, todayTime);
  const otherCalendarItems = calendarItems.filter(item => item !== nextCalendarItem);
  const otherReminders = reminders.filter(item => item !== nextReminder);
  const morningReceipt = planner.data.morningRoutineReceipts?.find(receipt => receipt.date === today);
  const morningTask = date === today && !morningReceipt?.skipped
    ? tasks.find(task => task.morningRoutineDate === today && task.status !== 'done') ?? null
    : null;
  const recommendedTask = ready ? horizonRecommendTask(tasks, blocks, todayTime) : null;
  const selectedTask = (outsideTaskId ? planner.data.tasks.find(task => task.id === outsideTaskId) : undefined)
    ?? (morningTask && morningFocusDismissed !== morningTask.id ? morningTask : undefined)
    ?? tasks.find(task => task.id === selectedId) ?? recommendedTask;
  const isMorningFocus = Boolean(selectedTask?.morningRoutineDate);
  const canSkipMorning = selectedTask?.morningRoutineDate === today && selectedTask.status !== 'done' && !morningReceipt?.skipped;
  const selectedTaskIndex = selectedTask ? tasks.findIndex(task => task.id === selectedTask.id) : -1;
  const selectedBlock = selectedTask ? horizonTaskBlock(blocks, selectedTask.id, todayTime) : undefined;
  const manualSelection = Boolean(selectedTask && (outsideTaskId === selectedTask.id || selectedId === selectedTask.id));
  const selectedBlockDate = selectedBlock ? dateInZone(selectedBlock.startAt, timeZone) : null;
  const calendarItemLabel = nextCalendarItem
    ? nextCalendarItem.allDay ? 'Ganztägiger Termin'
      : `${date < today ? 'Erster' : todayTime !== null && Date.parse(nextCalendarItem.startAt) < todayTime ? 'Laufender' : 'Nächster'} ${nextCalendarItem.kind === 'block' ? 'Zeitblock' : 'Termin'}`
    : null;
  const reminderLabel = nextReminder && (date < today || (todayTime !== null && Date.parse(nextReminder.effectiveAt) < todayTime))
    ? 'Offene Erinnerung' : 'Nächste Erinnerung';
  // The list, inline steps and full focus room keep one selection identity. The
  // scene can open that same place without deriving state from visible text.
  const focusStage = !selectedTask ? 'empty' : focusMode ? 'immersed' : subtasksOpen ? 'steps' : 'selected';
  const { recurrenceError, retryRecurring } = useCalendarRecurrence(planner, date, date);
  const completed = tasks.filter(task => task.status === 'done').length;

  useEffect(() => {
    const refresh = () => setNow(Date.now());
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, []);
  useEffect(() => {
    setCalendarExpanded(false);
    setRemindersExpanded(false);
  }, [date, workspaceEpoch]);

  useEffect(() => { setFullTitle(false); }, [selectedTask?.id, selectedTask?.title]);
  useEffect(() => {
    const title = inlineTitle.current;
    if (!title) return;
    const measure = () => {
      const style = getComputedStyle(title);
      const lines = Number(style.getPropertyValue('--horizon-title-lines')) || 4;
      setTitleOverflows(title.scrollHeight > parseFloat(style.lineHeight) * lines + 2);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(title);
    return () => observer.disconnect();
  }, [selectedTask?.id, selectedTask?.title, focusMode, focusRevision]);

  useEffect(() => {
    if (busy || lock.current) return;
    // A global retry can also persist an optimistic Home change. Confirm only
    // operations whose intended result is still present in that saved snapshot.
    for (const [key, operation] of pendingCommits.current) {
      if ((operation.source === 'notes' ? noteStatus : planner.status) !== 'saved') continue;
      pendingCommits.current.delete(key);
      if (operation.epoch !== workspaceEpoch || !operation.matches?.(planner, notes)) continue;
      finishOperation(operation);
    }
  }, [planner.status, planner.data, notes, noteStatus, busy, workspaceEpoch]);

  useEffect(() => {
    pendingCommits.current.clear(); retryOperation.current = null;
    setSelectedId(null); setOutsideTaskId(null); setMorningFocusDismissed(null); setFocusMode(false); setError(''); setStatus('');
  }, [workspaceEpoch]);

  useEffect(() => {
    if (!initialFocusTaskId || planner.loading) return;
    const task = latestPlanner.current.data.tasks.find(item => item.id === initialFocusTaskId);
    if (!task) return;
    const chosenDate = horizonTaskDate(latestPlanner.current.data, task);
    if (chosenDate) onDateChange(chosenDate);
    setSelectedId(task.id); setOutsideTaskId(task.id); setSubtasksOpen(true); setFocusMode(true);
    // This is an explicit incoming focus request, not a reaction to task mutations.
  }, [initialFocusTaskId, workspaceEpoch, planner.loading, onDateChange]);

  useEffect(() => {
    onFocusChange?.(focusMode);
    if (previousFocusMode.current !== focusMode) {
      previousFocusMode.current = focusMode;
      emitHorizonScene({ kind: 'select', region: 'focus', active: focusMode, item: selectedTask?.id });
    }
  }, [focusMode, onFocusChange]);
  useEffect(() => () => { onFocusChange?.(false); }, [onFocusChange]);
  useEffect(() => {
    const dialog = focusDialog.current;
    if (!dialog) return;
    if (focusMode && !dialog.open) dialog.showModal();
    else if (!focusMode && dialog.open) { dialog.close(); focusTrigger.current?.focus(); }
  }, [focusMode]);

  function patchDraft(patch: Partial<HorizonDayDraft>, chosenDate = date) {
    writeDraftBook(workspaceEpoch, current => ({ ...current, days: { ...current.days, [chosenDate]: { ...(current.days[chosenDate] ?? emptyHorizonDraft()), ...patch } } }));
    setStatus('');
  }

  function finishOperation(operation: HomeOperation) {
    if (draftEpoch !== operation.epoch) return;
    operation.finish?.();
    emitHorizonScene({ kind: 'commit', ...operation.commit });
    if (retryOperation.current === operation) { retryOperation.current = null; setError(''); }
    setStatus(operation.success);
  }

  async function runOperation(operation: HomeOperation) {
    if (lock.current || !ready || operation.epoch !== workspaceEpoch || draftEpoch !== workspaceEpoch) return;
    pendingCommits.current.delete(operation.key);
    lock.current = true; setBusy(operation.key); setError(''); setStatus('');
    try { await operation.action(); finishOperation(operation); }
    catch (cause) {
      if (draftEpoch === operation.epoch) {
        if (operation.matches) pendingCommits.current.set(operation.key, operation);
        retryOperation.current = operation;
        setError(`${cause instanceof Error ? cause.message : 'Die Änderung konnte nicht gespeichert werden.'} Dein Entwurf bleibt erhalten.`);
      }
    }
    finally { lock.current = false; setBusy(null); }
  }

  function perform(key: string, action: () => Promise<void>, success: string, commit: HomeCommit, completion: Partial<Pick<HomeOperation, 'finish' | 'matches' | 'source'>> = {}) {
    return runOperation({ key, action, success, commit, epoch: workspaceEpoch, source: 'planning', ...completion });
  }

  function selectCapture(next: CaptureMode | null) {
    if (capture && capture !== next) captureTyping(false);
    setCapture(next);
    if (next) emitHorizonScene({ kind: 'select', region: next === 'task' ? 'tasks' : next === 'note' ? 'notes' : 'reminders', active: true });
  }

  function captureTyping(active: boolean) {
    emitHorizonScene({ kind: 'typing', region: capture === 'task' ? 'tasks' : capture === 'note' ? 'notes' : 'reminders', active });
  }

  function changeDate(next: string) {
    if (next === date) return;
    setSelectedId(null); setOutsideTaskId(null); setMorningFocusDismissed(null); setFocusDirection('stationary'); setFocusRevision(value => value + 1); setStatus(''); setError(''); onDateChange(next);
  }
  function selectTask(id: string, direction?: number, region: 'tasks' | 'focus' = 'tasks') {
    const movement = direction ?? Math.sign(focusTasks.findIndex(task => task.id === id) - focusTasks.findIndex(task => task.id === selectedTask?.id));
    if (selectedTask?.id !== id) {
      setFocusDirection(movement < 0 ? 'previous' : movement > 0 ? 'next' : 'stationary');
      setFocusRevision(value => value + 1);
    }
    setOutsideTaskId(null); setSelectedId(id); setSubtasksOpen(true);
    if (morningTask) setMorningFocusDismissed(id === morningTask.id ? null : morningTask.id);
    emitHorizonScene({ kind: 'select', region, direction: movement, item: id });
  }
  function switchTask(direction: number) {
    if (focusTasks.length < 2) return;
    const id = horizonNextTaskId(focusTasks, selectedTask?.id ?? null, direction);
    if (id) selectTask(id, direction, 'focus');
  }
  function startSwipe(event: TouchEvent, target: typeof focusSwipeStart) {
    if (event.touches.length !== 1 || window.getSelection()?.isCollapsed === false || event.target instanceof Element && event.target.closest('input, textarea, button, select, a, label, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) {
      target.current = null;
      return;
    }
    const touch = event.touches[0];
    if (touch) target.current = { x: touch.clientX, y: touch.clientY };
  }
  function endSwipe(event: TouchEvent, target: typeof focusSwipeStart, action: (direction: number) => void) {
    const start = target.current; target.current = null;
    const touch = event.changedTouches[0];
    if (!start || !touch || window.getSelection()?.isCollapsed === false) return;
    const dx = touch.clientX - start.x, dy = touch.clientY - start.y;
    if (Math.abs(dx) >= 65 && Math.abs(dx) > Math.abs(dy) * 1.5) action(dx < 0 ? 1 : -1);
  }
  function toggleTask(task: Task) {
    if (selectedTask?.id === task.id && (!selectedId || task.morningRoutineDate)) setSelectedId(task.id);
    const next = task.status === 'done' ? 'open' : 'done';
    void perform(`task:${task.id}`, () => planner.setTaskStatus(task.id, next), next === 'done' ? 'Aufgabe als erledigt gespeichert.' : 'Aufgabe wieder geöffnet und gespeichert.', { region: 'tasks', action: next === 'done' ? 'complete' : 'restore', item: task.id }, {
      matches: current => current.data.tasks.some(item => item.id === task.id && item.status === next),
      finish: task.morningRoutineDate && next === 'done' ? () => {
        setSelectedId(null); setOutsideTaskId(null); setMorningFocusDismissed(null); setFocusMode(false);
      } : undefined,
    });
  }
  function toggleSubtask(taskId: string, subtaskId: string, done: boolean) {
    void perform(`subtask:${subtaskId}`, async () => {
      const current = latestPlanner.current.data.tasks.find(task => task.id === taskId);
      if (!current || !current.subtasks.some(item => item.id === subtaskId || item.children?.some(child => child.id === subtaskId))) throw new Error('Diese Unteraufgabe ist nicht mehr vorhanden.');
      await planner.saveTask({ ...current, subtasks: setSubtaskDone(current.subtasks, subtaskId, done) });
    }, 'Unteraufgabe gespeichert.', { region: 'focus', action: done ? 'complete' : 'restore', item: subtaskId }, {
      matches: current => Boolean(current.data.tasks.find(task => task.id === taskId)?.subtasks.some(item =>
        item.id === subtaskId ? subtaskState(item) === (done ? 'checked' : 'unchecked') : item.children?.some(child => child.id === subtaskId && child.done === done))),
    });
  }
  function updateSubtasks(task: Task, next: Subtask[], changedId?: string) {
    // The checklist changes one checkbox. Reapply that intent to the latest
    // task so concurrent metadata changes never get replaced by a stale task.
    if (changedId) {
      const changed = next.flatMap(item => [item, ...(item.children ?? [])]).find(item => item.id === changedId);
      if (changed) toggleSubtask(task.id, changedId, changed.done);
      return;
    }
    for (const item of task.subtasks) {
      const changed = next.find(candidate => candidate.id === item.id);
      if (!changed) continue;
      if (item.children?.length) {
        const children = item.children.filter(child => changed.children?.find(candidate => candidate.id === child.id)?.done !== child.done);
        if (children.length === 1) { toggleSubtask(task.id, children[0].id, !children[0].done); return; }
        if (children.length > 1) { toggleSubtask(task.id, item.id, subtaskState(changed) === 'checked'); return; }
      } else if (changed.done !== item.done) { toggleSubtask(task.id, item.id, changed.done); return; }
    }
  }
  function leaveMorningFocus() {
    if (!selectedTask?.morningRoutineDate) return;
    setMorningFocusDismissed(selectedTask.id); setOutsideTaskId(null);
    setSelectedId(null);
    setFocusDirection('next'); setFocusRevision(value => value + 1);
  }
  function skipMorning() {
    if (!selectedTask || !canSkipMorning) return;
    const task = selectedTask;
    // Keep the occurrence selected during a failed write so its Retry stays
    // visible even if the store holds an optimistic skipped receipt.
    setSelectedId(task.id);
    void perform(`morning-skip:${today}`, () => planner.skipMorningRoutine(today), 'Morgenroutine für heute übersprungen.', { region: 'focus', action: 'update', item: task.id }, {
      matches: current => Boolean(current.data.morningRoutineReceipts?.some(receipt => receipt.date === today && receipt.skipped)),
      finish: () => { setSelectedId(null); setOutsideTaskId(null); setMorningFocusDismissed(null); setFocusMode(false); },
    });
  }
  function addSubtask(event: FormEvent, task: Task) {
    event.preventDefault();
    if (lock.current || disabled) return;
    const item = book.subtasks[task.id];
    if (!item?.title.trim()) return;
    const id = item.id || crypto.randomUUID();
    writeDraftBook(workspaceEpoch, current => ({ ...current, subtasks: { ...current.subtasks, [task.id]: { ...item, id } } }));
    void perform(`subtask-add:${task.id}`, async () => {
      const current = latestPlanner.current.data.tasks.find(candidate => candidate.id === task.id);
      if (!current) throw new Error('Diese Aufgabe ist nicht mehr vorhanden.');
      await planner.saveTask({ ...current, subtasks: [...current.subtasks.filter(subtask => subtask.id !== id), { id, title: item.title.trim(), done: false, suggestion: false }] });
    }, 'Unteraufgabe hinzugefügt und gespeichert.', { region: 'focus', action: 'add', item: id }, {
      matches: current => Boolean(current.data.tasks.find(candidate => candidate.id === task.id)?.subtasks.some(subtask => subtask.id === id && subtask.title === item.title.trim())),
      finish: () => writeDraftBook(workspaceEpoch, value => {
        if (value.subtasks[task.id]?.id !== id || value.subtasks[task.id]?.title !== item.title) return value;
        const subtasks = { ...value.subtasks }; delete subtasks[task.id]; return { ...value, subtasks };
      }),
    });
  }

  function saveCapture(event: FormEvent) {
    event.preventDefault();
    if (!capture || lock.current || disabled) return;
    const chosenDate = date, chosen = capture, value = { ...draft };
    const title = (chosen === 'task' ? value.taskTitle : chosen === 'note' ? value.noteTitle : value.reminderTitle).trim();
    if (!title) return;
    const id = (chosen === 'task' ? value.taskId : chosen === 'note' ? value.noteOperationId : value.reminderId) || crypto.randomUUID();
    patchDraft(chosen === 'task' ? { taskId: id } : chosen === 'note' ? { noteOperationId: id } : { reminderId: id }, chosenDate);
    void perform(`capture:${chosen}:${id}`, async () => {
      const now = new Date().toISOString();
      if (chosen === 'task') {
        const current = latestPlanner.current.data.tasks.find(task => task.id === id);
        const task: Task = current ? { ...current, title } : { id, title, description: '', status: 'open', priority: null, estimatedMinutes: null, dueDate: null, plan: { kind: 'day', date: chosenDate }, subtasks: [], noteIds: [], tags: [], createdAt: now, updatedAt: now };
        await planner.saveTask(task);
      } else if (chosen === 'note') {
        if (!onCaptureNote) throw new Error('Die Notiz konnte hier nicht erfasst werden. Bitte öffne eine neue Notiz.');
        await onCaptureNote(title, value.noteContent, chosenDate, id);
      } else {
        const current = latestPlanner.current.data.reminders?.find(reminder => reminder.id === id);
        const reminder: Reminder = { id, title, localStart: `${chosenDate}T${value.reminderTime}`, timeZone, frequency: 'once', enabled: true, taskId: null, appointmentId: null, createdAt: current?.createdAt ?? now, updatedAt: now };
        await planner.saveReminder(reminder);
      }
    }, `${chosen === 'task' ? 'Aufgabe' : chosen === 'note' ? 'Notiz' : 'Erinnerung'} für ${formatDate(chosenDate, { day: 'numeric', month: 'long' })} gespeichert.`, { region: chosen === 'task' ? 'tasks' : chosen === 'note' ? 'notes' : 'reminders', action: 'add', item: id }, {
      source: chosen === 'note' ? 'notes' : 'planning',
      matches: chosen === 'task'
        ? current => current.data.tasks.some(task => task.id === id && task.title === title && task.plan?.kind === 'day' && task.plan.date === chosenDate)
        : chosen === 'reminder'
          ? current => Boolean(current.data.reminders?.some(reminder => reminder.id === id && reminder.title === title && reminder.localStart === `${chosenDate}T${value.reminderTime}`))
          : (_current, currentNotes) => currentNotes.some(note => note.id === id && !note.deletedAt && note.title === title && note.content === value.noteContent && note.tags.includes(`tag:${chosenDate}`)),
      finish: () => {
        writeDraftBook(workspaceEpoch, current => {
          const stored = current.days[chosenDate];
          if (!stored) return current;
          const unchanged = chosen === 'task' ? stored.taskId === id && stored.taskTitle === value.taskTitle
            : chosen === 'note' ? stored.noteOperationId === id && stored.noteTitle === value.noteTitle && stored.noteContent === value.noteContent
              : stored.reminderId === id && stored.reminderTitle === value.reminderTitle && stored.reminderTime === value.reminderTime;
          if (!unchanged) return current;
          const cleared = chosen === 'task' ? { taskTitle: '', taskId: '' }
            : chosen === 'note' ? { noteTitle: '', noteContent: '', noteOperationId: '' } : { reminderTitle: '', reminderId: '' };
          return { ...current, days: { ...current.days, [chosenDate]: { ...stored, ...cleared } } };
        });
        if (chosen === 'task') { setSelectedId(id); setOutsideTaskId(null); }
      },
    });
  }

  function renderSubtasks(task: Task, inFocus: boolean) {
    const item = book.subtasks[task.id];
    return <div className="horizon-subtasks" data-open="true" data-scene-item={task.id} id={inFocus ? 'horizon-focus-subtasks' : 'horizon-inline-subtasks'}>
      {task.subtasks.length ? <SubtaskChecklist value={task.subtasks} onChange={(next, changedId) => updateSubtasks(task, next, changedId)} disabled={disabled} /> : <p className="horizon-empty">Noch keine Unteraufgaben.</p>}
      <form className="horizon-subtask-add" onSubmit={event => addSubtask(event, task)}><input aria-label="Neue Unteraufgabe" placeholder="Nächsten Schritt ergänzen …" maxLength={500} value={item?.title ?? ''} disabled={disabled} onFocus={() => emitHorizonScene({ kind: 'typing', region: 'focus', active: true, item: task.id })} onBlur={() => emitHorizonScene({ kind: 'typing', region: 'focus', active: false, item: task.id })} onChange={event => {
        const title = event.target.value;
        writeDraftBook(workspaceEpoch, current => ({ ...current, subtasks: { ...current.subtasks, [task.id]: { title, id: current.subtasks[task.id]?.id ?? '' } } }));
        setStatus('');
        emitHorizonScene({ kind: 'typing', region: 'focus', active: true, item: task.id });
      }} /><button type="submit" aria-label="Unteraufgabe hinzufügen" disabled={disabled || !item?.title.trim()}><Plus size={17} /></button></form>
    </div>;
  }

  function renderFocusContent(inFocus: boolean) {
    const progress = subtaskProgress(selectedTask?.subtasks ?? []);
    return <><div className="horizon-focus-scene" key={`${selectedTask?.id ?? 'empty'}:${focusRevision}`} data-direction={focusDirection} data-scene-item={selectedTask?.id} data-focus-stage={inFocus ? 'immersed' : focusStage}>
      {selectedTask && <p className="horizon-focus-kicker">{isMorningFocus ? 'Morgenroutine' : inFocus || manualSelection ? 'Dein Fokus' : date < today ? 'Offene Tagesaufgabe' : 'Empfohlene nächste Handlung'}</p>}
      {selectedTask ? <>
        <h2 ref={inFocus ? undefined : inlineTitle} id={inFocus ? undefined : 'horizon-inline-focus-title'} className={`horizon-focus-title${!inFocus && !fullTitle ? ' is-preview' : ''}`}>{selectedTask.title}</h2>
        {!inFocus && titleOverflows && <button type="button" className="horizon-focus-title-toggle" aria-expanded={fullTitle} aria-controls="horizon-inline-focus-title" onClick={() => setFullTitle(value => !value)}>{fullTitle ? 'Titel einklappen' : 'Vollständigen Titel anzeigen'}{fullTitle ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</button>}
        {selectedTaskIndex >= 0 && <div className="horizon-focus-timing">
          {selectedBlock && selectedBlockDate
            ? <span>{date < today || (todayTime !== null && Date.parse(selectedBlock.startAt) < todayTime) ? 'Beginn geplant für' : 'Beginn um'} <time dateTime={selectedBlock.startAt}>{selectedBlockDate !== date && `${formatDate(selectedBlockDate, { day: 'numeric', month: 'short' })}, `}{formatTime(selectedBlock.startAt, timeZone)} Uhr</time> · {selectedBlock.durationMinutes} Min.</span>
            : <span>Ohne feste Uhrzeit{selectedTask.estimatedMinutes !== null && ` · ca. ${selectedTask.estimatedMinutes} Min.`}</span>}
          {selectedTask.status === 'done' && <span>Erledigt</span>}
        </div>}
        {selectedTask.description && inFocus && <p className="horizon-focus-description">{selectedTask.description}</p>}
        {selectedTaskIndex < 0 && <div className="horizon-outside-task"><p>Diese Aufgabe ist für diesen Tag noch nicht eingeplant.</p><button type="button" disabled={disabled} onClick={() => void perform(`plan:${selectedTask.id}`, () => planner.moveTask(selectedTask.id, { kind: 'day', date }), 'Aufgabe für diesen Tag eingeplant und gespeichert.', { region: 'tasks', action: 'update', item: selectedTask.id }, { finish: () => setOutsideTaskId(null), matches: current => current.data.tasks.some(task => task.id === selectedTask.id && task.plan?.kind === 'day' && task.plan.date === date) })}>Für diesen Tag einplanen</button></div>}
        {!inFocus && <div className="horizon-focus-actions horizon-primary-actions">
          <button ref={focusTrigger} className="horizon-enter-focus" type="button" onClick={() => { setSelectedId(selectedTask.id); setFocusMode(true); }}>Fokusmodus öffnen<ArrowRight size={18} /></button>
          {isMorningFocus && <button type="button" className="horizon-text-button" disabled={disabled} onClick={() => toggleTask(selectedTask)}><Check size={16} />{selectedTask.status === 'done' ? 'Aufgabe wieder öffnen' : 'Morgenroutine abschließen'}</button>}
        </div>}
        <button type="button" className="horizon-subtasks-toggle" aria-expanded={inFocus || subtasksOpen} aria-controls={inFocus ? 'horizon-focus-subtasks' : 'horizon-inline-subtasks'} onClick={() => { setSubtasksOpen(value => !value); emitHorizonScene({ kind: 'select', region: 'focus', active: !subtasksOpen, item: selectedTask.id }); }} disabled={inFocus}>
          {progress.total ? `${progress.done} von ${progress.total} Schritten erledigt` : 'Unteraufgaben'}{(inFocus || subtasksOpen) ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
        {(inFocus || subtasksOpen) && renderSubtasks(selectedTask, inFocus)}
        {inFocus && <div className="horizon-focus-details"><span>{selectedTask.status === 'done' ? 'Erledigt' : selectedTask.status === 'progress' ? 'In Bearbeitung' : 'Offen'}{selectedTask.estimatedMinutes !== null ? ` · ${selectedTask.estimatedMinutes} Min.` : ''}</span>{selectedTask.dueDate && <span>Fällig {formatDate(selectedTask.dueDate)}</span>}{selectedTask.noteIds.map(id => {
          const note = notes.find(note => note.id === id && !note.deletedAt);
          return note && <button type="button" key={id} onClick={() => { setFocusMode(false); onOpenNote(id); }}>{note.title || 'Unbenannte Notiz'}<ArrowUpRight size={13} /></button>;
        })}</div>}
        {inFocus && <div className="horizon-focus-actions">
          <button type="button" className="horizon-strong-button" disabled={disabled} onClick={() => toggleTask(selectedTask)}><Check size={16} />{selectedTask.status === 'done' ? 'Aufgabe wieder öffnen' : 'Aufgabe abschließen'}</button>
          <button type="button" className="horizon-text-button" disabled={disabled} onClick={() => { setFocusMode(false); onEditTask(selectedTask); }}>Details bearbeiten<ArrowUpRight size={14} /></button>
        </div>}
        {isMorningFocus && <div className="horizon-morning-actions">{canSkipMorning && <button type="button" disabled={disabled} onClick={skipMorning}>Heute überspringen</button>}<button type="button" disabled={disabled} onClick={leaveMorningFocus}>Andere Aufgabe</button></div>}
      </> : <div className="horizon-focus-empty"><Focus size={30} strokeWidth={1} /><h2>{planner.loading ? 'Aufgaben werden geladen …' : planner.loadError ? 'Aufgaben konnten nicht geladen werden.' : tasks.some(task => task.status !== 'done') ? 'Keine Aufgabe ausgewählt.' : tasks.length ? 'Alle Tagesaufgaben erledigt.' : 'Keine Aufgaben für diesen Tag.'}</h2>{ready && <button type="button" className="horizon-text-button" onClick={() => selectCapture('task')}>Aufgabe hinzufügen<Plus size={16} /></button>}</div>}
    </div>{morningTask && selectedTask?.id !== morningTask.id && <button type="button" className="horizon-text-button horizon-morning-return" onClick={() => selectTask(morningTask.id)}>Morgenroutine öffnen<ArrowRight size={16} /></button>}
    {!inFocus && manualSelection && !isMorningFocus && recommendedTask && selectedTask?.id !== recommendedTask.id && <button type="button" className="horizon-text-button horizon-morning-return" onClick={() => {
      setOutsideTaskId(null); setSelectedId(null); setSubtasksOpen(true);
      if (morningTask) setMorningFocusDismissed(morningTask.id);
      emitHorizonScene({ kind: 'select', region: 'focus', item: recommendedTask.id });
    }}>Empfehlung anzeigen<ArrowRight size={16} /></button>}
    {tasks.length > 1 && <div className="horizon-focus-navigation" role="group" aria-label="Tagesaufgabe wechseln"><button type="button" aria-label="Vorherige Tagesaufgabe" onClick={() => switchTask(-1)}><ChevronLeft size={18} /></button><span>Tagesaufgaben</span><button type="button" aria-label="Nächste Tagesaufgabe" onClick={() => switchTask(1)}><ChevronRight size={18} /></button></div>}
    </>;
  }

  function renderTask(task: Task) {
    const selected = task.id === selectedTask?.id;
    const done = task.status === 'done';
    const progress = subtaskProgress(task.subtasks);
    const detail = done ? 'Erledigt' : progress.total ? `${progress.done} von ${progress.total} Schritten`
      : task.status === 'progress' ? 'In Bearbeitung' : task.estimatedMinutes !== null ? `${task.estimatedMinutes} Min.` : null;
    return <li className={`${done ? 'is-done ' : ''}${selected ? 'is-selected' : ''}`} key={task.id} data-scene-item={task.id} data-scene-selected={selected}>
      <label className="horizon-task-check"><input type="checkbox" aria-label={`${done ? 'Aufgabe wieder öffnen' : 'Aufgabe abschließen'}: ${task.title}`} checked={done} disabled={disabled} onChange={() => toggleTask(task)} /><span aria-hidden="true">{done ? <Check size={15} /> : <Circle size={19} strokeWidth={1.2} />}</span></label>
      <button type="button" className="horizon-task-select" aria-label={`Fokus auswählen: ${task.title}`} aria-pressed={selected} aria-controls="horizon-selected-focus" onClick={() => selectTask(task.id)}>
        <span className="horizon-task-copy"><strong>{task.title}</strong>{detail && <small>{detail}</small>}</span><ChevronRight size={17} />
      </button>
    </li>;
  }

  function renderCalendarItem(item: typeof calendarItems[number]) {
    return <li key={item.kind + item.id}><button type="button" onClick={() => item.kind === 'appointment' ? onEditAppointment(item.appointment) : onEditBlock(item.block)}>
      {item.allDay ? <span className="horizon-agenda-time">Ganztägig</span>
        : dateInZone(item.startAt, timeZone) < date ? <span className="horizon-agenda-time">Fortsetzung</span>
        : <time className="horizon-agenda-time" dateTime={item.startAt}>{formatTime(item.startAt, timeZone)}</time>}
      <span className="horizon-agenda-title">{item.title}</span><ArrowUpRight size={13} />
    </button></li>;
  }

  function renderReminder(occurrence: typeof reminders[number]) {
    const done = occurrence.status !== 'pending';
    return <li key={occurrence.id} className={done ? 'is-done' : ''}>
      <label><input type="checkbox" aria-label={`Erinnerung erledigt: ${occurrence.reminder.title}`} checked={done} disabled={disabled} onChange={event => {
        const next = event.target.checked ? 'done' : 'pending';
        void perform(`reminder:${occurrence.id}`, () => planner.acknowledgeReminder(occurrence, next), 'Erinnerungsstatus gespeichert.', { region: 'reminders', action: next === 'done' ? 'complete' : 'restore', item: occurrence.id }, {
          matches: current => reminderOccurrences(current.data, date, date).some(item => item.id === occurrence.id && item.status === next),
        });
      }} /><span aria-hidden="true">{done ? <Check size={14} /> : <Bell size={14} />}</span></label>
      <button type="button" aria-label={`Erinnerung bearbeiten: ${occurrence.reminder.title}`} aria-describedby={`horizon-time-${occurrence.id}`} onClick={() => { emitHorizonScene({ kind: 'select', region: 'reminders', item: occurrence.id }); onEditReminder(occurrence.reminder); }}>
        <time id={`horizon-time-${occurrence.id}`} dateTime={occurrence.effectiveAt}>{formatTime(occurrence.effectiveAt, timeZone)}</time><span>{occurrence.reminder.title}{occurrence.adjusted && <small>Zeitumstellung angepasst</small>}</span>
      </button>
    </li>;
  }

  const feedback = (modal = false) => <div className="horizon-feedback" aria-live="polite">
    {busy && <p role="status"><LoaderCircle size={14} className="spin" />Wird gespeichert …</p>}
    {!busy && error && <div className="horizon-error" role="alert"><p>{error}</p>{retryOperation.current && <button type="button" onClick={() => { const operation = retryOperation.current; if (operation) void runOperation(operation); }}><RotateCcw size={14} />Erneut speichern</button>}</div>}
    {!busy && status && <p className="horizon-commit" role="status"><Check size={14} />{status}</p>}
    {!modal && storageUnavailable && <p className="horizon-draft-warning">Entwürfe bleiben beim Ansichtswechsel erhalten. Der Sitzungsspeicher ist nicht verfügbar; bitte vor dem Neuladen speichern.</p>}
  </div>;

  return <main className={`horizon-home${focusMode ? ' has-focus-mode' : ''}`} aria-label="Horizont Start" data-scene-region="home" data-focus-stage={focusStage} data-selected-task={selectedTask?.id}>
    <header className="horizon-home-intro"><h1 className="horizon-sr-only">Start</h1></header>

    <div className="horizon-day-overview">
      <section className="horizon-day-calendar" aria-label="Tageskalender" data-scene-region="calendar">
        <div className="horizon-day-title"><time dateTime={date}>{formatDate(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</time>{date !== today && <button type="button" onClick={() => { emitHorizonScene({ kind: 'day', region: 'calendar', direction: today > date ? 1 : -1, item: today }); changeDate(today); }}>Heute</button>}</div>
        <HorizonDayStrip date={date} today={today} onChange={changeDate} />
        <div className="horizon-upcoming">
          <h2 className="horizon-home-group-title">{calendarItemLabel ?? 'Zeitplan'}</h2>
          {nextCalendarItem ? <ol className="horizon-day-agenda">{renderCalendarItem(nextCalendarItem)}</ol>
            : <p className="horizon-empty">{planner.loading ? 'Zeitplan wird geladen …' : planner.loadError ? 'Zeitplan konnte nicht geladen werden.' : calendarItems.length ? 'Heute steht kein weiterer Termin oder Zeitblock an.' : 'Keine Termine oder Zeitblöcke.'}</p>}
          {otherCalendarItems.length > 0 && <><button type="button" className="horizon-show-more" aria-expanded={calendarExpanded} aria-controls="horizon-other-calendar" onClick={() => setCalendarExpanded(value => !value)}>
            {calendarExpanded ? 'Weitere Einträge ausblenden' : otherCalendarItems.length === 1 ? '1 weiterer Eintrag im Zeitplan' : `${otherCalendarItems.length} weitere Einträge im Zeitplan`}{calendarExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button><ol className="horizon-day-agenda horizon-more-items" id="horizon-other-calendar" hidden={!calendarExpanded}>{otherCalendarItems.map(renderCalendarItem)}</ol></>}
        </div>
        <div className="horizon-calendar-access"><button type="button" onClick={() => { emitHorizonScene({ kind: 'select', region: 'calendar', item: date }); onOpenCalendar(date); }}><CalendarDays size={15} />Großer Kalender<ArrowUpRight size={14} /></button><button type="button" aria-label="Termin hinzufügen" onClick={() => onEditAppointment(undefined, date)}><Plus size={17} /></button></div>
      </section>

      <aside className="horizon-day-aside" aria-label="Tagesnotizen und Erinnerungen">
        <section className="horizon-day-reminders" aria-label="Tageserinnerungen" data-scene-region="reminders">
          <div className="horizon-section-heading"><h2 className="horizon-home-group-title">{nextReminder ? reminderLabel : 'Erinnerungen'}</h2><button type="button" aria-label="Erinnerung hinzufügen" aria-expanded={capture === 'reminder'} onClick={() => selectCapture(capture === 'reminder' ? null : 'reminder')}><Plus size={20} /></button></div>
          {nextReminder ? <ul className="horizon-reminder-list">{renderReminder(nextReminder)}</ul>
            : <p className="horizon-empty">{planner.loading ? 'Erinnerungen werden geladen …' : planner.loadError ? 'Erinnerungen konnten nicht geladen werden.' : reminders.length ? 'Keine offene Erinnerung.' : 'Für diesen Tag ist keine Erinnerung geplant.'}</p>}
          {otherReminders.length > 0 && <><button type="button" className="horizon-show-more" aria-expanded={remindersExpanded} aria-controls="horizon-other-reminders" onClick={() => setRemindersExpanded(value => !value)}>
            {remindersExpanded ? 'Weitere Erinnerungen ausblenden' : `${otherReminders.length} weitere ${otherReminders.length === 1 ? 'Erinnerung' : 'Erinnerungen'}`}{remindersExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button><ul className="horizon-reminder-list horizon-more-items" id="horizon-other-reminders" hidden={!remindersExpanded}>{otherReminders.map(renderReminder)}</ul></>}
          <button type="button" className="horizon-text-button horizon-section-link" onClick={() => onNavigate('reminders')}>Alle Erinnerungen<ArrowRight size={17} /></button>
        </section>
        <section className="horizon-day-notes" aria-label="Tagesnotizen" data-scene-region="notes">
          <div className="horizon-section-heading"><h2 className="horizon-home-group-title">Notizen <span>{dayNotes.length}</span></h2><button type="button" aria-label="Notiz hinzufügen" aria-expanded={capture === 'note'} onClick={() => selectCapture(capture === 'note' ? null : 'note')}><Plus size={20} /></button></div>
          <ul className="horizon-note-list">{dayNotes.map(note => <li key={note.id}>
            <button type="button" aria-label={`Notiz öffnen: ${note.title || 'Unbenannte Notiz'}`} onClick={() => { emitHorizonScene({ kind: 'select', region: 'notes', item: note.id }); onOpenNote(note.id); }}><strong>{note.title || 'Unbenannte Notiz'}</strong>{note.preview && <span>{note.preview}</span>}</button>
          </li>)}</ul>
          {!dayNotes.length && <p className="horizon-empty">Noch keine Tagesnotizen.</p>}
          <button type="button" className="horizon-text-button horizon-section-link" onClick={() => onNavigate('notes')}>Alle Notizen<ArrowRight size={17} /></button>
        </section>
      </aside>
    </div>

    <section className="horizon-day-tasks" aria-label="Tagesaufgaben" data-scene-region="tasks"><div className="horizon-section-heading"><div><h2 className="horizon-home-group-title">Aufgaben</h2><small className="horizon-task-summary">{ready ? `${tasks.length - completed} offen · ${completed} erledigt` : 'Wird geladen …'}</small></div><button type="button" aria-label="Aufgabe hinzufügen" aria-expanded={capture === 'task'} onClick={() => selectCapture(capture === 'task' ? null : 'task')}><Plus size={20} /></button></div>
      {planner.loading ? <p className="horizon-empty">Aufgaben werden geladen …</p> : planner.loadError ? <p role="alert" className="horizon-error">{planner.loadError}</p> : <>
        {routineTasks.length > 0 && <section className="horizon-routine-tasks" aria-labelledby="horizon-routine-tasks-title">
          <h3 id="horizon-routine-tasks-title" className="horizon-home-group-title">Wiederkehrend</h3>
          <ul className="horizon-task-list">{routineTasks.map(renderTask)}</ul>
        </section>}
        {otherTasks.length > 0 && <div className="horizon-other-tasks">
          {routineTasks.length > 0 && <h3 className="horizon-home-group-title" id="horizon-other-tasks-title">Weitere Aufgaben</h3>}
          <ul className="horizon-task-list" aria-labelledby={routineTasks.length > 0 ? 'horizon-other-tasks-title' : undefined}>{otherTasks.map(renderTask)}</ul>
        </div>}
        {!tasks.length && <div className="horizon-empty horizon-tasks-empty"><p>Dieser Tag hat noch keine Aufgaben.</p><button type="button" className="horizon-text-button" onClick={() => selectCapture('task')}>Erste Aufgabe festhalten<Plus size={15} /></button></div>}
      </>}
      {recurrenceError && <div className="horizon-error" role="alert"><p>{recurrenceError}</p><button type="button" onClick={retryRecurring}>Wiederholungen erneut laden</button></div>}
      <button className="horizon-text-button horizon-section-link" type="button" onClick={() => onNavigate('tasks')}>Alle Aufgaben<ArrowRight size={17} /></button>
    </section>

    <section className="horizon-home-focus" id="horizon-selected-focus" aria-label={isMorningFocus ? 'Morgenroutine' : 'Dein Fokus'} data-scene-region="focus" data-scene-item={selectedTask?.id} data-focus-stage={focusStage} onTouchStart={event => startSwipe(event, focusSwipeStart)} onTouchEnd={event => endSwipe(event, focusSwipeStart, switchTask)} onTouchCancel={() => { focusSwipeStart.current = null; }}>{!focusMode && renderFocusContent(false)}</section>

    <section className={`horizon-home-capture${capture ? ' is-open' : ''}`} aria-label="Schnellerfassung" data-scene-region={capture === 'task' ? 'tasks' : capture === 'note' ? 'notes' : capture === 'reminder' ? 'reminders' : 'home'}><div className="horizon-capture-tools"><button type="button" className="horizon-text-button" onClick={() => selectCapture(capture ? null : 'task')} aria-expanded={capture !== null}><Plus size={16} />Schnell festhalten</button><div><button type="button" aria-label="Aufgaben diktieren" title="Aufgaben diktieren" onClick={onDictate}><Mic size={16} /></button><button type="button" aria-label="Erweiterte Schnellerfassung öffnen" title="Erweiterte Schnellerfassung" onClick={onQuickCapture}><Expand size={15} /></button></div></div>
      {capture && <form onSubmit={saveCapture} onChange={() => captureTyping(true)}><div className="horizon-capture-tabs" role="group" aria-label="Art der Schnellerfassung">{(['task', 'note', 'reminder'] as const).map(mode => <button type="button" key={mode} disabled={disabled} aria-pressed={capture === mode} onClick={() => selectCapture(mode)}>{mode === 'task' ? 'Aufgabe' : mode === 'note' ? 'Notiz' : 'Erinnerung'}</button>)}<button type="button" className="horizon-capture-close" aria-label="Schnellerfassung schließen" onClick={() => selectCapture(null)}><X size={15} /></button></div><label className="horizon-capture-label" htmlFor="horizon-capture-title">{capture === 'task' ? 'Neue Aufgabe' : capture === 'note' ? 'Titel der Notiz' : 'Neue Erinnerung'}<input autoFocus id="horizon-capture-title" maxLength={500} placeholder={capture === 'task' ? 'Was möchtest du erledigen?' : capture === 'note' ? 'Welcher Gedanke soll bleiben?' : 'Woran möchtest du erinnert werden?'} onFocus={() => captureTyping(true)} onBlur={() => captureTyping(false)} required value={capture === 'task' ? draft.taskTitle : capture === 'note' ? draft.noteTitle : draft.reminderTitle} disabled={disabled} onChange={event => patchDraft(capture === 'task' ? { taskTitle: event.target.value } : capture === 'note' ? { noteTitle: event.target.value } : { reminderTitle: event.target.value })} /></label>
        {capture === 'note' && <label className="horizon-capture-label">Notiztext<textarea onFocus={() => captureTyping(true)} onBlur={() => captureTyping(false)} rows={3} value={draft.noteContent} maxLength={200000} onChange={event => patchDraft({ noteContent: event.target.value })} disabled={disabled} placeholder="Ein Gedanke, eine Idee, etwas für später …" /></label>}
        {capture === 'reminder' && <label className="horizon-capture-label horizon-capture-time">Uhrzeit<input onFocus={() => captureTyping(true)} onBlur={() => captureTyping(false)} type="time" value={draft.reminderTime} required disabled={disabled} onChange={event => patchDraft({ reminderTime: event.target.value })} /><small>{timeZone}</small></label>}
        <div className="horizon-capture-footer"><span>Für {formatDate(date, { day: 'numeric', month: 'long' })}</span>{capture === 'note' && !onCaptureNote ? <button type="button" onClick={onCreateNote}>Notiz öffnen<ArrowUpRight size={14} /></button> : <button type="submit" disabled={disabled || !(capture === 'task' ? draft.taskTitle : capture === 'note' ? draft.noteTitle : draft.reminderTitle).trim()}>{busy?.startsWith('capture:') ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />}{error ? 'Erneut speichern' : 'Speichern'}</button>}</div>
      </form>}
      {feedback()}
    </section>

    <dialog className="horizon-focus-dialog" ref={focusDialog} aria-label="Fokusmodus" data-scene-region="focus" data-scene-item={selectedTask?.id} data-focus-stage={focusMode ? 'immersed' : focusStage} onCancel={() => setFocusMode(false)} onClose={() => setFocusMode(false)}><div className="horizon-focus-dialog-top"><span>Fokusmodus</span><button type="button" aria-label="Fokusmodus schließen" onClick={() => setFocusMode(false)} autoFocus><X size={22} /></button></div><div className="horizon-focus-dialog-body" onTouchStart={event => startSwipe(event, focusSwipeStart)} onTouchEnd={event => endSwipe(event, focusSwipeStart, switchTask)} onTouchCancel={() => { focusSwipeStart.current = null; }}>{focusMode && renderFocusContent(true)}{feedback(true)}</div></dialog>
  </main>;
}
