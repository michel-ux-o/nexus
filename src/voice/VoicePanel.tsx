import { useEffect, useId, useRef, useState } from 'react';
import { Check, Mic, RotateCcw, Square, X } from 'lucide-react';
import type { CaptureContext, CaptureItem, Planner, Task } from '../planning/types';
import { formatDate } from '../planning/dates';
import { api } from '../services/ai';
import { CaptureItemEditor, captureIssues } from './CaptureItemEditor';
import './VoicePanel.css';

interface VoicePanelProps {
  planner: Planner;
  onClose: () => void;
  onEditTask: (task: Task) => void;
  workspaceEpoch: number;
}

interface BackendStatus { configured: boolean; transcriptionModel: string; textModel: string }
interface CaptureRun { context: CaptureContext; epoch: number }
interface CaptureRow { item: CaptureItem; issues: string[]; additionalReview: boolean; alreadySaved: boolean; discarded: boolean }
type Stage = 'idle' | 'permission' | 'recording' | 'transcribing' | 'interpreting' | 'saving' | 'ready' | 'error';
type Failure = 'transcribe' | 'interpret' | 'commit' | null;

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_RECORDING_SECONDS = 300;
const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

function sourceKey(source: string): string {
  return source.trim().replace(/\s+/g, ' ').toLocaleLowerCase('de');
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Ein unerwarteter Fehler ist aufgetreten.';
}

function microphoneError(cause: unknown): string {
  if (cause instanceof Error) {
    if (cause.name === 'NotAllowedError' || cause.name === 'SecurityError') return 'Der Mikrofonzugriff wurde nicht erlaubt. Erlaube ihn in den Website-Einstellungen deines Browsers und starte die Aufnahme erneut.';
    if (cause.name === 'NotFoundError') return 'Es wurde kein Mikrofon gefunden. Verbinde ein Mikrofon und versuche es erneut.';
    if (cause.name === 'NotReadableError') return 'Das Mikrofon ist gerade nicht verfügbar. Prüfe, ob eine andere Anwendung es verwendet.';
  }
  return `Die Aufnahme konnte nicht gestartet werden: ${messageOf(cause)}`;
}

function elapsedLabel(seconds: number): string {
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

export function VoicePanel({ planner, onClose, onEditTask, workspaceEpoch }: VoicePanelProps) {
  const prefix = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const transcriptRef = useRef<HTMLTextAreaElement>(null);
  const plannerRef = useRef(planner);
  plannerRef.current = planner;
  const epochRef = useRef(workspaceEpoch);
  epochRef.current = workspaceEpoch;
  const originalEpochRef = useRef(workspaceEpoch);
  const mountedRef = useRef(true);
  const runRef = useRef<CaptureRun | null>(null);
  const actionTokenRef = useRef(0);
  const processingRef = useRef(false);
  const controllersRef = useRef(new Set<AbortController>());
  const statusControllerRef = useRef<AbortController | null>(null);
  const statusTokenRef = useRef(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const chunkBytesRef = useRef(0);
  const audioRef = useRef<Blob | null>(null);
  const recordingStartedRef = useRef(0);
  const interpretedTextRef = useRef('');
  const reviewAdditionalRef = useRef(false);
  const committedItemsRef = useRef(new Map<string, CaptureItem>());
  const failedItemsRef = useRef<CaptureItem[]>([]);
  const [backend, setBackend] = useState<BackendStatus | null>(null);
  const [checkingStatus, setCheckingStatus] = useState(true);
  const [statusError, setStatusError] = useState('');
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  const [stage, setStage] = useState<Stage>('idle');
  const [failure, setFailure] = useState<Failure>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [run, setRun] = useState<CaptureRun | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [transcript, setTranscript] = useState('');
  const [rows, setRows] = useState<CaptureRow[]>([]);
  const [generation, setGeneration] = useState(0);
  const [confirmedItemIds, setConfirmedItemIds] = useState<string[]>([]);
  const [undone, setUndone] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoConflict, setUndoConflict] = useState('');
  const [consentChecked, setConsentChecked] = useState(false);
  const [consentAuthorized, setConsentAuthorized] = useState(planner.data.settings.aiConsent);
  const [consentSaving, setConsentSaving] = useState(false);
  const [stale, setStale] = useState(false);
  const busy = stage === 'permission' || stage === 'recording' || stage === 'transcribing' || stage === 'interpreting' || stage === 'saving' || undoBusy || consentSaving;
  const commitUnconfirmed = failure === 'commit';
  const supported = typeof MediaRecorder !== 'undefined' && typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
  const canStart = supported && backend?.configured === true && !checkingStatus && !statusError && online && consentAuthorized && planner.data.settings.aiConsent && !busy && !stale && !planner.loading && !planner.loadError && !commitUnconfirmed;
  const pendingRows = rows.filter((row) => !row.discarded && !row.alreadySaved && !confirmedItemIds.includes(row.item.itemId));
  const operation = run ? planner.data.operations.find((entry) => entry.id === run.context.operationId) : undefined;
  const receipts = operation?.items.filter((receipt) => confirmedItemIds.includes(receipt.itemId)) ?? [];
  const capturedZone = run?.context.timeZone ?? planner.data.settings.timeZone;
  const editedTranscript = interpretedTextRef.current !== '' && transcript !== interpretedTextRef.current;

  function valid(session: CaptureRun, token?: number): boolean {
    return mountedRef.current && runRef.current === session && session.epoch === epochRef.current && (token === undefined || token === actionTokenRef.current);
  }

  function stopTracks() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }

  function releaseRecorder() {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state !== 'inactive') {
        try { recorder.stop(); } catch { /* Tracks are still released below. */ }
      }
    }
    stopTracks();
    chunksRef.current = [];
    chunkBytesRef.current = 0;
  }

  function abortRequests() {
    controllersRef.current.forEach((controller) => controller.abort());
    controllersRef.current.clear();
  }

  async function checkStatus() {
    statusControllerRef.current?.abort();
    const controller = new AbortController();
    statusControllerRef.current = controller;
    const token = ++statusTokenRef.current;
    const epoch = epochRef.current;
    setCheckingStatus(true);
    setStatusError('');
    setBackend(null);
    try {
      const status = await api.getStatus(controller.signal);
      if (!mountedRef.current || token !== statusTokenRef.current || epoch !== epochRef.current) return;
      setBackend(status);
    } catch (cause) {
      if (!mountedRef.current || token !== statusTokenRef.current || epoch !== epochRef.current || controller.signal.aborted) return;
      setStatusError(`Das lokale KI-Backend ist nicht erreichbar: ${messageOf(cause)}`);
    } finally {
      if (mountedRef.current && token === statusTokenRef.current && epoch === epochRef.current) setCheckingStatus(false);
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    void checkStatus();
    const offline = () => {
      setOnline(false);
      abortRequests();
    };
    const onlineAgain = () => { setOnline(true); void checkStatus(); };
    window.addEventListener('offline', offline);
    window.addEventListener('online', onlineAgain);
    return () => {
      mountedRef.current = false;
      actionTokenRef.current += 1;
      statusTokenRef.current += 1;
      statusControllerRef.current?.abort();
      abortRequests();
      releaseRecorder();
      audioRef.current = null;
      runRef.current = null;
      committedItemsRef.current.clear();
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', onlineAgain);
      if (dialog?.open) dialog.close();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    if (workspaceEpoch === originalEpochRef.current) return;
    actionTokenRef.current += 1;
    abortRequests();
    statusControllerRef.current?.abort();
    releaseRecorder();
    audioRef.current = null;
    processingRef.current = false;
    runRef.current = null;
    setStale(true);
    setConsentSaving(false);
    setUndoBusy(false);
    setStage('error');
    setFailure(null);
    setError('Der Arbeitsbereich wurde gewechselt oder importiert. Ergebnisse dieses Vorgangs werden nicht übernommen. Schließe das Panel und öffne es für den aktuellen Arbeitsbereich erneut.');
  }, [workspaceEpoch]);

  useEffect(() => {
    if (stage !== 'recording') return;
    const interval = window.setInterval(() => {
      const seconds = Math.floor((Date.now() - recordingStartedRef.current) / 1000);
      setElapsed(seconds);
      if (seconds >= MAX_RECORDING_SECONDS) {
        setNotice('Die Aufnahme wurde nach fünf Minuten automatisch beendet und wird verarbeitet.');
        stopRecording();
      }
    }, 500);
    return () => window.clearInterval(interval);
  }, [stage]);

  async function authorizeConsent() {
    if (!consentChecked || consentSaving || stale || plannerRef.current.loading) return;
    const epoch = epochRef.current;
    setConsentSaving(true);
    setError('');
    try {
      plannerRef.current.updateSettings({ aiConsent: true });
      const saved = await plannerRef.current.flush();
      if (!mountedRef.current || epoch !== epochRef.current) return;
      if (!saved) throw new Error('Die Einwilligung konnte nicht gespeichert werden. Versuche es erneut.');
      setConsentAuthorized(true);
      setNotice('Einwilligung gespeichert. Das Mikrofon startet erst mit „Aufnahme starten“.');
    } catch (cause) {
      if (mountedRef.current && epoch === epochRef.current) {
        setConsentAuthorized(false);
        setError(messageOf(cause));
      }
    } finally {
      if (mountedRef.current && epoch === epochRef.current) setConsentSaving(false);
    }
  }

  function ensureOnline() {
    if (!navigator.onLine) throw new Error('Du bist offline. Stelle die Verbindung wieder her und versuche die Verarbeitung erneut.');
  }

  async function persistItems(session: CaptureRun, items: CaptureItem[], token: number) {
    if (!valid(session, token) || undone) return;
    setStage('saving');
    failedItemsRef.current = items;
    const result = await plannerRef.current.commitCapture({ operationId: session.context.operationId, context: session.context, items });
    if (!valid(session, token)) return;
    items.forEach((item) => committedItemsRef.current.set(item.itemId, item));
    setConfirmedItemIds((previous) => [...new Set([...previous, ...items.map((item) => item.itemId)])]);
    failedItemsRef.current = [];
    setFailure(null);
    setError('');
    setStage('ready');
    setNotice(result.skippedItemIds.length > 0 ? 'Verarbeitung bestätigt. Bereits im Vorgang enthaltene Einträge wurden nicht erneut angelegt.' : `${items.length === 1 ? 'Eine neue Aufgabe wurde' : `${items.length} neue Aufgaben wurden`} dauerhaft gespeichert.`);
  }

  async function processRun(session: CaptureRun, audio: Blob | null, text: string, changed: boolean) {
    if (processingRef.current || !valid(session) || undone || stale || commitUnconfirmed) return;
    processingRef.current = true;
    const token = ++actionTokenRef.current;
    const controller = new AbortController();
    controllersRef.current.add(controller);
    let failedStage: Failure = audio ? 'transcribe' : 'interpret';
    setError('');
    setFailure(null);
    setNotice('');
    try {
      ensureOnline();
      let source = text;
      if (audio) {
        setStage('transcribing');
        const result = await api.transcribe(audio, session.context, controller.signal);
        if (!valid(session, token)) return;
        audioRef.current = null;
        audio = null;
        source = result.transcript;
        setTranscript(source);
      }
      failedStage = 'interpret';
      if (!source.trim()) throw new Error('Es wurde kein verständlicher Text erkannt. Ergänze das Transkript oder starte eine neue Aufnahme.');
      setStage('interpreting');
      const result = await api.interpret(source, session.context, controller.signal);
      if (!valid(session, token)) return;
      const committedSources = new Set([...committedItemsRef.current.values()].map((item) => sourceKey(item.sourceText)));
      if (changed && committedItemsRef.current.size > 0) reviewAdditionalRef.current = true;
      const needsAdditionalReview = reviewAdditionalRef.current;
      const nextRows: CaptureRow[] = result.items.map((item) => ({
        item,
        issues: captureIssues(item, session.context.timeZone),
        additionalReview: needsAdditionalReview,
        alreadySaved: committedItemsRef.current.has(item.itemId) || committedSources.has(sourceKey(item.sourceText)),
        discarded: false,
      }));
      interpretedTextRef.current = source;
      setGeneration((previous) => previous + 1);
      setRows(nextRows);
      const clear = nextRows.filter((row) => !row.alreadySaved && row.item.intent === 'create' && row.issues.length === 0 && !row.additionalReview).map((row) => row.item);
      if (!plannerRef.current.data.settings.voiceReview && clear.length > 0) {
        failedStage = 'commit';
        await persistItems(session, clear, token);
      } else {
        setStage('ready');
        setNotice(result.items.length === 0 ? 'Es wurden keine Aufgaben erkannt. Du kannst das Transkript bearbeiten und erneut auswerten.' : nextRows.every((row) => row.alreadySaved) ? 'Alle erkannten Aufgaben sind bereits in diesem Vorgang gespeichert. Es wurde nichts doppelt angelegt.' : 'Die Vorschau ist bereit. Kläre Rückfragen oder bestätige neue Aufgaben einzeln.');
      }
    } catch (cause) {
      if (!valid(session, token)) return;
      setStage('error');
      setFailure(failedStage);
      setError(`${!navigator.onLine ? 'Die Verbindung wurde unterbrochen. Stelle die Internetverbindung wieder her.' : messageOf(cause)} ${failedStage === 'transcribe' ? 'Die Aufnahme bleibt bis zum erneuten Versuch oder Verwerfen ausschließlich im Arbeitsspeicher.' : failedStage === 'commit' ? 'Die Speicherung wurde nicht bestätigt. Wiederhole denselben Vorgang; es werden keine doppelten Aufgaben angelegt.' : 'Das Transkript bleibt erhalten und kann erneut verarbeitet werden.'}`);
    } finally {
      controllersRef.current.delete(controller);
      if (valid(session, token)) processingRef.current = false;
    }
  }

  async function startRecording() {
    if (!canStart || processingRef.current) return;
    if ((pendingRows.length > 0 || (transcript.trim() && confirmedItemIds.length === 0)) && !window.confirm('Eine neue Aufnahme verwirft das bisherige Transkript und noch nicht übernommene Vorschläge. Bereits gespeicherte Aufgaben bleiben erhalten. Neue Aufnahme starten?')) return;
    const token = ++actionTokenRef.current;
    const epoch = epochRef.current;
    processingRef.current = true;
    setStage('permission');
    setError('');
    setNotice('');
    setFailure(null);
    try {
      const mimeType = MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error('Dieser Browser bietet kein unterstütztes Audioformat. Verwende einen aktuellen Browser mit WebM- oder MP4-Aufnahme.');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current || token !== actionTokenRef.current || epoch !== epochRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64000 });
      const session: CaptureRun = { context: { operationId: crypto.randomUUID(), capturedAt: new Date().toISOString(), timeZone: plannerRef.current.data.settings.timeZone }, epoch };
      runRef.current = session;
      setRun(session);
      setTranscript('');
      interpretedTextRef.current = '';
      reviewAdditionalRef.current = false;
      setRows([]);
      committedItemsRef.current.clear();
      setConfirmedItemIds([]);
      setUndone(false);
      setUndoConflict('');
      failedItemsRef.current = [];
      audioRef.current = null;
      chunksRef.current = [];
      chunkBytesRef.current = 0;
      setElapsed(0);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (!valid(session) || !event.data.size) return;
        chunksRef.current.push(event.data);
        chunkBytesRef.current += event.data.size;
        if (chunkBytesRef.current > MAX_AUDIO_BYTES) {
          releaseRecorder();
          audioRef.current = null;
          setStage('error');
          setError('Die Aufnahme überschreitet 20 MiB und wurde verworfen. Starte eine kürzere Aufnahme.');
        }
      };
      recorder.onerror = () => {
        if (!valid(session)) return;
        releaseRecorder();
        audioRef.current = null;
        setStage('error');
        setError('Die Audioaufnahme wurde vom Browser unterbrochen. Prüfe das Mikrofon und starte erneut. Es wurde keine Aufnahme gesendet.');
      };
      recorder.onstop = () => {
        if (!valid(session)) return;
        const audio = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType });
        chunksRef.current = [];
        chunkBytesRef.current = 0;
        recorderRef.current = null;
        stopTracks();
        if (audio.size === 0) {
          setStage('error');
          setError('Die Aufnahme enthält keine Audiodaten. Prüfe das Mikrofon und versuche es erneut.');
          return;
        }
        audioRef.current = audio;
        void processRun(session, audio, '', false);
      };
      recordingStartedRef.current = Date.now();
      recorder.start(1000);
      setStage('recording');
      setNotice('Aufnahme läuft. Sprich deine Aufgaben und nenne Planung und Fälligkeit möglichst getrennt.');
    } catch (cause) {
      if (!mountedRef.current || token !== actionTokenRef.current || epoch !== epochRef.current) return;
      releaseRecorder();
      setStage('error');
      setError(microphoneError(cause));
    } finally {
      if (mountedRef.current && token === actionTokenRef.current && epoch === epochRef.current) processingRef.current = false;
    }
  }

  function stopRecording() {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    setStage('transcribing');
    setNotice('Aufnahme beendet. Audio wird transkribiert und anschließend als Aufgaben ausgewertet.');
    try { recorder.stop(); } catch (cause) {
      releaseRecorder();
      setStage('error');
      setError(`Die Aufnahme konnte nicht beendet werden: ${messageOf(cause)}`);
    }
  }

  function cancelCapture() {
    if (stage === 'saving' || undoBusy || commitUnconfirmed) return;
    actionTokenRef.current += 1;
    abortRequests();
    releaseRecorder();
    audioRef.current = null;
    processingRef.current = false;
    setFailure(null);
    setError('');
    setStage(runRef.current ? 'ready' : 'idle');
    setNotice('Aufnahme und laufende Übertragung abgebrochen. Audiodaten wurden verworfen. Bereits gespeicherte Aufgaben bleiben erhalten.');
  }

  async function commitResolved(items: CaptureItem[]) {
    const session = runRef.current;
    if (!session || !valid(session) || processingRef.current || stale || undone || undoBusy) return;
    processingRef.current = true;
    const token = ++actionTokenRef.current;
    setError('');
    setFailure(null);
    try {
      await persistItems(session, items, token);
    } catch (cause) {
      if (!valid(session, token)) return;
      setFailure('commit');
      setStage('error');
      setError(`${messageOf(cause)} Die Speicherung wurde nicht bestätigt. Deine Eingaben bleiben erhalten. Wiederhole denselben Speichervorgang.`);
    } finally {
      if (valid(session, token)) processingRef.current = false;
    }
  }

  function retry() {
    const session = runRef.current;
    if (!session || !valid(session) || busy || stale) return;
    if (failure === 'commit') void commitResolved(failedItemsRef.current);
    else if (failure === 'transcribe' && audioRef.current) void processRun(session, audioRef.current, '', false);
    else if (failure === 'interpret' && transcript.trim()) void processRun(session, null, transcript, editedTranscript);
  }

  async function undo(force = false) {
    const session = runRef.current;
    if (!session || !valid(session) || busy || commitUnconfirmed || undone) return;
    if (force && !window.confirm('Die erfassten Aufgaben oder Zeitblöcke wurden inzwischen geändert. Rückgängig entfernt auch diese späteren Änderungen. Wirklich alle Aufgaben dieses Sprachvorgangs und ihre Zeitblöcke entfernen?')) return;
    setUndoBusy(true);
    setError('');
    try {
      await plannerRef.current.undoCapture(session.context.operationId, force);
      if (!valid(session)) return;
      setUndone(true);
      setUndoConflict('');
      setNotice('Die Aufgaben dieses Sprachvorgangs wurden entfernt. Der Vorgang bleibt gesperrt, damit ein erneuter Versuch sie nicht wieder anlegt.');
    } catch (cause) {
      if (!valid(session)) return;
      if (!force && /verändert|geändert|später|seit der erfassung/iu.test(messageOf(cause))) setUndoConflict(messageOf(cause));
      else setError(`Rückgängig konnte nicht bestätigt werden: ${messageOf(cause)} Versuche „Erfassung rückgängig“ erneut. Der Vorgang bleibt gegen Doppelanlagen gesperrt.`);
    } finally {
      if (valid(session)) setUndoBusy(false);
    }
  }

  function requestClose() {
    if (stage === 'saving' || undoBusy || consentSaving) {
      setNotice('Bitte warte, bis der laufende Speichervorgang abgeschlossen ist.');
      return;
    }
    if ((stage === 'recording' || stage === 'permission' || stage === 'transcribing' || stage === 'interpreting' || audioRef.current || pendingRows.length > 0) && !window.confirm('Panel schließen und noch nicht übernommene Aufnahme oder Vorschläge verwerfen? Bereits gespeicherte Aufgaben bleiben erhalten.')) return;
    onClose();
  }

  function openSavedTask(taskId: string) {
    const current = plannerRef.current.data.tasks.find((entry) => entry.id === taskId);
    if (!current) return;
    if (pendingRows.length > 0 && !window.confirm('Beim Öffnen des Aufgabeneditors wird die Spracheingabe geschlossen. Noch nicht übernommene Vorschläge verwerfen und die gespeicherte Aufgabe bearbeiten?')) return;
    onEditTask(current);
  }

  const stageLabel: Record<Stage, string> = { idle: 'Bereit für deine Aufgaben', permission: 'Mikrofonfreigabe wird angefragt …', recording: 'Aufnahme läuft', transcribing: 'Audio wird transkribiert …', interpreting: 'Aufgaben werden erkannt …', saving: 'Aufgaben werden gespeichert …', ready: 'Verarbeitung abgeschlossen', error: 'Verarbeitung benötigt deine Aufmerksamkeit' };

  return (
    <dialog ref={dialogRef} className="dialog voice-panel voice-atelier voice-horizon" aria-labelledby={`${prefix}-title`} aria-describedby={`${prefix}-description`} onCancel={(event) => { event.preventDefault(); requestClose(); }}>
      <header className="dialog-header voice-header">
        <div><p className="eyebrow"><Mic size={14} aria-hidden="true" /> AUFGABEN / SPRACHE</p><h2 id={`${prefix}-title`}>Aufgaben diktieren</h2></div>
        <button type="button" className="secondary-button voice-close" aria-label="Spracheingabe schließen" onClick={requestClose} disabled={stage === 'saving' || undoBusy || consentSaving} autoFocus><X size={20} aria-hidden="true" /></button>
      </header>

      <div className="dialog-body voice-body">
        <p className="voice-help" id={`${prefix}-description`}>Mehrere Aufgaben in einer Aufnahme: eindeutige neue Einträge werden angelegt, unklare Angaben hier geklärt. Bestehende Aufgaben bleiben unverändert.</p>
        <section className="voice-backend" aria-label="Status der Spracherkennung">
          {checkingStatus ? <p role="status">Lokales KI-Backend wird geprüft …</p> : statusError ? <><strong>Spracherkennung nicht erreichbar</strong><p>{statusError}</p></> : backend?.configured ? <><strong>Backend eingerichtet</strong><p>Transkription: {backend.transcriptionModel} · Aufgaben: {backend.textModel}</p><p>OpenAI-Verbindung wird erst bei der Verarbeitung geprüft.</p></> : <><strong>OpenAI-Spracherkennung nicht eingerichtet</strong><p><code>npm run api</code> mit serverseitigem <code>OPENAI_API_KEY</code> einrichten. Der Schlüssel gehört niemals in den Browser.</p></>}
          {(statusError || (!checkingStatus && !backend?.configured)) && <button type="button" className="secondary-button" disabled={busy || !online || stale} onClick={() => void checkStatus()}>Einrichtung erneut prüfen</button>}
          {!backend?.configured && !checkingStatus && <p className="voice-help">Manuelle Nutzung bleibt möglich. Das Mikrofon bleibt ausgeschaltet.</p>}
        </section>
        {!online && <p className="voice-warning" role="alert">Du bist offline. Aufnahmeübertragung und OpenAI-Verarbeitung benötigen eine Internetverbindung. Ein vorhandenes Transkript bleibt bearbeitbar.</p>}
        {!supported && <p className="voice-warning" role="alert">Dieser Browser unterstützt die Mikrofonaufnahme hier nicht. Öffne NEXUS über localhost oder eine sichere HTTPS-Verbindung in einem aktuellen Browser.</p>}
        {planner.loadError && <p className="voice-warning" role="alert">Die Planung konnte nicht geladen werden. Behebe den Ladefehler, bevor du Aufgaben erfasst.</p>}

        {(!consentAuthorized || !planner.data.settings.aiConsent) && <section className="voice-consent" aria-labelledby={`${prefix}-consent-title`}><h3 id={`${prefix}-consent-title`}>Vor der ersten Nutzung</h3><p>Deine Aufnahme und das daraus erkannte Transkript werden zur Verarbeitung über dein lokales Backend an OpenAI gesendet. Dabei können API-Kosten entstehen. Datum und Zeitzone der Aufnahme helfen, „morgen“ oder „nächste Woche“ aufzulösen.</p><p>Audio bleibt nur im Arbeitsspeicher und wird nach erfolgreicher Transkription, bei Abbruch oder beim Schließen verworfen. Es wird nicht in NEXUS-Sicherungen gespeichert. Klar erkannte neue Aufgaben werden nach deiner bewusst gestarteten Aufnahme automatisch angelegt; im Prüfmodus bestätigst du sie vorher.</p><label className="voice-confirm"><input type="checkbox" checked={consentChecked} disabled={busy || stale} onChange={(event) => setConsentChecked(event.target.checked)} /><span>Ich stimme der Übertragung von Audio und Transkript an OpenAI und möglichen API-Kosten zu.</span></label><button type="button" className="secondary-button" disabled={!consentChecked || busy || stale || planner.loading || Boolean(planner.loadError)} onClick={() => void authorizeConsent()}>{consentSaving ? 'Einwilligung wird gespeichert …' : 'Einwilligung speichern'}</button></section>}

        <section className="voice-recording" aria-labelledby={`${prefix}-record-title`}>
          <h3 id={`${prefix}-record-title`}>1. Aufnahme</h3>
          <label className="voice-confirm voice-review-option"><input type="checkbox" checked={planner.data.settings.voiceReview} disabled={busy || stale || commitUnconfirmed} onChange={(event) => { try { plannerRef.current.updateSettings({ voiceReview: event.target.checked }); } catch (cause) { setError(messageOf(cause)); } }} /><span>Prüfmodus · alle neuen Aufgaben vor dem Anlegen prüfen</span></label>
          <div className="voice-recorder-status" role="status" aria-live="polite"><span className={`voice-record-dot${stage === 'recording' ? ' is-recording' : ''}`} aria-hidden="true" /><strong>{stageLabel[stage]}</strong>{stage === 'recording' && <span className="voice-elapsed" aria-label={`Aufnahmedauer ${elapsedLabel(elapsed)}`}>{elapsedLabel(elapsed)}</span>}</div>
          <div className="voice-actions">
            {stage === 'recording' ? <button type="button" className="primary-button" onClick={stopRecording}><Square size={16} aria-hidden="true" /> Stoppen und verarbeiten</button> : <button type="button" className="primary-button" disabled={!canStart} onClick={() => void startRecording()}><Mic size={17} aria-hidden="true" /> {run ? 'Neue Aufnahme starten' : 'Aufnahme starten'}</button>}
            {(stage === 'permission' || stage === 'recording' || stage === 'transcribing' || stage === 'interpreting' || audioRef.current) && <button type="button" className="secondary-button" onClick={cancelCapture}>Abbrechen</button>}
          </div>
          <p className="voice-help">„Morgen um zehn dreißig Minuten den Bericht überarbeiten.“ · Maximal fünf Minuten oder 20 MiB.</p>
          {run && <p className="voice-help">Aufgenommen am {new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short', timeZone: capturedZone, hour12: false }).format(new Date(run.context.capturedAt))} · {capturedZone}. Gilt auch bei Wiederholungen.</p>}
        </section>

        {run && (transcript !== '' || failure === 'interpret' || rows.length > 0) && <section className="voice-transcript" aria-labelledby={`${prefix}-transcript-title`}>
          <h3 id={`${prefix}-transcript-title`}>2. Transkript prüfen</h3>
          <label className="field" htmlFor={`${prefix}-transcript`}><span>Erkannter Text · bearbeitbar</span><textarea ref={transcriptRef} id={`${prefix}-transcript`} rows={5} value={transcript} disabled={busy || stale || undone || commitUnconfirmed} onChange={(event) => setTranscript(event.target.value)} /></label>
          {confirmedItemIds.length > 0 && <p className="voice-help">Bereits gespeicherte Aufgaben bleiben erhalten. Bekannte Einträge dieser Aufnahme werden bei erneuter Auswertung übersprungen. Nach Textänderungen musst du zusätzliche Aufgaben ausdrücklich bestätigen.</p>}
          {editedTranscript && <p className="voice-warning">Das Transkript wurde geändert. Die sichtbaren Vorschläge stammen noch aus der vorherigen Auswertung. Werte den geänderten Text erneut aus, bevor du weitere Vorschläge übernimmst.</p>}
          <button type="button" className="secondary-button" disabled={busy || stale || undone || commitUnconfirmed || !online || !backend?.configured || !transcript.trim()} onClick={() => { const session = runRef.current; if (session) void processRun(session, null, transcript, editedTranscript); }}>Transkript erneut auswerten</button>
        </section>}

        {confirmedItemIds.length > 0 && <section className="voice-success" aria-labelledby={`${prefix}-saved-title`}>
          <h3 id={`${prefix}-saved-title`}><Check size={18} aria-hidden="true" /> {undone ? 'Erfassung rückgängig gemacht' : `${confirmedItemIds.length} ${confirmedItemIds.length === 1 ? 'Aufgabe gespeichert' : 'Aufgaben gespeichert'}`}</h3>
          {!undone && <><ul className="voice-receipts">{receipts.map((receipt) => { const task = planner.data.tasks.find((entry) => entry.id === receipt.taskId); const source = committedItemsRef.current.get(receipt.itemId); return <li key={receipt.itemId}><div><strong>{task?.title ?? source?.title ?? 'Erfasste Aufgabe'}</strong>{task && <small>Planung: {task.plan?.kind === 'day' ? formatDate(task.plan.date) : task.plan?.kind === 'week' ? `Woche ab ${formatDate(task.plan.weekStart)}` : 'Eingang'} · Fälligkeit: {task.dueDate ? formatDate(task.dueDate) : 'keine'}</small>}{source?.suggestions.map((suggestion, index) => <small className="voice-receipt-suggestion" key={index}>Vorschlag: {suggestion}</small>)}{!task && <small>Diese Aufgabe ist inzwischen entfernt worden.</small>}</div><button type="button" className="secondary-button" disabled={!task || busy || stale || commitUnconfirmed} onClick={() => openSavedTask(receipt.taskId)}>Bearbeiten</button></li>; })}</ul><button type="button" className="secondary-button" disabled={busy || stale || commitUnconfirmed} onClick={() => void undo()}><RotateCcw size={16} aria-hidden="true" /> Erfassung rückgängig</button></>}
          {undone && <p>Bereits verarbeitete Einträge bleiben für Wiederholungen gesperrt. Für neue Aufgaben starte eine neue Aufnahme.</p>}
          {undoConflict && <div className="voice-warning" role="alert"><p>{undoConflict}</p><p>Prüfe die Aufgaben vor dem Entfernen. Spätere Änderungen werden nur nach deiner ausdrücklichen Bestätigung mit entfernt.</p><div className="voice-actions"><button type="button" className="secondary-button" disabled={busy || stale} onClick={() => setUndoConflict('')}>Aufgaben behalten</button><button type="button" className="secondary-button" disabled={busy || stale} onClick={() => void undo(true)}>Trotz späterer Änderungen rückgängig</button></div></div>}
        </section>}

        {!undone && pendingRows.length > 0 && <section className="voice-review" aria-labelledby={`${prefix}-review-title`}><h3 id={`${prefix}-review-title`}>3. {planner.data.settings.voiceReview ? 'Vorschläge prüfen' : 'Offene Angaben klären'}</h3><p className="voice-help">Die folgenden Einträge wurden noch nicht angelegt. Eindeutige andere Aufgaben können bereits oben bestätigt sein.</p>{pendingRows.map((row) => <CaptureItemEditor key={`${generation}-${row.item.itemId}`} item={row.item} timeZone={capturedZone} issues={row.issues} additionalReview={row.additionalReview} disabled={busy || stale || commitUnconfirmed || editedTranscript} onSave={(item) => { setRows((previous) => previous.map((entry) => entry.item.itemId === item.itemId ? { ...entry, item } : entry)); void commitResolved([item]); }} onDiscard={() => setRows((previous) => previous.map((entry) => entry.item.itemId === row.item.itemId ? { ...entry, discarded: true } : entry))} />)}</section>}

        {notice && <p className="voice-notice" role="status" aria-live="polite">{notice}</p>}
        {error && <div className="voice-warning" role="alert"><p>{error}</p>{failure && !stale && !undone && <button type="button" className="secondary-button" disabled={busy || (failure !== 'commit' && !online) || (failure === 'interpret' && !transcript.trim())} onClick={retry}>{failure === 'commit' ? 'Speichern erneut versuchen' : failure === 'transcribe' ? 'Aufnahme erneut übertragen' : 'Auswertung erneut versuchen'}</button>}</div>}
      </div>

      <footer className="dialog-footer voice-footer"><button type="button" className="secondary-button" disabled={stage === 'saving' || undoBusy || consentSaving} onClick={requestClose}>Schließen</button></footer>
    </dialog>
  );
}
