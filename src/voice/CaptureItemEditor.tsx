import { useId, useState } from 'react';
import type { CaptureItem } from '../planning/types';
import { validateCaptureItem } from '../planning/validation';

interface CaptureItemEditorProps {
  item: CaptureItem;
  timeZone: string;
  issues: string[];
  additionalReview: boolean;
  disabled: boolean;
  onSave: (item: CaptureItem) => void;
  onDiscard: () => void;
}

export function captureIssues(item: CaptureItem, timeZone: string): string[] {
  try {
    return [...new Set([...item.questions, ...validateCaptureItem(item, timeZone)])];
  } catch {
    return ['Die erkannten Angaben sind ungültig. Prüfe Titel, Planung und Zeitangaben.'];
  }
}

function optionalNumber(value: string): number | null {
  return value === '' ? null : Number(value);
}

export function CaptureItemEditor({ item, timeZone, issues, additionalReview, disabled, onSave, onDiscard }: CaptureItemEditorProps) {
  const prefix = useId();
  const [draft, setDraft] = useState<CaptureItem>(() => ({ ...item }));
  const [planKind, setPlanKind] = useState<'none' | 'day' | 'week'>(item.plannedDate ? 'day' : item.plannedWeek ? 'week' : 'none');
  const [clarified, setClarified] = useState(false);
  const [additionalConfirmed, setAdditionalConfirmed] = useState(false);
  const [validation, setValidation] = useState<string[]>([]);
  const manualOnly = item.intent === 'change' || item.intent === 'delete';
  const needsClarification = item.intent === 'unclear' || item.questions.length > 0 || issues.length > 0;

  function update(patch: Partial<CaptureItem>) {
    setDraft((previous) => ({ ...previous, ...patch }));
    setValidation([]);
  }

  function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || manualOnly) return;
    if (needsClarification && !clarified) {
      setValidation(['Bestätige bitte, dass du die Rückfragen geklärt hast und eine neue Aufgabe anlegen möchtest.']);
      return;
    }
    if (additionalReview && !additionalConfirmed) {
      setValidation(['Bestätige bitte, dass diese Aufgabe zusätzlich zu den bereits gespeicherten Einträgen angelegt werden soll.']);
      return;
    }
    const candidate: CaptureItem = {
      ...draft,
      title: draft.title.trim(),
      intent: 'create',
      questions: [],
      plannedDate: planKind === 'day' ? draft.plannedDate : null,
      plannedWeek: planKind === 'week' ? draft.plannedWeek : null,
    };
    const errors = captureIssues(candidate, timeZone);
    if (errors.length) {
      setValidation(errors);
      return;
    }
    onSave(candidate);
  }

  return (
    <article className={`voice-item${manualOnly ? ' voice-item-manual' : ''}`}>
      <header className="voice-item-heading">
        <h4>{item.title || 'Angaben klären'}</h4>
        <span className="voice-chip">{manualOnly ? 'Manuell bearbeiten' : needsClarification ? 'Rückfrage' : 'Vorschau'}</span>
      </header>
      <blockquote className="voice-source">{item.sourceText}</blockquote>
      {issues.length > 0 && <ul className="voice-questions">{issues.map((issue, index) => <li key={`${index}-${issue}`}>{issue}</li>)}</ul>}
      {manualOnly ? (
        <>
          <p className="voice-help">Diese Aussage betrifft eine Änderung oder Löschung. Es wurde nichts geändert. Wähle die betreffende Aufgabe in „Heute“ oder „Diese Woche“ aus und bestätige die gewünschte Änderung dort im Aufgabeneditor.</p>
          <button type="button" className="secondary-button" disabled={disabled} onClick={onDiscard}>Hinweis erledigt</button>
        </>
      ) : (
        <form onSubmit={save}>
          <fieldset className="voice-fields" disabled={disabled}>
            <legend className="voice-visually-hidden">Neue Aufgabe prüfen</legend>
            <label className="field" htmlFor={`${prefix}-title`}><span>Titel</span><input id={`${prefix}-title`} value={draft.title} maxLength={500} required onChange={(event) => update({ title: event.target.value })} /></label>
            <label className="field" htmlFor={`${prefix}-description`}><span>Beschreibung</span><textarea id={`${prefix}-description`} rows={2} value={draft.description} onChange={(event) => update({ description: event.target.value })} /></label>
            <div className="voice-field-grid">
              <label className="field" htmlFor={`${prefix}-priority`}><span>Priorität</span><select id={`${prefix}-priority`} value={draft.priority ?? ''} onChange={(event) => update({ priority: event.target.value === '' ? null : event.target.value as CaptureItem['priority'] })}><option value="">Nicht angegeben</option><option value="low">Niedrig</option><option value="normal">Normal</option><option value="high">Hoch</option></select></label>
              <label className="field" htmlFor={`${prefix}-estimate`}><span>Geschätzte Dauer · Minuten</span><input id={`${prefix}-estimate`} type="number" min={1} max={1440} step={1} value={draft.estimatedMinutes ?? ''} onChange={(event) => update({ estimatedMinutes: optionalNumber(event.target.value) })} /></label>
            </div>
            <label className="field" htmlFor={`${prefix}-plan`}><span>Planung · wann bearbeiten?</span><select id={`${prefix}-plan`} value={planKind} onChange={(event) => { setPlanKind(event.target.value as typeof planKind); setValidation([]); }}><option value="none">Nicht eingeplant · Eingang</option><option value="day">An einem Tag</option><option value="week">In einer Woche</option></select></label>
            {planKind === 'day' && <label className="field" htmlFor={`${prefix}-day`}><span>Geplanter Bearbeitungstag</span><input id={`${prefix}-day`} type="date" required value={draft.plannedDate ?? ''} onChange={(event) => update({ plannedDate: event.target.value || null })} /></label>}
            {planKind === 'week' && <label className="field" htmlFor={`${prefix}-week`}><span>Geplante Woche · Montag als Beginn</span><input id={`${prefix}-week`} type="date" required value={draft.plannedWeek ?? ''} onChange={(event) => update({ plannedWeek: event.target.value || null })} /></label>}
            <label className="field" htmlFor={`${prefix}-due`}><span>Fälligkeit · bis wann fertig? (optional)</span><input id={`${prefix}-due`} type="date" value={draft.dueDate ?? ''} onChange={(event) => update({ dueDate: event.target.value || null })} /></label>
            <div className="voice-field-grid">
              <label className="field" htmlFor={`${prefix}-time`}><span>Beginn des Zeitblocks</span><input id={`${prefix}-time`} type="time" step={60} value={draft.startTime ?? ''} onChange={(event) => update({ startTime: event.target.value || null })} /></label>
              <label className="field" htmlFor={`${prefix}-duration`}><span>Zeitblock · Minuten</span><input id={`${prefix}-duration`} type="number" min={1} max={1440} step={1} value={draft.durationMinutes ?? ''} onChange={(event) => update({ durationMinutes: optionalNumber(event.target.value) })} /></label>
            </div>
            <p className="voice-help">Ein Zeitblock benötigt einen Bearbeitungstag, eine Startzeit und eine Dauer. Zeiten gelten in {timeZone}. Planung und Fälligkeit sind voneinander unabhängig.</p>
            {(draft.startTime !== null || draft.durationMinutes !== null) && <div className="voice-time-help"><button type="button" className="secondary-button" onClick={() => update({ startTime: null, durationMinutes: null })}>Zeitblock weglassen</button><p className="voice-help">Bei einer mehrdeutigen Zeitumstellung kannst du die Aufgabe zunächst ohne Zeitblock anlegen und die frühere oder spätere Uhrzeit anschließend im Zeitblock-Editor wählen.</p></div>}
            {draft.suggestions.length > 0 && <div className="voice-suggestions"><strong>Vorschläge der KI</strong><ul>{draft.suggestions.map((suggestion, index) => <li key={index}>{suggestion}</li>)}</ul><p>Diese Ergänzungen werden ausdrücklich mit „Vorschlag:“ in der Beschreibung gekennzeichnet.</p></div>}
            {needsClarification && <label className="voice-confirm"><input type="checkbox" checked={clarified} onChange={(event) => { setClarified(event.target.checked); setValidation([]); }} /><span>Ich habe die Rückfragen geklärt und möchte aus diesen Angaben eine neue Aufgabe anlegen.</span></label>}
            {additionalReview && <label className="voice-confirm"><input type="checkbox" checked={additionalConfirmed} onChange={(event) => { setAdditionalConfirmed(event.target.checked); setValidation([]); }} /><span>Dies ist eine zusätzliche neue Aufgabe. Bereits gespeicherte Aufgaben dieser Aufnahme habe ich geprüft.</span></label>}
            {validation.length > 0 && <ul className="voice-warning" role="alert">{validation.map((message, index) => <li key={index}>{message}</li>)}</ul>}
            <div className="voice-actions"><button type="button" className="secondary-button" onClick={onDiscard}>Verwerfen</button><button type="submit" className="primary-button">Neue Aufgabe anlegen</button></div>
          </fieldset>
        </form>
      )}
    </article>
  );
}
