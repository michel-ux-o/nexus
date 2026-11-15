import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Check, Copy, Sparkles } from 'lucide-react';
import type { Note } from '../types';
import type { Planner } from '../planning/types';
import { todayInZone } from '../planning/dates';
import { api } from '../services/ai';
import { useAIConnection } from './useAIConnection';
import { PLANNING_AI_ACTIONS, PLAN_RESPONSE_EXAMPLE, buildAcceptedPlanning, buildPlanningPrompt, capturePlanningSource, isPlanningSourceCurrent, parsePlanningProposal, planningWarnings } from './planningPrompts';
import type { PlanAcceptance, PlanningAIAction, PlanningSelection, PlanningSource } from './planningPrompts';
import './AIPanel.css';
import './PlanningAIPanel.css';

interface PlanningAIPanelProps { planner: Planner; notes: Note[]; onClose: () => void; workspaceEpoch: number; embedded?: boolean }
const noAcceptance = (): PlanAcceptance => ({ taskIds: [], newTaskIndexes: [], review: false });
const noSelection = (): PlanningSelection => ({ taskIds: [], noteIds: [], appointmentIds: [] });

export function PlanningAIPanel({ planner, notes, onClose, workspaceEpoch, embedded = false }: PlanningAIPanelProps) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const live = useRef({ planner, notes, workspaceEpoch, mounted: true });
  live.current = { planner, notes, workspaceEpoch, mounted: live.current.mounted };
  const requestRef = useRef<AbortController | null>(null);
  const requestGeneration = useRef(0);
  const [action, setAction] = useState<PlanningAIAction>('day');
  const [date, setDate] = useState(() => todayInZone(planner.data.settings.timeZone));
  const [selection, setSelection] = useState<PlanningSelection>(noSelection);
  const [filter, setFilter] = useState('');
  const [source, setSource] = useState<PlanningSource | null>(null);
  const [prompt, setPrompt] = useState('');
  const [response, setResponse] = useState('');
  const [accepted, setAccepted] = useState<PlanAcceptance>(noAcceptance);
  const [confirmed, setConfirmed] = useState(false);
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingSave, setPendingSave] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const { connection, connectionError, checking, checkConnection } = useAIConnection();
  const stale = source !== null && !isPlanningSourceCurrent(source, planner.data, notes, workspaceEpoch);
  const frozen = saving || pendingSave;
  const consentReady = planner.data.settings.aiConsent && planner.status === 'saved';
  const activeNotes = notes.filter((note) => !note.deletedAt);
  const matches = (value: string) => value.toLocaleLowerCase('de').includes(filter.toLocaleLowerCase('de'));

  useEffect(() => {
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    live.current.mounted = true;
    if (!embedded && dialog && !dialog.open) dialog.showModal();
    return () => {
      live.current.mounted = false;
      requestRef.current?.abort();
      if (dialog?.open) dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [embedded]);
  useEffect(() => { requestRef.current?.abort(); setSending(false); setConfirmed(false); }, [workspaceEpoch]);

  const parsed = useMemo(() => {
    if (!source || !response.trim()) return { proposal: null, error: '' };
    try { return { proposal: parsePlanningProposal(response, source), error: '' }; }
    catch (cause) { return { proposal: null, error: cause instanceof Error ? cause.message : 'Die Antwort ist ungültig.' }; }
  }, [source, response]);
  const warnings = useMemo(() => {
    if (!source || !parsed.proposal) return [];
    let serial = 0;
    try {
      const preview = buildAcceptedPlanning(planner.data, source, parsed.proposal, accepted, new Date().toISOString(), () => `ai-preview-${serial++}`);
      return planningWarnings(preview, source.dates, source.timeZone);
    } catch (cause) { return [cause instanceof Error ? cause.message : 'Die Zeitplanung konnte nicht geprüft werden.']; }
  }, [planner.data, source, parsed.proposal, accepted]);
  const hasAccepted = accepted.taskIds.length + accepted.newTaskIndexes.length > 0 || accepted.review;
  const canApply = Boolean(source && parsed.proposal && hasAccepted && confirmed && !stale && !frozen && !planner.loading && !planner.loadError);

  function invalidate() {
    requestRef.current?.abort();
    requestGeneration.current++;
    setSending(false);
    setSource(null);
    setPrompt('');
    setConfirmed(false);
    setAccepted(noAcceptance());
    setStatus('Auswahl geändert. Gib den gewünschten Kontext erneut ausdrücklich frei.');
    setError('');
  }
  function toggleSelection(key: keyof PlanningSelection, value: string) {
    invalidate();
    setSelection((old) => ({ ...old, [key]: old[key].includes(value) ? old[key].filter((item) => item !== value) : [...old[key], value] }));
  }
  function chooseSource() {
    requestRef.current?.abort();
    requestGeneration.current++;
    setSending(false);
    setError('');
    try {
      const snapshot = capturePlanningSource(planner.data, notes, selection, action, date, workspaceEpoch);
      setSource(snapshot);
      setPrompt(buildPlanningPrompt(snapshot));
      setAccepted(noAcceptance());
      setConfirmed(false);
      setStatus(response ? 'Kontext erneuert. Die vorhandene Antwort bleibt erhalten; prüfe sie vollständig gegen die neue Quelle.' : 'Kontext lokal freigegeben. Prüfe den vollständigen Prompt vor der Weitergabe.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Kontext konnte nicht übernommen werden.'); }
  }
  function editResponse(value: string) {
    requestRef.current?.abort();
    requestGeneration.current++;
    setSending(false);
    setResponse(value);
    setAccepted(noAcceptance());
    setConfirmed(false);
    setError('');
  }
  function accept(next: PlanAcceptance) { setAccepted(next); setConfirmed(false); setError(''); }
  async function copyPrompt() {
    if (!source || !prompt.trim()) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard-unavailable');
      await navigator.clipboard.writeText(prompt);
      if (live.current.mounted) setStatus('Prompt kopiert. Füge ihn in ChatGPT ein und sende ihn dort selbst ab.');
    } catch {
      promptRef.current?.focus(); promptRef.current?.select();
      setError('Kopieren nicht möglich. Der Prompt ist markiert; kopiere ihn über Strg+C oder das Kopiermenü.');
    }
  }
  async function giveConsent() {
    setSaving(true); setError('');
    try {
      planner.updateSettings({ aiConsent: true });
      if (!await planner.flush()) throw new Error('Die Zustimmung konnte nicht gespeichert werden. Bitte erneut versuchen.');
      if (live.current.mounted) setStatus('Zustimmung gespeichert. Jede Anfrage braucht weiterhin deinen eigenen Klick auf „An OpenAI senden“.');
    } catch (cause) { if (live.current.mounted) setError(cause instanceof Error ? cause.message : 'Zustimmung konnte nicht gespeichert werden.'); }
    finally { if (live.current.mounted) setSaving(false); }
  }
  async function sendPrompt() {
    if (!source || stale || !prompt.trim() || !connection?.configured || !consentReady || frozen) return;
    requestRef.current?.abort();
    const request = new AbortController(); requestRef.current = request;
    const generation = ++requestGeneration.current;
    const requestSource = source;
    setSending(true); setError(''); setStatus('Der freigegebene Prompt wird an OpenAI gesendet …'); setConfirmed(false);
    try {
      const answer = await api.assist(prompt, `planning-${action}`, crypto.randomUUID(), request.signal);
      const current = live.current;
      if (request.signal.aborted || !current.mounted || generation !== requestGeneration.current) return;
      if (!isPlanningSourceCurrent(requestSource, current.planner.data, current.notes, current.workspaceEpoch)) throw new Error('Der Kontext hat sich während der Anfrage geändert. Erneuere ihn und frage erneut an.');
      if (typeof answer.text !== 'string' || !answer.text.trim() || answer.text.length > 1_000_000) throw new Error('Das Backend hat keine verwendbare Textantwort geliefert.');
      setResponse(answer.text); setAccepted(noAcceptance()); setStatus('Antwort empfangen. Prüfe jede vorgeschlagene Änderung und wähle ihre Übernahme ausdrücklich aus.');
    } catch (cause) { if (!request.signal.aborted && live.current.mounted) setError(cause instanceof Error ? cause.message : 'Die Anfrage ist fehlgeschlagen. Der manuelle Ablauf bleibt verfügbar.'); }
    finally { if (!request.signal.aborted && live.current.mounted && generation === requestGeneration.current) setSending(false); }
  }
  async function applyProposal() {
    if (!canApply || !source || !parsed.proposal) return;
    const epoch = workspaceEpoch;
    setSaving(true); setError('');
    try {
      planner.update((data) => {
        if (!isPlanningSourceCurrent(source, data, live.current.notes, live.current.workspaceEpoch)) throw new Error('Der Kontext ist nicht mehr aktuell. Erneuere ihn und prüfe die Antwort erneut.');
        return buildAcceptedPlanning(data, source, parsed.proposal!, accepted);
      });
      // The exact draft is now owned by the store. Retrying flush must never recreate tasks.
      setPendingSave(true);
      if (!await planner.flush()) throw new Error('Speichern fehlgeschlagen. Der Entwurf bleibt erhalten; „Speichern erneut versuchen“ legt keine Aufgaben doppelt an.');
      if (live.current.mounted && live.current.workspaceEpoch === epoch) {
        setPendingSave(false); setSource(null); setPrompt(''); setResponse(''); setAccepted(noAcceptance()); setConfirmed(false);
        setStatus('Die ausdrücklich ausgewählten Änderungen wurden gespeichert.');
      }
    } catch (cause) { if (live.current.mounted && live.current.workspaceEpoch === epoch) setError(cause instanceof Error ? cause.message : 'Die Vorschau konnte nicht gespeichert werden.'); }
    finally { if (live.current.mounted) setSaving(false); }
  }
  async function retrySave() {
    const epoch = workspaceEpoch;
    setSaving(true); setError('');
    try {
      if (!source || source.epoch !== epoch) throw new Error('Der Arbeitsbereich wurde neu geladen. Der alte Speicherversuch ist gesperrt.');
      if (!await planner.retry()) throw new Error('Speichern weiterhin fehlgeschlagen. Der Entwurf und die Antwort bleiben erhalten.');
      if (live.current.mounted && live.current.workspaceEpoch === epoch) {
        setPendingSave(false); setSource(null); setPrompt(''); setResponse(''); setAccepted(noAcceptance()); setConfirmed(false); setStatus('Die geprüften Änderungen wurden gespeichert.');
      }
    } catch (cause) { if (live.current.mounted) setError(cause instanceof Error ? cause.message : 'Speichern fehlgeschlagen.'); }
    finally { if (live.current.mounted) setSaving(false); }
  }

  const content = <>
      <header className="dialog-header ai-header">
        <div><p className="eyebrow"><Sparkles size={14} aria-hidden="true" /> PLANUNG / KI</p><h2 id={`${id}-title`}>KI für deine Planung</h2></div>
        <button className="secondary-button ai-close" type="button" aria-label="Planungsassistent schließen" disabled={saving} onClick={onClose} autoFocus><ArrowLeft size={18} aria-hidden="true" /><span>Zurück</span></button>
      </header>
      <div className="dialog-body ai-body">
        <div className="info-box ai-mode" id={`${id}-mode`}>
          <strong>{connection?.configured ? 'OpenAI konfiguriert · manueller Webmodus ebenfalls verfügbar' : 'Manueller Webmodus'}</strong>
          <p>{checking ? 'Backend-Konfiguration wird geprüft. Es werden keine Inhalte gesendet.' : connection?.configured ? `${connection.textModel} · Verbindung noch nicht geprüft. Nur „An OpenAI senden“ überträgt den sichtbaren Prompt.` : connectionError || 'Prompt kopieren, selbst in ChatGPT senden und die Antwort hier einfügen. Direkte KI-Anfragen sind noch nicht eingerichtet.'}</p>
          <button type="button" className="secondary-button" disabled={checking || sending} onClick={() => void checkConnection()}>Konfiguration erneut prüfen</button>
        </div>
        {planner.loadError && <p className="ai-warning" role="alert">Die Planung konnte nicht geladen werden: {planner.loadError}. Eine Übernahme ist gesperrt.</p>}
        <section className="ai-section ai-source-section" aria-labelledby={`${id}-context`}>
          <h3 id={`${id}-context`}>Freigegebener Kontext</h3>
          <p className="planning-ai-context-summary">{selection.taskIds.length} Aufgaben · {selection.noteIds.length} Notizen · {selection.appointmentIds.length} Termine ausgewählt</p>
          <fieldset className="planning-ai-controls" disabled={frozen}>
            <legend className="ai-visually-hidden">Planungsauftrag</legend>
            <label className="field" htmlFor={`${id}-action`}><span>Was möchtest du tun?</span><select id={`${id}-action`} value={action} onChange={(event) => { invalidate(); setAction(event.target.value as PlanningAIAction); }}>{PLANNING_AI_ACTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
            <label className="field" htmlFor={`${id}-date`}><span>{action === 'week' || action === 'review-week' ? 'Zielwoche · Datum innerhalb der Woche' : 'Zieltag'}</span><input id={`${id}-date`} type="date" value={date} onChange={(event) => { invalidate(); setDate(event.target.value); }} /></label>
            <p className="ai-help">{planner.data.settings.timeZone} · Planung ändert keine bestehenden Fälligkeiten.</p>
            <label className="field" htmlFor={`${id}-filter`}><span>Kontextauswahl durchsuchen</span><input id={`${id}-filter`} value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Titel oder Text suchen" /></label>
            <div className="planning-ai-selections">
              <fieldset><legend>Aufgaben ({selection.taskIds.length} gewählt)</legend><div className="planning-ai-options">{planner.data.tasks.filter((task) => matches(`${task.title} ${task.description}`)).map((task) => <label key={task.id}><input type="checkbox" checked={selection.taskIds.includes(task.id)} onChange={() => toggleSelection('taskIds', task.id)} /><span>{task.title}<small>{task.status === 'done' ? 'Erledigt' : 'Offen'} · Fällig: {task.dueDate ?? 'ohne Frist'}</small></span></label>)}{!planner.data.tasks.length && <p>Keine Aufgaben vorhanden.</p>}</div></fieldset>
              <fieldset><legend>Notizen ({selection.noteIds.length} gewählt)</legend><div className="planning-ai-options">{activeNotes.filter((note) => matches(`${note.title} ${note.content}`)).map((note) => <label key={note.id}><input type="checkbox" checked={selection.noteIds.includes(note.id)} onChange={() => toggleSelection('noteIds', note.id)} /><span>{note.title || 'Ohne Titel'}<small>Gesamter Text und Tags dieser Notiz</small></span></label>)}{!activeNotes.length && <p>Keine aktiven Notizen vorhanden.</p>}</div></fieldset>
              <fieldset><legend>Termine ({selection.appointmentIds.length} gewählt)</legend><div className="planning-ai-options">{planner.data.appointments.filter((item) => matches(`${item.title} ${item.description}`)).map((item) => <label key={item.id}><input type="checkbox" checked={selection.appointmentIds.includes(item.id)} onChange={() => toggleSelection('appointmentIds', item.id)} /><span>{item.title}<small>{item.allDay ? `Ganztägig: ${item.allDay.startDate} bis ${item.allDay.endDate} (Ende exklusiv)` : `${new Date(item.startAt).toLocaleString('de', { timeZone: planner.data.settings.timeZone })} · ${item.durationMinutes} Min.`}</small></span></label>)}{!planner.data.appointments.length && <p>Keine Termine vorhanden.</p>}</div></fieldset>
            </div>
            <p className="ai-help">Freigegeben wird nur deine Auswahl samt zugehörigen Zeitblöcken und Tagesbudget. Anfangs ist nichts ausgewählt. Die KI sieht keine anderen Termine; die lokale Konfliktprüfung berücksichtigt alle.</p>
            <button type="button" className="secondary-button" disabled={planner.loading || Boolean(planner.loadError)} onClick={chooseSource}>Auswahl als Kontext freigeben</button>
          </fieldset>
          {source && <div className="planning-ai-budget"><strong>Verfügbarkeit im freigegebenen Kontext</strong><ul>{source.context.availability.map((item) => <li key={item.date}>{item.date}: {item.availableMinutes} Minuten</li>)}</ul><p>Budget vor Belegung. Zeitfenster und Puffer stehen im Prompt; nur ausgewählte Termine werden mitgegeben.</p></div>}
          {stale && !pendingSave && <p className="ai-warning" role="alert">Der Arbeitsbereich hat sich seit der Freigabe geändert. Erneuere den Kontext und prüfe die Vorschau erneut. Senden und Übernahme sind gesperrt.</p>}
        </section>
        <section className="ai-section ai-prompt-section" aria-labelledby={`${id}-prompt-heading`}>
          <h3 id={`${id}-prompt-heading`}>Prompt</h3>
          <label className="field" htmlFor={`${id}-prompt`}><span>Vollständiger Prompt · bearbeitbar</span><textarea ref={promptRef} id={`${id}-prompt`} rows={10} className="ai-prompt" disabled={!source || frozen} value={prompt} spellCheck={false} placeholder="Gib zuerst den gewünschten Kontext ausdrücklich frei." onChange={(event) => { requestRef.current?.abort(); requestGeneration.current++; setSending(false); setPrompt(event.target.value); setConfirmed(false); }} /></label>
          <p className="ai-help">„Prompt kopieren“ nutzt die Zwischenablage. „ChatGPT öffnen“ öffnet nur chatgpt.com ohne Inhalte. Erst dein Senden dort oder „An OpenAI senden“ gibt den vollständigen sichtbaren Prompt weiter.</p>
          <div className="ai-actions"><button type="button" className="secondary-button" disabled={!source || !prompt.trim() || stale} onClick={() => void copyPrompt()}><Copy size={16} aria-hidden="true" /> Prompt kopieren</button><a className="secondary-button ai-chat-link" href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer">ChatGPT öffnen <ArrowUpRight size={16} aria-hidden="true" /></a></div>
          {connection?.configured && <div className="planning-ai-consent">{!consentReady ? <><p className="ai-help">Bei direkter Nutzung werden der sichtbare Prompt und ausgewählte Texte an OpenAI übertragen. Das kann API-Kosten verursachen. Die Zustimmung wird in deinen lokalen Einstellungen gespeichert; das Senden wird erst nach erfolgreichem Speichern freigegeben.</p><button type="button" className="secondary-button" disabled={frozen} onClick={() => void giveConsent()}>Direkter KI-Nutzung zustimmen</button></> : <p className="ai-help">Zustimmung zur direkten KI-Nutzung ist gespeichert. Für diese Anfrage wird nur der oben sichtbare Prompt gesendet.</p>}<button type="button" className="primary-button" disabled={!source || stale || !prompt.trim() || !consentReady || sending || frozen} onClick={() => void sendPrompt()}>{sending ? 'Anfrage läuft …' : 'An OpenAI senden'}</button>{sending && <button type="button" className="secondary-button" onClick={() => { requestRef.current?.abort(); requestGeneration.current++; setSending(false); setStatus('Anfrage abgebrochen. Die Vorschau bleibt erhalten.'); }}>Anfrage abbrechen</button>}</div>}
        </section>
        <section className="ai-section ai-result-section" aria-labelledby={`${id}-response-heading`}>
          <h3 id={`${id}-response-heading`}>Antwortvorschau</h3>
          <label className="field" htmlFor={`${id}-response`}><span>KI-Antwort · bearbeitbares JSON{action.startsWith('review-') ? ' oder Rückblick als Text' : ''}</span><textarea id={`${id}-response`} rows={10} className="ai-result" disabled={!source || frozen} value={response} spellCheck={false} placeholder="Antwort hier manuell einfügen …" onChange={(event) => editResponse(event.target.value)} /></label>
          <details className="ai-source-preview"><summary>Erwartetes JSON-Format ansehen</summary><pre>{PLAN_RESPONSE_EXAMPLE}</pre></details>
          {parsed.error && <p className="ai-warning" role="alert">{parsed.error}</p>}
          {parsed.proposal && <div className="planning-ai-preview">
            <h4>Geprüfte Vorschläge · zunächst nichts ausgewählt</h4>
            {parsed.proposal.assignments.map((row) => {
              const task = source!.context.tasks.find((item) => item.id === row.taskId)!;
              const blockCount = planner.data.timeBlocks.filter((block) => block.taskId === row.taskId).length;
              return <label className="ai-confirm" key={row.taskId}><input type="checkbox" checked={accepted.taskIds.includes(row.taskId)} disabled={frozen || stale} onChange={(event) => accept({ ...accepted, taskIds: event.target.checked ? [...accepted.taskIds, row.taskId] : accepted.taskIds.filter((item) => item !== row.taskId) })} /><span><strong>{task.title}</strong><small>Planung: {row.date}{row.startTime ? `, ${row.startTime} · ${row.durationMinutes} Min.` : ' · ohne Uhrzeit'}<br />Fälligkeit unverändert: {task.dueDate ?? 'keine'}{blockCount > 0 && <><br />{blockCount} bisherige Zeitblöcke werden {row.startTime ? 'durch den ausdrücklich vorgeschlagenen neuen Block ersetzt' : 'mitverschoben (lokale Uhrzeit und Dauer bleiben erhalten)' }.</>}</small></span></label>;
            })}
            {parsed.proposal.newTasks.map((row, index) => <label className="ai-confirm" key={index}><input type="checkbox" checked={accepted.newTaskIndexes.includes(index)} disabled={frozen || stale} onChange={(event) => accept({ ...accepted, newTaskIndexes: event.target.checked ? [...accepted.newTaskIndexes, index] : accepted.newTaskIndexes.filter((item) => item !== index) })} /><span><strong>Neue Aufgabe: {row.title}</strong><small>{row.description || 'Keine Beschreibung'}<br />Planung: {row.plannedDate ?? 'Eingang'}{row.startTime ? `, ${row.startTime} · ${row.durationMinutes} Min.` : ''}<br />Neue Fälligkeit: {row.dueDate ?? 'keine'} · Schätzung: {row.estimatedMinutes === null ? 'keine' : `${row.estimatedMinutes} Min.`} · Priorität: {row.priority ?? 'keine'}<br />Verknüpfte Notizen: {row.noteIds.map((noteId) => source!.context.notes.find((note) => note.id === noteId)?.title || 'Ohne Titel').join(', ')}</small></span></label>)}
            {parsed.proposal.review.trim() && <label className="ai-confirm"><input type="checkbox" checked={accepted.review} disabled={frozen || stale} onChange={(event) => accept({ ...accepted, review: event.target.checked })} /><span><strong>Rückblick für {source!.date} ersetzen{source!.action === 'week' || source!.action === 'review-week' ? ' (Woche)' : ' (Tag)'}</strong><small className="planning-ai-review">{parsed.proposal.review}</small></span></label>}
            {!parsed.proposal.assignments.length && !parsed.proposal.newTasks.length && !parsed.proposal.review.trim() && <p className="ai-help">Die Antwort enthält keine übernehmbaren Änderungen.</p>}
            <div className="planning-ai-assumptions"><strong>Annahmen und Grenzen</strong><ul><li>Nicht ausgewählte Inhalte wurden der KI nicht mitgegeben. Fehlende Aufgabendauern zählen lokal mit 0 Minuten; prüfe die Schätzungen.</li>{parsed.proposal.assumptions.map((item, index) => <li key={index}>{item}</li>)}</ul></div>
            {(parsed.proposal.conflicts.length > 0 || warnings.length > 0) && <div className="ai-warning"><strong>Konflikte und Hinweise zur ausgewählten Übernahme</strong><ul>{[...parsed.proposal.conflicts, ...warnings].map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
            <label className="ai-confirm"><input type="checkbox" checked={confirmed} disabled={!hasAccepted || stale || frozen} onChange={(event) => setConfirmed(event.target.checked)} /><span>Ich habe die ausgewählten Änderungen, Annahmen und Konflikte geprüft und bestätige die Übernahme. Bestehende Fälligkeiten bleiben unverändert.</span></label>
          </div>}
        </section>
        <p className="ai-status" role="status" aria-live="polite">{status}</p>
        {error && <p className="ai-warning" role="alert">{error}</p>}
        {pendingSave && <div className="ai-warning"><p>Der bestätigte Entwurf liegt im Speicher. Ein erneuter Speicherversuch schreibt genau diesen Entwurf und erzeugt keine weiteren Aufgaben. Deine Antwort bleibt oben kopierbar.</p><button type="button" className="secondary-button" disabled={saving || source?.epoch !== workspaceEpoch} onClick={() => void retrySave()}>Speichern erneut versuchen</button></div>}
      </div>
      <footer className="dialog-footer ai-footer"><button type="button" className="secondary-button" disabled={saving} onClick={onClose}>Schließen</button><button type="button" className="primary-button" disabled={!canApply || sending} onClick={() => void applyProposal()}><Check size={17} aria-hidden="true" /> {saving ? 'Wird gespeichert …' : 'Ausgewählte Vorschläge übernehmen'}</button></footer>
    </>;
  return embedded
    ? <section className="planning-ai-page ai-atelier ai-horizon" aria-labelledby={`${id}-title`}>{content}</section>
    : <dialog ref={dialogRef} className="dialog ai-dialog ai-sidepanel planning-ai-dialog ai-atelier ai-horizon" aria-labelledby={`${id}-title`} aria-describedby={`${id}-mode`} onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}>{content}</dialog>;
}
