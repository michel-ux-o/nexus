import { useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { CheckSquare, Download, NotebookPen, Save } from 'lucide-react';
import type { Planner, Task } from '../planning/types';
import { formatDate, startOfWeek, todayInZone } from '../planning/dates';
import { WorkspaceDialog } from '../layout/WorkspaceDialog';
import './QuickCapture.css';

export interface QuickCaptureProps {
  planner: Planner;
  onClose: () => void;
  /** Resolve only after commit; operationId scopes note retries to this dialog. */
  onCreateNote: (title: string, content: string, operationId?: string) => Promise<void>;
}
export interface QuickCaptureDraft {
  id: string;
  createdAt: string;
  date: string;
  kind: 'task' | 'note';
  target: 'inbox' | 'today' | 'week';
  title: string;
  content: string;
}

/** Pure conversion keeps the capture ID and its original calendar day on retries. */
export function taskFromQuickCapture(draft: QuickCaptureDraft, updatedAt = new Date().toISOString()): Task {
  return {
    id: draft.id, createdAt: draft.createdAt, updatedAt, title: draft.title.trim(), description: draft.content,
    status: 'open', priority: null, estimatedMinutes: null, dueDate: null, tags: [], subtasks: [], noteIds: [],
    plan: draft.target === 'today' ? { kind: 'day', date: draft.date } : draft.target === 'week' ? { kind: 'week', weekStart: startOfWeek(draft.date) } : null,
  };
}

export function QuickCapture({ planner, onClose, onCreateNote }: QuickCaptureProps) {
  const id = useId();
  const [draft, setDraft] = useState<QuickCaptureDraft>(() => ({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), date: todayInZone(planner.data.settings.timeZone), kind: 'task', target: 'inbox', title: '', content: '' }));
  const operationId = useRef<string | null>(draft.id);
  const [busy, setBusy] = useState(false);
  const [attemptedKind, setAttemptedKind] = useState<QuickCaptureDraft['kind'] | null>(null);
  const saving = useRef(false);
  const [error, setError] = useState('');
  const [downloadError, setDownloadError] = useState('');
  const backup = useRef<HTMLTextAreaElement>(null);
  const isTask = draft.kind === 'task';
  const draftText = `NEXUS – Schnellerfassungsentwurf\nNoch nicht bestätigt gespeichert.\n\n${JSON.stringify(draft, null, 2)}`;
  function patch(values: Partial<QuickCaptureDraft>) { setDraft((current) => ({ ...current, ...values })); }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving.current || !draft.title.trim() || planner.loading || planner.loadError) return;
    saving.current = true;
    setAttemptedKind(draft.kind);
    setBusy(true); setError('');
    try {
      if (draft.kind === 'task') await planner.saveTask(taskFromQuickCapture(draft));
      else await onCreateNote(draft.title.trim(), draft.content, operationId.current ??= crypto.randomUUID());
      operationId.current = null;
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Der Eintrag konnte nicht gespeichert werden.');
      setBusy(false);
    } finally { saving.current = false; }
  }
  function downloadDraft() {
    try {
      const url = URL.createObjectURL(new Blob([draftText], { type: 'text/plain;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = 'nexus-schnellerfassungsentwurf.txt';
      document.body.append(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDownloadError('');
    } catch { setDownloadError('Der Download ist fehlgeschlagen. Kopiere den Entwurf aus dem Textfeld.'); }
  }
  return <WorkspaceDialog title="Kurz festhalten" eyebrow="SCHNELLERFASSUNG" busy={busy} onClose={onClose} className="nexus-capture-dialog">
    <form className="nexus-capture-form" onSubmit={(event) => void save(event)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); event.currentTarget.requestSubmit(); } }}>
      <fieldset className="nexus-capture-fields" disabled={busy}>
        <fieldset className="nexus-capture-kind"><legend>Was möchtest du festhalten?</legend>
          <label className={isTask ? 'is-selected' : ''}><input type="radio" name={`${id}-kind`} value="task" checked={isTask} disabled={attemptedKind !== null} onChange={() => patch({ kind: 'task' })} /><CheckSquare size={16} aria-hidden="true" /><span>Aufgabe</span></label>
          <label className={!isTask ? 'is-selected' : ''}><input type="radio" name={`${id}-kind`} value="note" checked={!isTask} disabled={attemptedKind !== null} onChange={() => patch({ kind: 'note' })} /><NotebookPen size={16} aria-hidden="true" /><span>Notiz</span></label>
        </fieldset>
        <label className="nexus-capture-field" htmlFor={`${id}-title`}><span>{isTask ? 'Was möchtest du erledigen?' : 'Titel deiner Notiz'}</span><input id={`${id}-title`} data-initial-focus autoComplete="off" required maxLength={500} value={draft.title} onChange={(event) => patch({ title: event.target.value })} placeholder={isTask ? 'Zum Beispiel: Unterlagen sortieren' : 'Ein Gedanke, den du behalten möchtest'} /></label>
        {!isTask ? <label className="nexus-capture-field" htmlFor={`${id}-content`}><span>Dein Gedanke · optional</span><textarea id={`${id}-content`} rows={5} maxLength={100000} value={draft.content} onChange={(event) => patch({ content: event.target.value })} placeholder="Hier ist Platz für deine Notiz …" /></label>
          : <details className="nexus-capture-details"><summary>Beschreibung ergänzen</summary><label className="nexus-capture-field" htmlFor={`${id}-description`}><span>Beschreibung · optional</span><textarea id={`${id}-description`} rows={3} maxLength={100000} value={draft.content} onChange={(event) => patch({ content: event.target.value })} /></label></details>}
        {isTask && <fieldset className="nexus-capture-target"><legend>Einplanen</legend>{([
          ['inbox', 'Im Eingang lassen'], ['today', 'Heute'], ['week', 'Diese Woche'],
        ] as const).map(([target, label]) => <label className={draft.target === target ? 'is-selected' : ''} key={target}><input type="radio" name={`${id}-target`} checked={draft.target === target} onChange={() => patch({ target })} /><span>{label}</span></label>)}</fieldset>}
        <p className="nexus-capture-help">{isTask ? `Fälligkeit und weitere Details kannst du anschließend ergänzen.${draft.target === 'today' ? ` Geplant für ${formatDate(draft.date)}.` : draft.target === 'week' ? ` Im Wochenpool ab ${formatDate(startOfWeek(draft.date))}.` : ''}` : 'Die Notiz wird in deinen Notizen gespeichert.'}</p>
      </fieldset>
      {error && <section className="nexus-capture-error" aria-label="Speicherfehler und Entwurfssicherung"><p role="alert"><strong>Nicht gespeichert.</strong> {error} Dein Entwurf bleibt erhalten. Sichere ihn vor dem Schließen.</p><button type="button" onClick={downloadDraft}><Download size={16} aria-hidden="true" /> Entwurf als Text sichern</button>
        <p>Beim erneuten Speichern wird dieselbe {isTask ? 'Aufgabe' : 'Notiz'} aktualisiert.</p>
        {downloadError && <p role="alert">{downloadError}</p>}
        <details><summary>Entwurf zum Kopieren</summary><label className="nexus-capture-field"><span>Vollständiger Entwurf · nur zum Kopieren</span><textarea ref={backup} readOnly rows={7} value={draftText} onFocus={(event) => event.currentTarget.select()} /></label><button type="button" onClick={() => { backup.current?.focus(); backup.current?.select(); }}>Gesamten Entwurf markieren</button></details>
      </section>}
      <footer className="nexus-capture-footer"><p role="status">{busy ? 'Wird gespeichert. Bitte warte auf den Abschluss.' : 'Strg/Cmd + Eingabe zum Speichern'}</p><div><button type="button" disabled={busy} onClick={onClose}>Abbrechen</button><button className="nexus-capture-save" type="submit" disabled={busy || !draft.title.trim() || planner.loading || Boolean(planner.loadError)} aria-keyshortcuts="Control+Enter Meta+Enter"><Save size={16} aria-hidden="true" />{busy ? 'Wird gespeichert …' : error ? 'Erneut speichern' : 'Speichern'}</button></div></footer>
    </form>
  </WorkspaceDialog>;
}
