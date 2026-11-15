import type { Note } from '../types';

export type NoteView = 'notes' | 'trash';
export type NoteSort = 'updated' | 'title';

export interface NoteFilters {
  view: NoteView;
  query?: string;
  tag?: string | null;
  pinnedOnly?: boolean;
  sort?: NoteSort;
}

const titleCollator = new Intl.Collator('de-DE', { sensitivity: 'base', numeric: true });

function searchable(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('de-DE');
}

/** Search all terms across a note's title, content and tags without mutating the source. */
export function filterNotes(notes: readonly Note[], filters: NoteFilters): Note[] {
  const terms = searchable(filters.query ?? '').trim().split(/\s+/).filter(Boolean);
  const result = notes.filter((note) => {
    if ((note.deletedAt !== null) !== (filters.view === 'trash')) return false;
    if (filters.pinnedOnly && !note.pinned) return false;
    if (filters.tag && !note.tags.includes(filters.tag)) return false;

    if (terms.length > 0) {
      const text = searchable([note.title, note.content, ...note.tags].join(' '));
      if (!terms.every((term) => text.includes(term))) return false;
    }

    return true;
  });

  return result.sort((a, b) => {
    // Pins keep important notes at the top; the chosen order applies within each group.
    if (filters.view === 'notes' && a.pinned !== b.pinned) return a.pinned ? -1 : 1;

    if (filters.sort === 'title') {
      const titleOrder = titleCollator.compare(a.title.trim() || 'Unbenannte Notiz', b.title.trim() || 'Unbenannte Notiz');
      if (titleOrder !== 0) return titleOrder;
    }

    const changedOrder = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    return changedOrder || titleCollator.compare(a.id, b.id);
  });
}

export function collectTags(notes: readonly Note[], view: NoteView): string[] {
  return [...new Set(notes
    .filter((note) => (note.deletedAt !== null) === (view === 'trash'))
    .flatMap((note) => note.tags))]
    .sort(titleCollator.compare);
}
