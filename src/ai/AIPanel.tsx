import { useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Check, Copy, Sparkles } from 'lucide-react';
import type { Note, Selection } from '../types';
import { BACKUP_LIMITS } from '../data/backup';
import { AI_ACTIONS, buildPrompt, captureSource, isSourceCurrent, isValidSelection, parseTags } from './prompts';
import type { AIAction, AIScope, SourceSnapshot } from './prompts';
import { api } from '../services/ai';
import { useAIConnection } from './useAIConnection';
import './AIPanel.css';

interface AIPanelProps {
  note: Note;
  selection: Selection | null;
  onClose: () => void;
  onApply: (content: string, selection?: Selection, metadata?: { title: string; tags: string[] }) => void;
  consent?: boolean;
  onConsent?: () => void;
  workspaceEpoch?: number;
}

export function AIPanel({ note, selection, onClose, onApply, consent = false, onConsent, workspaceEpoch = 0 }: AIPanelProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const prefix = useId();
  const [step, setStep] = useState(0);
  const [scope, setScope] = useState<AIScope | null>(null);
  const [source, setSource] = useState<SourceSnapshot | null>(null);
  const [action, setAction] = useState<AIAction>('summarize');
  const [prompt, setPrompt] = useState('');
  const [result, setResult] = useState('');
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [applying, setApplying] = useState(false);
  const [sending, setSending] = useState(false);
  const sourceEpoch = useRef(workspaceEpoch);
  const current = useRef({ note, workspaceEpoch, mounted: true });
  current.current = { note, workspaceEpoch, mounted: current.current.mounted };
  const requestRef = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const { connection, connectionError, checking, checkConnection } = useAIConnection();
  const hasSelection = isValidSelection(note, selection);
  const stale = source !== null && (sourceEpoch.current !== workspaceEpoch || !isSourceCurrent(source, note));
  const metadata = action === 'metadata';
  const parsedTags = parseTags(tags);
  const resultingLength = source?.scope === 'selection'
    ? source.content.length - (source.selection?.text.length ?? 0) + result.length
    : result.length;
  const validationError = metadata
    ? title.trim().length > BACKUP_LIMITS.title
      ? `Der Titel darf höchstens ${BACKUP_LIMITS.title} Zeichen enthalten.`
      : parsedTags.length > BACKUP_LIMITS.tags
        ? `Es sind höchstens ${BACKUP_LIMITS.tags} Tags möglich.`
        : parsedTags.some((tag) => tag.length > BACKUP_LIMITS.tag)
          ? `Ein Tag darf höchstens ${BACKUP_LIMITS.tag} Zeichen enthalten.`
          : ''
    : resultingLength > BACKUP_LIMITS.content
      ? `Der resultierende Notiztext darf höchstens ${BACKUP_LIMITS.content.toLocaleString('de')} Zeichen enthalten. Kürze die Vorschau vor der Übernahme.`
      : '';
  const hasResult = metadata ? title.trim().length > 0 : result.trim().length > 0;
  const canApply = source !== null && !stale && !note.deletedAt && hasResult && !validationError && confirmed && !applying && !sending;

  useEffect(() => {
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    current.current.mounted = true;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      current.current.mounted = false;
      requestRef.current?.abort();
      if (dialog?.open) dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => { cancelRequest(); setConfirmed(false); }, [workspaceEpoch]);
  useEffect(() => { stepHeadingRef.current?.focus(); }, [step]);

  function cancelRequest() {
    requestRef.current?.abort();
    generation.current++;
    setSending(false);
  }

  function chooseSource(scope: AIScope) {
    cancelRequest();
    const nextSource = captureSource(note, scope, selection);
    if (!nextSource) {
      setError('Diese Textmarkierung ist nicht mehr gültig. Markiere den gewünschten Text erneut im Editor.');
      return;
    }
    setSource(nextSource);
    setScope(scope);
    sourceEpoch.current = workspaceEpoch;
    setPrompt(buildPrompt(action, nextSource));
    setConfirmed(false);
    setError('');
    setStep(2);
    setStatus(result || title || tags
      ? 'Quelle und Prompt wurden erneuert. Deine Vorschau bleibt erhalten; prüfe sie erneut gegen die neue Quelle.'
      : 'Quelle ausgewählt. Du kannst den vollständigen Prompt jetzt prüfen und bearbeiten.');
  }

  function changeAction(nextAction: AIAction) {
    cancelRequest();
    setAction(nextAction);
    setSource(null);
    setConfirmed(false);
    setError('');
    setStatus('Ziel geändert. Gib die gewünschten Inhalte im nächsten Schritt erneut frei. Deine Antwort bleibt als Entwurf erhalten.');
  }

  async function sendPrompt() {
    if (!source || stale || !prompt.trim() || !consent || !connection?.configured || sending) return;
    cancelRequest();
    const request = new AbortController();
    requestRef.current = request;
    const requestGeneration = ++generation.current;
    const epoch = workspaceEpoch;
    const requestSource = source;
    setSending(true); setConfirmed(false); setError(''); setStatus('Der sichtbare Prompt wird an OpenAI gesendet …');
    try {
      const answer = await api.assist(prompt, `note-${action}`, crypto.randomUUID(), request.signal);
      if (request.signal.aborted || !current.current.mounted || generation.current !== requestGeneration) return;
      if (current.current.workspaceEpoch !== epoch || !isSourceCurrent(requestSource, current.current.note)) throw new Error('Die Quelle hat sich während der Anfrage geändert. Wähle den aktuellen Stand erneut als Quelle.');
      if (typeof answer.text !== 'string' || !answer.text.trim() || answer.text.length > BACKUP_LIMITS.content) throw new Error('Die KI-Antwort ist leer oder zu lang.');
      setResult(answer.text);
      setStep(3);
      if (action === 'metadata') {
        const suggestedTitle = answer.text.match(/(?:^|\n)Titel:\s*(.+)/i)?.[1]?.trim();
        const suggestedTags = answer.text.match(/(?:^|\n)Tags:\s*([^\n]*)/i)?.[1];
        if (suggestedTitle === undefined || suggestedTags === undefined) throw new Error('Prüfe die empfangene Antwort unten und trage Titel und Tags selbst in die Felder ein.');
        setTitle(suggestedTitle); setTags(suggestedTags);
      }
      setStatus('Antwort empfangen. Prüfe und bearbeite die Vorschau vor deiner ausdrücklichen Bestätigung.');
    } catch (cause) {
      if (!request.signal.aborted && current.current.mounted) setError(cause instanceof Error ? cause.message : 'Die Anfrage ist fehlgeschlagen. Der manuelle Webmodus bleibt verfügbar.');
    } finally {
      if (!request.signal.aborted && current.current.mounted && generation.current === requestGeneration) setSending(false);
    }
  }

  async function copyPrompt() {
    if (!source || !prompt.trim()) return;
    setError('');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard-unavailable');
      await navigator.clipboard.writeText(prompt);
      setStatus('Vollständiger Prompt in die Zwischenablage kopiert. Füge ihn in ChatGPT ein und sende ihn dort selbst ab.');
    } catch {
      promptRef.current?.focus();
      promptRef.current?.select();
      setError('Kopieren war nicht möglich. Der Prompt ist markiert; kopiere ihn mit Strg+C, ⌘C oder dem Kopiermenü deines Geräts.');
    }
  }

  function applyResult() {
    if (!source || sourceEpoch.current !== workspaceEpoch || !isSourceCurrent(source, note)) {
      setError('Die Notiz hat sich geändert. Wähle die aktuelle Quelle erneut und prüfe deine Vorschau.');
      setConfirmed(false);
      return;
    }
    if (!canApply) return;
    setApplying(true);
    setError('');
    try {
      if (metadata) {
        onApply(source.content, undefined, { title: title.trim(), tags: parsedTags });
      } else {
        onApply(result, source.scope === 'selection' ? source.selection : undefined);
      }
    } catch (cause) {
      setApplying(false);
      setError(cause instanceof Error
        ? `Der Vorschlag konnte nicht übernommen werden: ${cause.message} Deine Vorschau bleibt erhalten.`
        : 'Der Vorschlag konnte nicht übernommen werden. Deine Vorschau bleibt erhalten. Versuche es erneut.');
      return;
    }
    onClose();
  }

  return (
    <dialog
      ref={dialogRef}
      className="dialog ai-dialog ai-sidepanel ai-atelier ai-horizon note-ai-horizon ai-guided"
      aria-labelledby={`${prefix}-heading`}
      aria-describedby={`${prefix}-description`}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
    >
      <header className="dialog-header ai-header">
        <div>
          <p className="eyebrow"><Sparkles size={14} aria-hidden="true" /> NOTIZEN / SCHREIBRAUM</p>
          <h2 id={`${prefix}-heading`}>KI-Assistent</h2>
        </div>
        <button type="button" className="secondary-button ai-close" aria-label="KI-Assistent schließen" onClick={onClose} autoFocus>
          <ArrowLeft size={18} aria-hidden="true" /><span>Zurück</span>
        </button>
      </header>

      <div className="dialog-body ai-body">
        <div className="info-box ai-mode" id={`${prefix}-description`}>
          <strong>{connection?.configured ? 'OpenAI konfiguriert · manueller Webmodus verfügbar' : 'Manueller Webmodus'}</strong>
          <details className="ai-connection-details"><summary>Verbindung und Datenschutz</summary><p>{checking ? 'Backend-Konfiguration wird geprüft. Es werden keine Notizinhalte gesendet.' : connection?.configured ? `${connection.textModel} · Verbindung noch nicht geprüft. Nur „An OpenAI senden“ überträgt den sichtbaren Prompt.` : connectionError || 'Prompt kopieren, selbst in ChatGPT senden und die Antwort hier einfügen. Keine direkte KI-Verbindung eingerichtet.'}</p><button type="button" className="secondary-button" disabled={checking || sending} onClick={() => void checkConnection()}>Konfiguration erneut prüfen</button></details>
        </div>
        <nav className="ai-steps" aria-label="Schritte im KI-Assistenten">
          {['Ziel', 'Inhalte', 'Prompt', 'Vorschau'].map((label, index) => <button key={label} type="button" aria-current={step === index ? 'step' : undefined} disabled={applying || (index > 1 && !source)} onClick={() => setStep(index)}><span aria-hidden="true">{index + 1}</span>{label}</button>)}
        </nav>
        {step === 0 && <section className="ai-section ai-goal-section" aria-labelledby={`${prefix}-goal-heading`}>
          <h3 ref={stepHeadingRef} tabIndex={-1} id={`${prefix}-goal-heading`}>1 · Was möchtest du erreichen?</h3>
          <p className="ai-help">Wähle ein Ziel für „{note.title.trim() || 'Ohne Titel'}“. Danach bestimmst du, welche Inhalte in den Prompt kommen.</p>
          <label className="field" htmlFor={`${prefix}-action`}><span>Was möchtest du tun?</span><select id={`${prefix}-action`} value={action} onChange={(event) => changeAction(event.target.value as AIAction)}>{AI_ACTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
          <p className="ai-help">{AI_ACTIONS.find((item) => item.value === action)?.instruction}</p>
        </section>}
        {step === 1 && <section className="ai-section ai-source-section" aria-labelledby={`${prefix}-source-heading`}>
          <h3 ref={stepHeadingRef} tabIndex={-1} id={`${prefix}-source-heading`}>2 · Inhalte auswählen und freigeben</h3>
          <p className="ai-source-title">{note.title.trim() || 'Ohne Titel'}</p>
          <fieldset className="ai-source-options" disabled={Boolean(note.deletedAt)}>
            <legend className="ai-visually-hidden">Quelle für den Prompt</legend>
            <label className={`ai-source-option${scope === 'note' ? ' is-selected' : ''}`}>
              <input type="radio" name={`${prefix}-scope`} checked={scope === 'note'} onChange={() => { cancelRequest(); setScope('note'); setSource(null); setConfirmed(false); }} />
              <span><strong>Ganze Notiz</strong><small>Titel, Text und Tags dieser Notiz</small></span>
            </label>
            <label className={`ai-source-option${scope === 'selection' ? ' is-selected' : ''}`}>
              <input type="radio" name={`${prefix}-scope`} checked={scope === 'selection'} disabled={!hasSelection} onChange={() => { cancelRequest(); setScope('selection'); setSource(null); setConfirmed(false); }} />
              <span><strong>Textmarkierung</strong><small>{hasSelection ? `${selection.text.length.toLocaleString('de')} markierte Zeichen · nur dieser Text` : 'Zuerst Text im Editor markieren'}</small></span>
            </label>
          </fieldset>
          {note.deletedAt && <p className="ai-warning" role="alert">Stelle diese Notiz aus dem Papierkorb wieder her, bevor du KI-Vorschläge übernimmst.</p>}
          {scope && (
            <details className="ai-source-preview">
              <summary>Ausgewählten Inhalt prüfen</summary>
              <pre>{scope === 'selection' ? selection?.text : `Titel: ${note.title || '(ohne Titel)'}\nTags: ${note.tags.join(', ') || '(keine)'}\n\n${note.content}`}</pre>
            </details>
          )}
          <p className="ai-help">Die Freigabe erstellt den Prompt lokal. Inhalte werden erst durch dein Kopieren und Senden oder „An OpenAI senden“ weitergegeben.</p>
        </section>}

        {step === 2 && <section className="ai-section ai-prompt-section" aria-labelledby={`${prefix}-prompt-heading`}>
          <h3 ref={stepHeadingRef} tabIndex={-1} id={`${prefix}-prompt-heading`}>3 · Prompt prüfen und verwenden</h3>
          <p className="ai-context-released">Lokal freigegeben: {source?.scope === 'selection' ? 'Textmarkierung' : 'ganze Notiz'} · {AI_ACTIONS.find((item) => item.value === action)?.label}</p>
          <label className="field" htmlFor={`${prefix}-prompt`}>
            <span>Vollständiger Prompt · bearbeitbar</span>
            <textarea ref={promptRef} id={`${prefix}-prompt`} className="ai-prompt" value={prompt} disabled={!source} placeholder="Wähle zuerst ausdrücklich die ganze Notiz oder eine Textmarkierung aus." rows={9} onChange={(event) => { cancelRequest(); setPrompt(event.target.value); setConfirmed(false); }} spellCheck={false} aria-describedby={`${prefix}-privacy`} />
          </label>
          <p className="ai-help" id={`${prefix}-privacy`}>„Prompt kopieren“ nutzt die Zwischenablage. „ChatGPT öffnen“ überträgt keine Inhalte. Erst dein Einfügen und Senden dort teilt den oben sichtbaren Prompt mit ChatGPT.</p>
          <div className="ai-actions">
            <button type="button" className="secondary-button" disabled={!source || stale || !prompt.trim()} onClick={() => void copyPrompt()}><Copy size={16} aria-hidden="true" /> Prompt kopieren</button>
            <a className="secondary-button ai-chat-link" href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer" aria-label="ChatGPT in neuem Tab öffnen">ChatGPT öffnen <ArrowUpRight size={16} aria-hidden="true" /></a>
          </div>
          {connection?.configured && <div className="ai-api-controls">
            <p className="ai-help">„An OpenAI senden“ überträgt den sichtbaren Prompt und kann API-Kosten verursachen.</p>
            {!consent && (onConsent ? <button type="button" className="secondary-button" onClick={onConsent}>Direkter KI-Nutzung zustimmen</button> : <p className="ai-help">Für die direkte Nutzung ist zuerst deine Zustimmung in der Planung oder den Einstellungen erforderlich.</p>)}
            <button type="button" className="primary-button" disabled={!source || stale || !prompt.trim() || !consent || sending || Boolean(note.deletedAt)} onClick={() => void sendPrompt()}>{sending ? 'Anfrage läuft …' : 'An OpenAI senden'}</button>
            {sending && <button type="button" className="secondary-button" onClick={() => { cancelRequest(); setStatus('Anfrage abgebrochen. Deine Vorschau bleibt erhalten.'); }}>Anfrage abbrechen</button>}
          </div>}
        </section>}

        {step === 3 && <section className="ai-section ai-result-section" aria-labelledby={`${prefix}-result-heading`}>
          <h3 ref={stepHeadingRef} tabIndex={-1} id={`${prefix}-result-heading`}>4 · Antwortvorschau prüfen</h3>
          {metadata ? (
            <div className="ai-metadata-fields">
              {result && <details className="ai-source-preview"><summary>Empfangene Antwort prüfen</summary><pre>{result}</pre></details>}
              <p className="ai-help">Vorschläge hier einfügen. Übernommen werden nur Titel und Tags; der Notiztext bleibt erhalten.</p>
              <label className="field" htmlFor={`${prefix}-title`}><span>Vorgeschlagener Titel</span><input id={`${prefix}-title`} value={title} disabled={!source} placeholder="Titel aus ChatGPT einfügen" onChange={(event) => { cancelRequest(); setTitle(event.target.value); setConfirmed(false); }} /></label>
              <label className="field" htmlFor={`${prefix}-tags`}><span>Vorgeschlagene Tags · mit Komma trennen</span><textarea id={`${prefix}-tags`} rows={2} value={tags} disabled={!source} placeholder="z. B. Ideen, Projekt, Recherche" onChange={(event) => { cancelRequest(); setTags(event.target.value); setConfirmed(false); }} /></label>
              <p className="ai-help">Ein leeres Tag-Feld entfernt vorhandene Tags. Doppelte Tags werden zusammengefasst.</p>
            </div>
          ) : (
            <label className="field" htmlFor={`${prefix}-result`}>
              <span>Antwort aus ChatGPT · bearbeitbare Vorschau</span>
              <textarea id={`${prefix}-result`} className="ai-result" rows={7} value={result} disabled={!source} placeholder="Antwort manuell einfügen und bei Bedarf bearbeiten …" onChange={(event) => { cancelRequest(); setResult(event.target.value); setConfirmed(false); }} />
            </label>
          )}
          <p className="ai-help">{metadata ? 'Nach deiner Bestätigung werden Titel und Tags ersetzt.' : source?.scope === 'selection' ? 'Nach deiner Bestätigung wird ausschließlich die gewählte Textmarkierung ersetzt.' : 'Nach deiner Bestätigung wird der gesamte Notiztext ersetzt; Titel und Tags bleiben erhalten.'} Den ursprünglichen Stand kannst du danach über „Versionsverlauf“ im Editor wiederherstellen.</p>
          {validationError && <p className="ai-warning" role="alert">{validationError}</p>}
          <label className="ai-confirm">
            <input type="checkbox" checked={confirmed} disabled={!source || stale || !hasResult || Boolean(validationError) || Boolean(note.deletedAt)} onChange={(event) => setConfirmed(event.target.checked)} />
            <span>Ich habe die Vorschau geprüft und bestätige die Übernahme.</span>
          </label>
        </section>}

        {stale && <div className="ai-warning" role="alert"><p>Die Notiz wurde seit der Freigabe geändert. Senden und Übernahme sind gesperrt. Deine Antwort bleibt erhalten.</p><button type="button" className="secondary-button" disabled={Boolean(note.deletedAt)} onClick={() => setStep(1)}>Inhalte erneut freigeben</button></div>}
        <p className="ai-status" role="status" aria-live="polite">{status}</p>
        {error && <p className="ai-warning" role="alert">{error}</p>}
      </div>

      <footer className="dialog-footer ai-footer">
        <button type="button" className="secondary-button" onClick={() => step > 0 ? setStep(step - 1) : onClose()}>{step > 0 ? 'Vorheriger Schritt' : 'Schließen'}</button>
        {step === 0 && <button type="button" className="primary-button" onClick={() => setStep(1)}>Weiter: Inhalte auswählen</button>}
        {step === 1 && <button type="button" className="primary-button" disabled={!scope || Boolean(note.deletedAt) || (scope === 'selection' && !hasSelection)} onClick={() => scope && chooseSource(scope)}>Inhalte freigeben und Prompt ansehen</button>}
        {step === 2 && <button type="button" className="primary-button" disabled={!source || sending} onClick={() => setStep(3)}>{hasResult ? 'Weiter: Vorschau prüfen' : 'Antwort manuell einfügen'}</button>}
        {step === 3 && <button type="button" className="primary-button" disabled={!canApply} onClick={applyResult}><Check size={17} aria-hidden="true" /> {metadata ? 'Titel und Tags übernehmen' : 'Vorschau übernehmen'}</button>}
      </footer>
    </dialog>
  );
}
