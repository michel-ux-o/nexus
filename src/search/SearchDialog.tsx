import { useDeferredValue, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ArrowUpRight, CalendarDays, CheckSquare, NotebookPen, Search, X } from 'lucide-react';
import { noteTagLabel } from '../editor/noteTags';
import type { WorkspaceViewProps } from '../planning/types';
import { formatDate, formatTime, dateInZone } from '../planning/dates';
import { WorkspaceDialog } from '../layout/WorkspaceDialog';
import { createWorkspaceSearchIndex, queryWorkspaceSearch } from './search';
import type { SearchKind, SearchResult } from './search';
import './SearchDialog.css';

export interface SearchDialogProps extends Pick<WorkspaceViewProps, 'planner' | 'notes' | 'onOpenNote' | 'onEditTask' | 'onEditAppointment' | 'onNavigate'> { onClose: () => void }
const labels = { task: 'Aufgabe', note: 'Notiz', appointment: 'Termin' };
const icons = { task: CheckSquare, note: NotebookPen, appointment: CalendarDays };
const filters: { kind: SearchKind | 'all'; label: string }[] = [{ kind: 'all', label: 'Alles' }, { kind: 'task', label: 'Aufgaben' }, { kind: 'note', label: 'Notizen' }, { kind: 'appointment', label: 'Termine' }];

function metadata(result: SearchResult, timeZone: string): string {
  if (result.kind === 'task') {
    const { item } = result;
    return [item.status === 'done' ? 'Erledigt' : item.status === 'progress' ? 'In Bearbeitung' : 'Offen',
      item.plan?.kind === 'day' ? `Geplant: ${formatDate(item.plan.date, { day: 'numeric', month: 'short' })}` : item.plan?.kind === 'week' ? `Woche ab ${formatDate(item.plan.weekStart, { day: 'numeric', month: 'short' })}` : 'Eingang',
      item.dueDate ? `Fällig: ${formatDate(item.dueDate, { day: 'numeric', month: 'short' })}` : ''].filter(Boolean).join(' · ');
  }
  if (result.kind === 'appointment') {
    const { item } = result;
    return item.allDay ? `${formatDate(item.allDay.startDate, { day: 'numeric', month: 'short', year: 'numeric' })} · Ganztägig`
      : `${formatDate(dateInZone(item.startAt, timeZone), { day: 'numeric', month: 'short', year: 'numeric' })} · ${formatTime(item.startAt, timeZone)} · ${item.durationMinutes} Min.`;
  }
  return result.item.tags.length ? result.item.tags.map((tag) => noteTagLabel(tag, '#')).join(' · ') : 'Ohne Tags';
}

export function SearchDialog({ planner, notes, onClose, onOpenNote, onEditTask, onEditAppointment, onNavigate }: SearchDialogProps) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SearchKind | 'all'>('all');
  const deferred = useDeferredValue(query);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const index = useMemo(() => createWorkspaceSearchIndex(planner.data, notes), [planner.data.tasks, planner.data.appointments, notes]);
  const results = useMemo(() => queryWorkspaceSearch(index, deferred), [index, deferred]);
  const filtered = results.filter((result) => filter === 'all' || result.kind === filter);
  const visible = filtered.slice(0, 60);
  const pending = query !== deferred;

  function open(result: SearchResult) {
    onClose();
    if (result.kind === 'note') { onNavigate('notes'); onOpenNote(result.item.id); }
    else if (result.kind === 'task') { onNavigate('tasks'); onEditTask(result.item); }
    else { onNavigate('calendar'); onEditAppointment(result.item); }
  }
  function moveFocus(event: KeyboardEvent<HTMLElement>) {
    const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    if (!buttons.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    if (event.target === input.current && !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : current === -1 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1) : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }
  return <WorkspaceDialog title="Arbeitsraum durchsuchen" eyebrow="GLOBALE SUCHE" onClose={onClose} className="nexus-search-dialog">
    <div className="nexus-search-body">
      <label className="nexus-search-label" htmlFor={`${id}-query`}>Aufgaben, Notizen und Termine</label>
      <div className="nexus-search-field"><Search size={19} aria-hidden="true" /><input ref={input} id={`${id}-query`} data-initial-focus type="search" maxLength={500} autoComplete="off" spellCheck={false} placeholder="Wonach suchst du?" value={query} aria-describedby={`${id}-status`} aria-controls={`${id}-results`} onChange={(event) => setQuery(event.target.value)} onKeyDown={moveFocus} />
        {query && <button type="button" aria-label="Suchtext löschen" onClick={() => { setQuery(''); input.current?.focus(); }}><X size={17} aria-hidden="true" /></button>}
      </div>
      <div className="nexus-search-filters" role="group" aria-label="Suchbereich">{filters.map(({ kind, label }) => <button type="button" key={kind} aria-pressed={filter === kind} onClick={() => setFilter(kind)}>{label}{query.trim() && <span>{kind === 'all' ? results.length : results.filter((result) => result.kind === kind).length}</span>}</button>)}</div>
      <p className="nexus-search-status" id={`${id}-status`} role="status" aria-live="polite">{pending ? 'Suche wird aktualisiert …' : !query.trim() ? 'Alle Suchwörter werden berücksichtigt. Suche auch nach Tags oder Textinhalten.' : `${filtered.length} Treffer${visible.length < filtered.length ? ` · Die ersten ${visible.length} werden angezeigt. Verfeinere die Suche für weitere Treffer.` : ''}`}</p>
      {visible.length > 0 ? <ul className="nexus-search-results" id={`${id}-results`} ref={list} onKeyDown={moveFocus} aria-label="Suchergebnisse" aria-busy={pending}>{visible.map((result) => {
        const Icon = icons[result.kind];
        const text = (result.kind === 'note' ? result.item.content : result.item.description).replace(/\s+/g, ' ').trim();
        return <li key={`${result.kind}:${result.item.id}`}><button type="button" onClick={() => open(result)}><span className="nexus-search-result-icon"><Icon size={18} aria-hidden="true" /></span><span className="nexus-search-result-text"><span className="nexus-search-result-title">{result.item.title.trim() || 'Unbenannte Notiz'}</span><small>{labels[result.kind]} · {metadata(result, planner.data.settings.timeZone)}</small>{text && <span className="nexus-search-result-preview">{text.slice(0, 160)}{text.length > 160 ? ' …' : ''}</span>}</span><ArrowUpRight size={16} aria-hidden="true" /></button></li>;
      })}</ul> : <div className="nexus-search-empty" id={`${id}-results`}><Search size={29} strokeWidth={1.3} aria-hidden="true" /><h3>{query.trim() ? 'Keine passenden Einträge' : 'Alles an einem Ort finden'}</h3><p>{query.trim() ? 'Versuche einen anderen Begriff oder einen anderen Suchbereich.' : 'Deine Suche bleibt lokal in diesem Arbeitsraum. Notizen im Papierkorb werden ausgelassen.'}</p></div>}
    </div>
    <footer className="nexus-search-footer"><span><kbd>↑</kbd> <kbd>↓</kbd> Durch Treffer bewegen</span><span><kbd>Esc</kbd> Schließen</span></footer>
  </WorkspaceDialog>;
}
