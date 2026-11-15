import { BACKUP_LIMITS } from '../data/backup';
import { repository } from '../data/repository';
import { isDate } from '../planning/dates';
import type { Note, NotePatch, NoteRevision, SaveStatus, Selection } from '../types';

const AUTOSAVE_DELAY = 450;

interface Draft {
  note: Note;
  revision: number;
  sequence: number;
}

interface DeleteRequest {
  revision: number;
  sequence: number;
}

export interface NotesSnapshot {
  notes: Note[];
  activeId: string | null;
  activeNote: Note | null;
  loading: boolean;
  loadError: string | null;
  status: SaveStatus;
  error: string | null;
}

function copyNote(note: Note): Note {
  return {
    ...note,
    tags: [...note.tags],
    revisions: note.revisions.map((revision) => ({ ...revision, tags: [...revision.tags] })),
  };
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function sameTags(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((tag, index) => tag === right[index]);
}

/** One queue owns every write. Dirty entries survive until their exact revision commits. */
export class NotesStore {
  private notes: Note[] = [];
  private activeId: string | null = null;
  private loading = true;
  private loadError: string | null = null;
  private loaded = false;
  private started = false;
  private drafts = new Map<string, Draft>();
  private revisions = new Map<string, number>();
  private deletions = new Map<string, DeleteRequest>();
  private failures = new Map<string, string>();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private pendingJobs = 0;
  private epoch = 0;
  private sequence = 0;
  private selectionRequest = 0;
  private blocked = false;
  private snapshot: NotesSnapshot = {
    notes: [], activeId: null, activeNote: null, loading: true,
    loadError: null, status: 'saving', error: null,
  };

  getSnapshot = (): NotesSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  start = (): void => {
    if (this.started) return;
    this.started = true;
    // loadError is visible in the snapshot; the initial effect has no caller.
    void this.reload().catch(() => undefined);
  };

  hasUnsavedChanges = (): boolean => this.drafts.size > 0 || this.deletions.size > 0;

  setBlocked = (blocked: boolean): void => { this.blocked = blocked; };
  private requireWritable(): void {
    if (this.blocked) throw new Error('Der Datenimport läuft. Warte, bis beide Arbeitsbereiche neu geladen wurden.');
  }

  private publish(): void {
    const error = this.failures.values().next().value ?? null;
    const status: SaveStatus = this.pendingJobs > 0 || this.loading
      ? 'saving'
      : error || this.loadError
        ? 'error'
        : this.hasUnsavedChanges() || !this.loaded ? 'saving' : 'saved';
    this.snapshot = {
      notes: this.notes,
      activeId: this.activeId,
      activeNote: this.notes.find((note) => note.id === this.activeId) ?? null,
      loading: this.loading,
      loadError: this.loadError,
      status,
      error,
    };
    for (const listener of this.listeners) listener();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.pendingJobs += 1;
    this.publish();
    const result = this.queue.then(operation).finally(() => {
      this.pendingJobs -= 1;
      this.publish();
    });
    // A rejected operation must never poison the next job or create an unhandled rejection.
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private cancelTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleSave(): void {
    this.cancelTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, AUTOSAVE_DELAY);
  }

  private setDraft(note: Note): void {
    const revision = (this.revisions.get(note.id) ?? 0) + 1;
    this.revisions.set(note.id, revision);
    this.drafts.set(note.id, { note, revision, sequence: ++this.sequence });
    // A subsequent edit/restore takes precedence over a queued deletion.
    this.deletions.delete(note.id);
    const exists = this.notes.some((item) => item.id === note.id);
    this.notes = exists
      ? this.notes.map((item) => item.id === note.id ? note : item)
      : [note, ...this.notes];
    this.publish();
    this.scheduleSave();
  }

  private changeNote(note: Note, patch: NotePatch): void {
    const next = copyNote({ ...note, ...patch, updatedAt: new Date().toISOString() });
    if (next.title === note.title && next.content === note.content
      && next.pinned === note.pinned && next.deletedAt === note.deletedAt
      && sameTags(next.tags, note.tags) && patch.revisions === undefined) return;
    this.setDraft(next);
  }

  updateNote = (patch: NotePatch): void => {
    this.requireWritable();
    const note = this.snapshot.activeNote;
    if (!note || note.deletedAt) return;
    this.changeNote(note, patch);
  };

  /**
   * Try each revision once per drain. Edits arriving during a write are saved in
   * another pass; a failed revision remains dirty without an endless retry loop.
   */
  private async persistDrafts(epoch: number): Promise<boolean> {
    const attempted = new Map<string, number>();
    const attemptedDeletes = new Map<string, number>();
    while (epoch === this.epoch) {
      const drafts = [...this.drafts.entries()]
        .filter(([id, draft]) => attempted.get(id) !== draft.revision);

      for (const [id, draft] of drafts) {
        if (epoch !== this.epoch) return false;
        attempted.set(id, draft.revision);
        // Never hand a mutable UI object to an asynchronous storage adapter.
        try {
          await repository.put(copyNote(draft.note));
          if (epoch !== this.epoch) return false;
          if (this.drafts.get(id)?.revision === draft.revision) this.drafts.delete(id);
          this.failures.delete(id);
        } catch (error) {
          if (epoch !== this.epoch) return false;
          this.failures.set(id, message(error, 'Deine Änderungen konnten nicht gespeichert werden. Die Eingabe bleibt erhalten.'));
        }
        this.publish();
      }

      const deletions = [...this.deletions.entries()]
        .filter(([id, request]) => attemptedDeletes.get(id) !== request.revision && !this.drafts.has(id));
      if (drafts.length === 0 && deletions.length === 0) break;
      for (const [id, request] of deletions) {
        if (epoch !== this.epoch) return false;
        if (this.deletions.get(id) !== request || this.drafts.has(id)) continue;
        attemptedDeletes.set(id, request.revision);
        try {
          await repository.remove(id);
          if (epoch !== this.epoch) return false;
          if (this.deletions.get(id) === request) {
            this.deletions.delete(id);
            this.notes = this.notes.filter((note) => note.id !== id);
            if (this.activeId === id) this.activeId = null;
            this.failures.delete(id);
          }
          // If restored during remove(), its new draft is written on the next pass.
        } catch (error) {
          if (epoch !== this.epoch) return false;
          if (this.deletions.get(id) === request) {
            this.failures.set(id, message(error, 'Die Notiz konnte nicht endgültig gelöscht werden. Sie bleibt erhalten.'));
          }
        }
        this.publish();
      }
    }
    return epoch === this.epoch && this.loaded && !this.loadError && !this.hasUnsavedChanges();
  }

  flush = (): Promise<boolean> => {
    this.cancelTimer();
    const epoch = this.epoch;
    return this.enqueue(() => this.persistDrafts(epoch));
  };

  retry = (): Promise<boolean> => this.flush();

  selectNote = async (id: string | null): Promise<boolean> => {
    this.requireWritable();
    const request = ++this.selectionRequest;
    if (!await this.flush() || request !== this.selectionRequest) return false;
    this.requireWritable();
    if (id !== null && !this.notes.some((note) => note.id === id)) return false;
    this.activeId = id;
    this.publish();
    return true;
  };

  private async requireSaved(): Promise<void> {
    if (!await this.flush()) {
      throw new Error(this.snapshot.error ?? 'Die Änderungen sind noch nicht vollständig gespeichert. Deine Eingaben bleiben erhalten.');
    }
  }

  createNote = async (): Promise<void> => {
    this.requireWritable();
    // Keep an existing failed draft active and reachable for a text backup.
    await this.requireSaved();
    this.requireWritable();
    const now = new Date().toISOString();
    const note: Note = {
      id: crypto.randomUUID(), title: '', content: '', tags: [], pinned: false,
      createdAt: now, updatedAt: now, deletedAt: null, revisions: [],
    };
    ++this.selectionRequest;
    this.activeId = note.id;
    this.setDraft(note);
    await this.requireSaved();
  };

  /** The caller retains the operation ID until commit, so retry cannot duplicate a capture. */
  captureNote = async (id: string, title: string, content: string, dayTag?: string): Promise<void> => {
    this.requireWritable();
    if (dayTag !== undefined && (!dayTag.startsWith('tag:') || !isDate(dayTag.slice(4)))) throw new Error('Die Tageszuordnung ist ungültig.');
    if (!id || title.length > BACKUP_LIMITS.title || content.length > BACKUP_LIMITS.content) {
      throw new Error('Die Notiz überschreitet die erlaubte Textlänge. Bitte kürzen.');
    }
    const existing = this.notes.find(note => note.id === id);
    if (!existing) {
      await this.requireSaved();
      this.requireWritable();
    }
    if (existing?.deletedAt) throw new Error('Diese Erfassung liegt inzwischen im Papierkorb.');
    const now = new Date().toISOString();
    const captured: Note = existing
      ? { ...copyNote(existing), title, content, updatedAt: now }
      : { id, title, content, tags: dayTag ? [dayTag] : [], pinned: false, createdAt: now, updatedAt: now, deletedAt: null, revisions: [] };
    ++this.selectionRequest;
    this.activeId = id;
    this.setDraft(captured);
    await this.requireSaved();
  };

  duplicateNote = async (): Promise<void> => {
    this.requireWritable();
    await this.requireSaved();
    this.requireWritable();
    const source = this.snapshot.activeNote;
    if (!source || source.deletedAt) return;
    const now = new Date().toISOString();
    const suffix = ' (Kopie)';
    const note: Note = {
      ...copyNote(source), id: crypto.randomUUID(),
      title: `${source.title || 'Unbenannte Notiz'}`.slice(0, BACKUP_LIMITS.title - suffix.length) + suffix,
      createdAt: now, updatedAt: now, deletedAt: null,
      revisions: source.revisions.map((revision) => ({ ...revision, id: crypto.randomUUID(), tags: [...revision.tags] })),
    };
    ++this.selectionRequest;
    this.activeId = note.id;
    this.setDraft(note);
    await this.requireSaved();
  };

  trashNote = async (): Promise<void> => {
    this.requireWritable();
    const note = this.snapshot.activeNote;
    if (!note || note.deletedAt) return;
    this.changeNote(note, { deletedAt: new Date().toISOString() });
    await this.requireSaved();
  };

  restoreNote = async (): Promise<void> => {
    this.requireWritable();
    const note = this.snapshot.activeNote;
    if (!note || !note.deletedAt) return;
    this.changeNote(note, { deletedAt: null });
    await this.requireSaved();
  };

  permanentlyDelete = async (): Promise<void> => {
    this.requireWritable();
    const note = this.snapshot.activeNote;
    if (!note || !note.deletedAt) return;
    this.deletions.set(note.id, {
      revision: this.revisions.get(note.id) ?? 0, sequence: ++this.sequence,
    });
    this.publish();
    await this.requireSaved();
  };

  private originalRevision(note: Note, replacingRevision = false): NoteRevision {
    if (!replacingRevision && note.revisions.length >= BACKUP_LIMITS.revisions) {
      throw new Error(`Der Verlauf enthält bereits ${BACKUP_LIMITS.revisions} Originale. Die Änderung wurde nicht übernommen, damit kein Original verloren geht. Sichere die Notiz und übernimm den Text bei Bedarf in eine neue Notiz.`);
    }
    return {
      id: crypto.randomUUID(), createdAt: new Date().toISOString(),
      title: note.title, content: note.content, tags: [...note.tags],
    };
  }

  applyAI = (content: string, selection?: Selection, metadata?: { title: string; tags: string[] }): void => {
    this.requireWritable();
    const note = this.snapshot.activeNote;
    if (!note || note.deletedAt) return;
    if (selection && (!Number.isInteger(selection.start) || !Number.isInteger(selection.end)
      || selection.start < 0 || selection.end <= selection.start || selection.end > note.content.length
      || note.content.slice(selection.start, selection.end) !== selection.text)) {
      throw new Error('Die markierte Textstelle wurde inzwischen verändert. Wähle sie erneut aus, bevor du den Vorschlag übernimmst.');
    }
    const nextContent = selection
      ? note.content.slice(0, selection.start) + content + note.content.slice(selection.end)
      : content;
    const title = metadata?.title ?? note.title;
    const tags = metadata?.tags ?? note.tags;
    if (nextContent.length > BACKUP_LIMITS.content || title.length > BACKUP_LIMITS.title
      || tags.length > BACKUP_LIMITS.tags || tags.some((tag) => !tag.trim() || tag.length > BACKUP_LIMITS.tag)) {
      throw new Error('Der Vorschlag überschreitet die zulässige Textlänge oder Tag-Anzahl. Kürze ihn vor der Übernahme.');
    }
    if (nextContent === note.content && title === note.title && sameTags(tags, note.tags)) return;
    const original = this.originalRevision(note);
    this.changeNote(note, { content: nextContent, title, tags, revisions: [original, ...note.revisions] });
  };

  restoreRevision = (id: string): void => {
    this.requireWritable();
    const note = this.snapshot.activeNote;
    if (!note || note.deletedAt) return;
    const revision = note.revisions.find((entry) => entry.id === id);
    if (!revision) throw new Error('Dieses Original ist nicht mehr im Verlauf verfügbar.');
    if (revision.title === note.title && revision.content === note.content && sameTags(revision.tags, note.tags)) return;
    const original = this.originalRevision(note, true);
    this.changeNote(note, {
      title: revision.title, content: revision.content, tags: revision.tags,
      // Swap the selected original into the editor: no state is lost, and even
      // a full history can be restored without exceeding the storage limit.
      revisions: [original, ...note.revisions.filter((entry) => entry.id !== id)],
    });
  };

  /** Reload is a write barrier, not a save: imports must flush before replacing. */
  reload = (): Promise<void> => {
    this.cancelTimer();
    const epoch = ++this.epoch;
    const sequence = this.sequence;
    ++this.selectionRequest;
    this.loading = true;
    this.loadError = null;
    this.publish();
    return this.enqueue(async () => {
      try {
        const stored = (await repository.list()).map(copyNote);
        if (epoch !== this.epoch) return;
        // Inputs made after reload began must survive even a slow read.
        const drafts = new Map([...this.drafts].filter(([, draft]) => draft.sequence > sequence));
        const deletions = new Map([...this.deletions].filter(([, request]) => request.sequence > sequence));
        const notes = new Map(stored.map((note) => [note.id, note]));
        for (const [id, draft] of drafts) notes.set(id, draft.note);
        this.notes = [...notes.values()];
        this.drafts = drafts;
        this.deletions = deletions;
        this.failures = new Map([...this.failures].filter(([id]) => drafts.has(id) || deletions.has(id)));
        for (const note of this.notes) {
          if (!this.revisions.has(note.id)) this.revisions.set(note.id, 0);
        }
        if (!this.notes.some((note) => note.id === this.activeId)) {
          this.activeId = [...this.notes]
            .filter((note) => !note.deletedAt)
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.id ?? null;
        }
        this.loaded = true;
        this.loading = false;
        this.loadError = null;
        this.publish();
        if (this.hasUnsavedChanges()) this.scheduleSave();
      } catch (error) {
        if (epoch !== this.epoch) return;
        this.loading = false;
        this.loadError = message(error, 'Deine gespeicherten Notizen konnten nicht geladen werden. Bitte erneut versuchen.');
        this.publish();
        throw new Error(this.loadError);
      }
    });
  };
}
