import '../notes-polish.css';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { NotebookPen, Pin, Plus, Search, Settings2, Trash2, X } from 'lucide-react';
import type { Note } from '../types';
import { collectTags, filterNotes, type NoteSort, type NoteView } from './filterNotes';
import { dateInZone, todayInZone } from '../planning/dates';
import { noteTagLabel } from '../editor/noteTags';

export interface SidebarProps {
  notes: Note[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onSettings: () => void;
  view: NoteView;
  onViewChange: (view: NoteView) => void;
  timeZone?: string;
}

function noteDate(timestamp: string, timeZone: string): { short: string; full: string } {
  const shortDate = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short', timeZone });
  const fullDate = new Intl.DateTimeFormat('de-DE', { dateStyle: 'long', timeStyle: 'short', hourCycle: 'h23', timeZone });
  const shortTime = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone });
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return { short: 'Unbekanntes Datum', full: 'Unbekanntes Datum' };
  const today = dateInZone(date, timeZone) === todayInZone(timeZone);

  return {
    short: today ? `Heute, ${shortTime.format(date)}` : shortDate.format(date),
    full: fullDate.format(date),
  };
}

function notePreview(content: string): string {
  return content
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+(?:\[[ xX]\]\s*)?/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

export function Sidebar({ notes, activeId, onSelect, onCreate, onSettings, view, onViewChange, timeZone = 'Europe/Berlin' }: SidebarProps) {
  const [query, setQuery] = useState('');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [sort, setSort] = useState<NoteSort>('updated');
  const searchInput = useRef<HTMLInputElement>(null);
  const searchId = useId();
  const sortId = useId();

  useEffect(() => {
    setQuery('');
    setSelectedTag(null);
    setPinnedOnly(false);
  }, [view]);

  const noteCount = notes.filter((note) => note.deletedAt === null).length;
  const trashCount = notes.length - noteCount;
  const viewCount = view === 'notes' ? noteCount : trashCount;
  const tags = useMemo(() => collectTags(notes, view), [notes, view]);
  const visibleNotes = useMemo(() => filterNotes(notes, {
    view, query, tag: selectedTag, pinnedOnly, sort,
  }), [notes, view, query, selectedTag, pinnedOnly, sort]);
  const hasFilters = query.trim().length > 0 || selectedTag !== null || pinnedOnly;

  function clearFilters() {
    setQuery('');
    setSelectedTag(null);
    setPinnedOnly(false);
  }

  function changeView(nextView: NoteView) {
    if (nextView === view) return;
    clearFilters();
    onViewChange(nextView);
  }

  function createNote() {
    clearFilters();
    onCreate();
  }

  return (
    <aside className="sidebar" aria-label="Notizen und Navigation">
      <header className="notes-library-heading"><span className="notes-library-mark" aria-hidden="true" /><h1>Notizen</h1><span className="horizon-library-count" aria-label={`${noteCount} ${noteCount === 1 ? 'Notiz' : 'Notizen'}`}>{noteCount}</span></header>

      <button className="new-note-button" type="button" onClick={createNote}>
        <Plus size={18} aria-hidden="true" />
        <span>Neue Notiz</span>
      </button>

      <nav className="sidebar-view-tabs" aria-label="Notizansichten">
        <button
          className={`sidebar-view-button${view === 'notes' ? ' active' : ''}`}
          type="button"
          aria-pressed={view === 'notes'}
          onClick={() => changeView('notes')}
        >
          <NotebookPen size={16} aria-hidden="true" />
          <span>Notizen</span>
          <span className="note-count">{noteCount}</span>
        </button>
        <button
          className={`sidebar-view-button${view === 'trash' ? ' active' : ''}`}
          type="button"
          aria-pressed={view === 'trash'}
          onClick={() => changeView('trash')}
        >
          <Trash2 size={16} aria-hidden="true" />
          <span>Papierkorb</span>
          <span className="note-count">{trashCount}</span>
        </button>
      </nav>

      <div className="search-box">
        <Search size={16} aria-hidden="true" />
        <input
          id={searchId}
          ref={searchInput}
          className="search-input"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Suchen …"
          aria-label="Notizen durchsuchen"
          autoComplete="off"
          spellCheck={false}
        />
        {query && (
          <button className="search-clear" type="button" onClick={() => { setQuery(''); searchInput.current?.focus(); }} aria-label="Suchfeld leeren" title="Suchfeld leeren">
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="sidebar-filters">
        <button
          className={`filter-button${pinnedOnly ? ' active' : ''}`}
          type="button"
          aria-pressed={pinnedOnly}
          aria-label="Nur angeheftete Notizen"
          onClick={() => setPinnedOnly((value) => !value)}
        >
          <Pin size={14} aria-hidden="true" />
          <span>Angeheftet</span>
        </button>
        <select
          id={sortId}
          className="sort-select"
          aria-label="Notizen sortieren"
          value={sort}
          onChange={(event) => setSort(event.target.value as NoteSort)}
        >
          <option value="updated">Zuletzt geändert</option>
          <option value="title">Titel A–Z</option>
        </select>
      </div>

      {(tags.length > 0 || selectedTag !== null) && (
        <div className="tag-filters" role="group" aria-label="Nach Tag filtern">
          <button className={`tag-filter${selectedTag === null ? ' active' : ''}`} type="button" aria-pressed={selectedTag === null} onClick={() => setSelectedTag(null)}>
            Alle Tags
          </button>
          {tags.map((tag) => (
            <button
              className={`tag-filter${selectedTag === tag ? ' active' : ''}`}
              type="button"
              key={tag}
              aria-pressed={selectedTag === tag}
              onClick={() => setSelectedTag(selectedTag === tag ? null : tag)}
            >
              {noteTagLabel(tag, '#')}
            </button>
          ))}
          {selectedTag !== null && !tags.includes(selectedTag) && (
            <button className="tag-filter active" type="button" aria-pressed="true" onClick={() => setSelectedTag(null)}>
              {noteTagLabel(selectedTag, '#')} <X size={12} aria-hidden="true" />
            </button>
          )}
        </div>
      )}

      <div className="sidebar-heading-row">
        <h2 className="sidebar-heading">{hasFilters ? 'Auswahl' : view === 'trash' ? 'Gelöscht' : 'Sammlung'}</h2>
        <span className="note-count" role="status" aria-live="polite" aria-atomic="true">
          {hasFilters ? `${visibleNotes.length} von ${viewCount}` : visibleNotes.length}
          <span className="sr-only"> {visibleNotes.length === 1 ? 'Notiz' : 'Notizen'}</span>
        </span>
      </div>

      {visibleNotes.length > 0 ? (
        <ul className="note-list" aria-label={view === 'trash' ? 'Gelöschte Notizen' : 'Notizliste'}>
          {visibleNotes.map((note) => {
            const title = note.title.trim() || 'Unbenannte Notiz';
            const timestamp = view === 'trash' ? note.deletedAt ?? note.updatedAt : note.updatedAt;
            const date = noteDate(timestamp, timeZone);
            const preview = notePreview(note.content);
            return (
              <li key={note.id}>
                <button
                  className={`note-card${note.id === activeId ? ' active' : ''}`}
                  type="button"
                  aria-current={note.id === activeId ? 'true' : undefined}
                  aria-label={`Notiz öffnen: ${title}`}
                  onClick={() => onSelect(note.id)}
                >
                  <span className="note-card-topline">
                    <span className="note-card-title">{title}</span>
                    {note.pinned && <span className="note-card-pin" role="img" aria-label="Angeheftet" title="Angeheftet"><Pin size={13} aria-hidden="true" /></span>}
                  </span>
                  <span className="note-card-preview">{preview || 'Noch kein Text'}</span>
                  <span className="note-card-meta">
                    <time dateTime={timestamp} title={date.full}>{view === 'trash' && 'Gelöscht: '}{date.short}</time>
                    {note.tags.length > 0 && (
                      <span className="note-card-tags" aria-label={`Tags: ${note.tags.map(tag => noteTagLabel(tag)).join(', ')}`}>
                        {note.tags.slice(0, 2).map((tag) => <span className="note-card-tag" key={tag}>{noteTagLabel(tag, '#')}</span>)}
                        {note.tags.length > 2 && <span className="note-card-tag">+{note.tags.length - 2}</span>}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="sidebar-empty" role="status">
          <span className="sidebar-empty-icon" aria-hidden="true">{view === 'trash' ? <Trash2 size={25} /> : <NotebookPen size={25} />}</span>
          <h3>{hasFilters ? 'Keine Treffer' : view === 'trash' ? 'Papierkorb leer' : 'Noch keine Notizen'}</h3>
          {hasFilters && <p>Suche anpassen oder Filter zurücksetzen.</p>}
          {view === 'notes' && !hasFilters && <p>Deine Notizen erscheinen hier.</p>}
          {view === 'trash' && !hasFilters && <p>Gelöschte Notizen lassen sich hier wiederherstellen.</p>}
          {hasFilters ? (
            <button className="sidebar-empty-action" type="button" onClick={clearFilters}>Filter zurücksetzen</button>
          ) : view === 'trash' ? (
            <button className="sidebar-empty-action" type="button" onClick={() => changeView('notes')}>Zu den Notizen</button>
          ) : null}
        </div>
      )}

      <footer className="sidebar-footer">
        <button type="button" onClick={onSettings} aria-label="Einstellungen" title="Einstellungen">
          <Settings2 size={18} aria-hidden="true" />
        </button>
      </footer>
    </aside>
  );
}
