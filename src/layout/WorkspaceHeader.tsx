import { useEffect, useId, useRef, useState } from 'react';
import { Bell, CalendarPlus, ChevronDown, Mic, Plus, Search, Settings2, Sparkles } from 'lucide-react';
import type { WorkspaceViewProps } from '../planning/types';
import type { SaveStatus } from '../types';
import { dateInZone } from '../planning/dates';
import { SearchDialog } from '../search/SearchDialog';
import './WorkspaceHeader.css';

export interface WorkspaceHeaderProps extends WorkspaceViewProps {
  atelier?: boolean;
  onSearch?: () => void;
  onSettingsPanel?: () => void;
  noteStatus?: SaveStatus;
  noteLoadError?: string | null;
}

/** Shared actions; an optional root search callback also serves global shortcuts. */
export function WorkspaceHeader(props: WorkspaceHeaderProps) {
  const { planner, onNavigate, onAI, onQuickCapture, onEditAppointment, onEditReminder, onDictate, onSearch } = props;
  const [searchOpen, setSearchOpen] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [online, setOnline] = useState(() => navigator.onLine);
  const [createOpen, setCreateOpen] = useState(false);
  const create = useRef<HTMLDetailsElement>(null);
  const createId = useId();
  useEffect(() => {
    const refresh = () => { setNow(new Date()); setOnline(navigator.onLine); };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    window.addEventListener('offline', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh); window.removeEventListener('offline', refresh); };
  }, []);
  useEffect(() => {
    if (!createOpen) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !create.current?.contains(event.target) && create.current) create.current.open = false; };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && create.current?.open) { event.preventDefault(); create.current.open = false; create.current.querySelector('summary')?.focus(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [createOpen]);
  function perform(action: () => void) {
    if (create.current) { create.current.open = false; create.current.querySelector('summary')?.focus(); }
    action();
  }
  const date = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: planner.data.settings.timeZone }).format(now);
  const hasLoadError = Boolean(planner.loadError || props.noteLoadError);
  const hasSaveError = planner.status === 'error' || props.noteStatus === 'error';
  const isSaving = planner.status === 'saving' || props.noteStatus === 'saving';
  const status = hasLoadError ? 'Laden fehlgeschlagen' : hasSaveError ? 'Speicherfehler' : planner.loading ? 'Wird geladen …' : isSaving ? 'Wird gespeichert …' : props.noteStatus ? 'Gespeichert' : 'Speicherstatus unvollständig';
  const storage = <details className={`nexus-header-meta${hasSaveError || hasLoadError ? ' has-storage-error' : ''}`}>
    <summary aria-label={props.atelier ? `Speicherdetails: ${status}` : undefined}><span role="status" className={hasSaveError || hasLoadError ? 'nexus-header-storage-error' : ''}>{status}</span><ChevronDown size={14} aria-hidden="true" /><span className="nexus-header-meta-label">Speicherdetails</span></summary>
    <div className="nexus-header-meta-details">
      <span>Speicher: IndexedDB</span>
      <span>Browser meldet {online ? 'online' : 'offline'} · Kein Gerätesync</span>
      {planner.loadError && <span>Planung: {planner.loadError}</span>}
      {props.noteLoadError && <span>Notizen: {props.noteLoadError}</span>}
    </div>
  </details>;
  return <>
    <header className={`nexus-workspace-header${props.atelier ? ' nexus-workspace-header--atelier' : ''}`} aria-label="Gemeinsame Aktionen">
      <button className="nexus-header-search" type="button" aria-label="Aufgaben, Notizen und Termine suchen" aria-keyshortcuts="Control+k Meta+k" onClick={() => onSearch ? onSearch() : setSearchOpen(true)}><Search size={16} aria-hidden="true" /><span>Aufgaben, Notizen, Termine …</span><kbd>Strg K</kbd></button>
      <div className="nexus-header-actions"><time className="nexus-header-date" dateTime={dateInZone(now, planner.data.settings.timeZone)}>{date}</time>
        {props.atelier && storage}
        <button className="nexus-header-icon" type="button" aria-label="Erinnerungen öffnen" title="Erinnerungen" onClick={() => onNavigate('reminders')}><Bell size={17} aria-hidden="true" /></button>
        <button className="nexus-header-icon nexus-header-ai" type="button" aria-label="KI-Assistent öffnen" title="KI-Assistent" onClick={onAI}><Sparkles size={17} aria-hidden="true" /></button>
        <button className="nexus-header-settings" type="button" aria-label="Einstellungen öffnen" onClick={() => props.onSettingsPanel ? props.onSettingsPanel() : onNavigate('settings')}><Settings2 size={16} aria-hidden="true" /><span>Einstellungen</span></button>
        <details className="nexus-header-create" ref={create} onToggle={(event) => setCreateOpen(event.currentTarget.open)} onBlur={(event) => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }}>
          <summary aria-label={props.atelier ? 'Neu erstellen' : undefined} aria-controls={createId} aria-expanded={createOpen}><Plus size={17} aria-hidden="true" /><span>Neu erstellen</span><ChevronDown size={14} aria-hidden="true" /></summary>
          <div className="nexus-header-create-options" id={createId} role="group" aria-label="Neu erstellen">
            <button type="button" onClick={() => perform(onQuickCapture)}><Plus size={17} aria-hidden="true" /><span>Kurz festhalten<small>Aufgabe oder Notiz</small></span></button>
            <button type="button" onClick={() => perform(() => onEditAppointment())}><CalendarPlus size={17} aria-hidden="true" /><span>Termin</span></button>
            <button type="button" onClick={() => perform(() => onEditReminder())}><Bell size={17} aria-hidden="true" /><span>Erinnerung</span></button>
            <button type="button" onClick={() => perform(onDictate)}><Mic size={17} aria-hidden="true" /><span>Aufgaben diktieren</span></button>
          </div>
        </details>
      </div>
    </header>
    {!props.atelier && storage}
    {searchOpen && <SearchDialog {...props} onClose={() => setSearchOpen(false)} />}
  </>;
}
