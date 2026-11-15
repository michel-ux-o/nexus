import { useRef, useState } from 'react';
import { Check, CornerDownLeft, FilePlus2, ListPlus, LoaderCircle, Mic, NotebookPen, RotateCcw } from 'lucide-react';
import type { Planner, Task, TaskPlan } from '../planning/types';
import { startOfWeek } from '../planning/dates';

interface HomeCaptureProps {
  planner: Planner;
  today: string;
  hidden: boolean;
  onCreateNote: () => void;
  onCaptureNote?: (title: string, content: string, operationId: string) => Promise<void>;
  onDictate: () => void;
  onQuickCapture?: () => void;
}

export function HomeCapture({ planner, today, hidden, onCreateNote, onCaptureNote, onDictate, onQuickCapture }: HomeCaptureProps) {
  const [mode, setMode] = useState<'task' | 'note'>('task');
  const [taskTitle, setTaskTitle] = useState('');
  const [noteTitle, setNoteTitle] = useState('');
  const [noteContent, setNoteContent] = useState('');
  const [destination, setDestination] = useState<'inbox' | 'today' | 'week'>('inbox');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const lock = useRef(false);
  const taskIdentity = useRef<{ id: string; createdAt: string } | null>(null);
  const noteIdentity = useRef<string | null>(null);
  const ready = !planner.loading && !planner.loadError;

  function changeMode(next: 'task' | 'note') {
    setMode(next);
    setError('');
    setSaved('');
  }

  async function save() {
    if (lock.current || !ready) return;
    const title = (mode === 'task' ? taskTitle : noteTitle).trim();
    if (!title) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setSaved('');
    try {
      if (mode === 'task') {
        taskIdentity.current ??= { id: crypto.randomUUID(), createdAt: new Date().toISOString() };
        const plan: TaskPlan = destination === 'today' ? { kind: 'day', date: today }
          : destination === 'week' ? { kind: 'week', weekStart: startOfWeek(today) } : null;
        const task: Task = { ...taskIdentity.current, title, description: '', status: 'open', priority: null,
          estimatedMinutes: null, dueDate: null, plan, subtasks: [], noteIds: [], tags: [], updatedAt: new Date().toISOString() };
        await planner.saveTask(task);
        taskIdentity.current = null;
        setTaskTitle('');
        setSaved('Aufgabe gespeichert.');
      } else if (onCaptureNote) {
        noteIdentity.current ??= crypto.randomUUID();
        await onCaptureNote(title, noteContent, noteIdentity.current);
        noteIdentity.current = null;
        setNoteTitle('');
        setNoteContent('');
        setSaved('Notiz gespeichert.');
      }
    } catch (reason) {
      setError(`${reason instanceof Error ? reason.message : 'Der Eintrag konnte nicht gespeichert werden.'} Dein Entwurf bleibt erhalten.`);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return <section className="home-panel home-capture" hidden={hidden} aria-label="Schnell erfassen">
    <div className="home-capture-top">
      <div className="home-segmented" role="group" aria-label="Art der Schnellerfassung">
        <button type="button" aria-pressed={mode === 'task'} onClick={() => changeMode('task')} disabled={busy}><ListPlus size={14} aria-hidden="true" />Aufgabe</button>
        <button type="button" aria-pressed={mode === 'note'} onClick={() => changeMode('note')} disabled={busy}><NotebookPen size={14} aria-hidden="true" />Notiz</button>
      </div>
      <div className="home-capture-tools">
        {onQuickCapture && <button className="home-text-button" type="button" onClick={onQuickCapture} disabled={busy || !ready}>Kurz festhalten</button>}
        <button className="home-icon-button" type="button" onClick={onDictate} disabled={busy || !ready} aria-label="Aufgaben diktieren" title="Aufgaben diktieren"><Mic size={17} aria-hidden="true" /></button>
      </div>
    </div>
    {mode === 'note' && !onCaptureNote ? <div className="home-capture-fallback"><p>Halte deinen Gedanken in einer neuen Notiz fest.</p><button className="home-quiet-button" type="button" onClick={onCreateNote}><FilePlus2 size={16} aria-hidden="true" />Neue Notiz</button></div> : <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <label className="home-field" htmlFor="home-capture-title">{mode === 'task' ? 'Was möchtest du erledigen?' : 'Was möchtest du festhalten?'}
        <input id="home-capture-title" value={mode === 'task' ? taskTitle : noteTitle} onChange={event => { (mode === 'task' ? setTaskTitle : setNoteTitle)(event.target.value); setSaved(''); }} maxLength={500} placeholder={mode === 'task' ? 'Zum Beispiel: Unterlagen sortieren' : 'Titel deiner Notiz'} disabled={busy || !ready} required />
      </label>
      {mode === 'task' ? <fieldset className="home-capture-plan" disabled={busy || !ready}><legend>Einplanen</legend><div>
        {([{ value: 'inbox', label: 'Im Eingang lassen' }, { value: 'today', label: 'Heute' }, { value: 'week', label: 'Diese Woche' }] as const).map(option => <label key={option.value} className={destination === option.value ? 'is-selected' : ''}><input type="radio" name="home-capture-plan" value={option.value} checked={destination === option.value} onChange={() => { setDestination(option.value); setSaved(''); }} />{option.label}</label>)}
      </div></fieldset> : <label className="home-field home-note-content" htmlFor="home-capture-content">Inhalt <span>(optional)</span><textarea id="home-capture-content" rows={3} value={noteContent} onChange={event => { setNoteContent(event.target.value); setSaved(''); }} disabled={busy || !ready} placeholder="Ein Gedanke, eine Idee, etwas für später …" /></label>}
      {error && <p className="home-capture-error" role="alert">{error}</p>}
      <div className="home-capture-bottom">
        <div className="home-capture-feedback" aria-live="polite">{busy ? <span><LoaderCircle size={13} className="spin" aria-hidden="true" />Wird gespeichert …</span> : saved ? <span className="home-capture-saved"><Check size={13} aria-hidden="true" />{saved}</span> : <span>{mode === 'task' ? 'Fälligkeit und weitere Details kannst du anschließend ergänzen.' : 'Dein Gedanke bleibt als eigene Notiz erhalten.'}</span>}</div>
        <button className="home-save-button" type="submit" disabled={busy || !ready || !(mode === 'task' ? taskTitle : noteTitle).trim()}>{busy ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : error ? <RotateCcw size={15} aria-hidden="true" /> : <CornerDownLeft size={15} aria-hidden="true" />}{error ? 'Erneut speichern' : 'Speichern'}</button>
      </div>
    </form>}
  </section>;
}
