import type { Backup, ImportMode, Note } from '../types';
import type { PlanningData, WorkspaceBackup } from '../planning/types';
import { emptyPlanning } from '../planning/types';
import { BACKUP_LIMITS, makeBackup, parseBackup } from './backup';
import { makeWorkspaceBackup, parseWorkspaceBackup } from './workspaceBackup';
import { mergeWorkspaces } from './workspaceMerge';
import { getWorkspaceScope } from '../auth/workspaceScope';

// The version bump also blocks older clients whose validator would discard
// nested steps and morning routine receipts when writing a planning snapshot.
const DATABASE_VERSION = 4;
const NOTES_STORE = 'notes';
const METADATA_STORE = 'metadata';
const LAST_BACKUP_KEY = 'lastBackup';
const WORKSPACE_STORE = 'workspace';
const PLANNING_KEY = 'planning';
const LAST_WORKSPACE_BACKUP_KEY = 'lastWorkspaceBackup';
const LAST_MIGRATION_BACKUP_KEY = 'lastMigrationBackup';

function storageError(error: unknown, fallback = 'Der Browserspeicher konnte nicht verwendet werden.'): Error {
  if (error instanceof Error && error.name !== 'UnknownError') {
    if (error.name === 'QuotaExceededError') {
      return new Error('Der Browserspeicher ist voll. Sichere deine Eingaben als Datei und schaffe Speicherplatz.');
    }
    if (error.name === 'SecurityError' || error.name === 'NotAllowedError') {
      return new Error('Der Browser erlaubt hier keinen lokalen Speicher. Bitte prüfe seine Datenschutz-Einstellungen.');
    }
    if (error.name === 'AbortError') return new Error('Der Speichervorgang wurde abgebrochen. Deine bisherigen gespeicherten Daten bleiben erhalten.');
    if (error.name === 'VersionError') return new Error('Diese NEXUS-Version ist älter als dein gespeicherter Arbeitsbereich. Bitte lade die aktuelle App-Version, bevor du weiterarbeitest.');
    return new Error(`${fallback} ${error.message}`);
  }
  return new Error(fallback);
}

/** Read notes and planning in a single transaction, without asynchronous gaps. */
function readWorkspace(
  tx: IDBTransaction,
  done: (workspace: WorkspaceBackup) => void,
  fail: (error: unknown) => void,
): void {
  const notes = tx.objectStore(NOTES_STORE).getAll();
  const planning = tx.objectStore(WORKSPACE_STORE).get(PLANNING_KEY);
  let remaining = 2;
  const ready = () => {
    if (--remaining !== 0) return;
    try { done(makeWorkspaceBackup(notes.result as Note[], (planning.result as PlanningData | undefined) ?? emptyPlanning())); }
    catch (error) { fail(error); }
  };
  notes.onsuccess = ready;
  planning.onsuccess = ready;
}

function uniqueId(used: Set<string>): string {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    throw new Error('Für einen sicheren Import wird ein Browser mit Unterstützung für zufällige UUIDs benötigt.');
  }
  let result: string;
  do {
    result = crypto.randomUUID();
  } while (used.has(result));
  used.add(result);
  return result;
}

function unlinkNotes(planning: PlanningData, retained: (id: string) => boolean): PlanningData {
  const unlink = <T extends { noteIds: string[]; updatedAt: string }>(item: T): T => {
    const noteIds = item.noteIds.filter(retained);
    if (noteIds.length === item.noteIds.length) return item;
    const updatedAt = new Date(Math.max(Date.now(), Date.parse(item.updatedAt) + 1)).toISOString();
    return { ...item, noteIds, updatedAt };
  };
  return {
    ...planning,
    // Receipt undo guards must observe edits even for future imported timestamps.
    tasks: planning.tasks.map(unlink),
    taskRules: (planning.taskRules ?? []).map(rule => {
      const updated = unlink({ ...rule.template, updatedAt: rule.updatedAt });
      return { ...rule, updatedAt: updated.updatedAt, template: { ...rule.template, noteIds: updated.noteIds } };
    }),
  };
}

function mergeNotes(current: Note[], incoming: Note[]): Note[] {
  if (current.length + incoming.length > BACKUP_LIMITS.notes) {
    throw new Error(`Nach dem Zusammenführen wären mehr als ${BACKUP_LIMITS.notes.toLocaleString('de-DE')} Notizen vorhanden. Bitte importiere weniger Notizen oder ersetze den Bestand.`);
  }
  const used = new Set<string>();
  for (const note of current) {
    used.add(note.id);
    for (const revision of note.revisions) used.add(revision.id);
  }
  // Reserve incoming IDs too, so a generated UUID cannot steal a later ID.
  const reserved = new Set(used);
  for (const note of incoming) {
    reserved.add(note.id);
    for (const revision of note.revisions) reserved.add(revision.id);
  }
  return incoming.map((note) => {
    const collision = used.has(note.id);
    const id = collision ? uniqueId(reserved) : note.id;
    used.add(id);
    return {
      ...note,
      id,
      revisions: note.revisions.map((revision) => {
        // History copied into a newly identified note receives new IDs as well.
        const id = collision || used.has(revision.id) ? uniqueId(reserved) : revision.id;
        used.add(id);
        return { ...revision, id };
      }),
    };
  });
}

export function createRepository(databaseName: string | (() => string)) {
  let connection: Promise<IDBDatabase> | undefined;
  let resolvedDatabaseName: string | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (connection) return connection;
  let pending: Promise<IDBDatabase>;
  pending = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB ist in diesem Browser nicht verfügbar. Lokales Speichern ist nicht möglich.'));
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      resolvedDatabaseName ??= typeof databaseName === 'function' ? databaseName() : databaseName;
      request = indexedDB.open(resolvedDatabaseName, DATABASE_VERSION);
    } catch (error) {
      reject(storageError(error));
      return;
    }
    let rejected = false;
    let migrationFailure: unknown;
    request.onupgradeneeded = event => {
      const database = request.result;
      if (!database.objectStoreNames.contains(NOTES_STORE)) database.createObjectStore(NOTES_STORE, { keyPath: 'id' });
      if (!database.objectStoreNames.contains(METADATA_STORE)) database.createObjectStore(METADATA_STORE);
      if (!database.objectStoreNames.contains(WORKSPACE_STORE)) database.createObjectStore(WORKSPACE_STORE);
      // A genuinely new workspace keeps onboarding available. Existing empty
      // workspaces are migrations as well, never candidates for injected demo data.
      if (event.oldVersion === 0) return;
      const tx = request.transaction!;
      const notes = tx.objectStore(NOTES_STORE).getAll();
      const planning = tx.objectStore(WORKSPACE_STORE).get(PLANNING_KEY);
      let remaining = 2;
      const ready = () => {
        if (--remaining !== 0) return;
        try {
          const previous = event.oldVersion === 1 ? makeBackup(notes.result as Note[]) : {
            format: 'nexus-workspace', version: event.oldVersion >= 3 ? 3 : 2, exportedAt: new Date().toISOString(),
            notes: notes.result, planning: planning.result ?? emptyPlanning(),
          };
          const migrated = parseWorkspaceBackup(JSON.stringify(previous));
          if (event.oldVersion < 3) migrated.planning.settings.onboardingDone = true;
          // Backup, normalization and database-version change share the upgrade
          // transaction. Any validation/quota/abort failure retains the old DB.
          // Keep the validated application data only; imported unknown fields
          // (for example a raw recording) never enter a newly written backup.
          const safePrevious = event.oldVersion === 1 ? makeBackup(migrated.notes) : { ...structuredClone(migrated), version: event.oldVersion >= 3 ? 3 : 2 };
          tx.objectStore(METADATA_STORE).put(safePrevious, LAST_MIGRATION_BACKUP_KEY);
          // The requested v3 entry point applies to an upgraded installation;
          // file imports retain their explicitly exported start preference.
          if (event.oldVersion < 3) migrated.planning.settings.startView = 'menu';
          tx.objectStore(WORKSPACE_STORE).put(migrated.planning, PLANNING_KEY);
        } catch (error) {
          migrationFailure = error;
          tx.abort();
        }
      };
      notes.onsuccess = ready;
      planning.onsuccess = ready;
    };
    request.onblocked = () => {
      rejected = true;
      reject(new Error('Die Notizdatenbank wird durch ein anderes geöffnetes NEXUS-Fenster blockiert. Bitte schließe es und versuche es erneut.'));
    };
    request.onerror = () => {
      rejected = true;
      reject(migrationFailure instanceof Error ? migrationFailure : storageError(request.error, 'Die Notizdatenbank konnte nicht geöffnet werden.'));
    };
    request.onsuccess = () => {
      const database = request.result;
      if (rejected) {
        database.close();
        return;
      }
      const invalidate = () => {
        if (connection === pending) connection = undefined;
      };
      database.onversionchange = () => {
        database.close();
        invalidate();
      };
      database.onclose = invalidate;
      resolve(database);
    };
  });
  connection = pending;
  // Do not retain a rejected opening promise: retries must open the DB again.
  void pending.catch(() => {
    if (connection === pending) connection = undefined;
  });
  return pending;
}

/**
 * No operation reports success from a request's success event. A successful
 * request may still belong to a transaction that is rolled back afterwards.
 */
async function transaction<T>(
  stores: string[],
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction, setResult: (result: T) => void, fail: (error: unknown) => void) => void,
): Promise<T> {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = database.transaction(stores, mode);
    } catch (error) {
      if (error instanceof Error && error.name === 'InvalidStateError') connection = undefined;
      reject(storageError(error));
      return;
    }
    let result: T;
    let failure: unknown;
    const fail = (error: unknown) => {
      failure ??= error;
      try {
        tx.abort();
      } catch {
        // The transaction may already be aborting. Its final event settles us.
      }
    };
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(failure instanceof Error ? failure : storageError(tx.error, 'Die Notizänderung konnte nicht gespeichert werden.'));
    tx.onerror = (event) => {
      // Do not preventDefault: an IndexedDB request failure must abort all writes.
      const requestError = (event.target as IDBRequest | null)?.error;
      failure ??= storageError(requestError ?? tx.error, 'Die Notizänderung konnte nicht gespeichert werden.');
    };
    try {
      run(tx, (value) => { result = value; }, fail);
    } catch (error) {
      fail(error);
    }
  });
}

  return {
  async close(): Promise<void> {
    const pending = connection;
    connection = undefined;
    if (pending) {
      try { (await pending).close(); } catch { /* A failed open has no connection to close. */ }
    }
  },

  async list(): Promise<Note[]> {
    return transaction<Note[]>([NOTES_STORE], 'readonly', (tx, setResult, fail) => {
      const request = tx.objectStore(NOTES_STORE).getAll();
      request.onsuccess = () => {
        try {
          setResult(makeBackup(request.result as Note[]).notes);
        } catch (error) {
          fail(error);
        }
      };
    });
  },

  async put(note: Note): Promise<void> {
    // Snapshot before awaiting database access: later UI mutation cannot alter it.
    const snapshot = makeBackup([note]).notes[0];
    return transaction<void>([NOTES_STORE, WORKSPACE_STORE], 'readwrite', (tx, _setResult, fail) => {
      const store = tx.objectStore(NOTES_STORE);
      readWorkspace(tx, (current) => {
        const next = current.notes.filter((item) => item.id !== snapshot.id);
        next.push(snapshot);
        // The entire persisted collection must remain exportable/importable.
        // Check and write in one transaction, including concurrent requests.
        makeWorkspaceBackup(next, current.planning);
        store.put(snapshot);
      }, fail);
    });
  },

  async remove(id: string): Promise<void> {
    if (typeof id !== 'string' || !id.trim()) throw new Error('Die zu löschende Notiz besitzt keine gültige Kennung.');
    return transaction<void>([NOTES_STORE, WORKSPACE_STORE], 'readwrite', (tx, _setResult, fail) => {
      readWorkspace(tx, (current) => {
        const planning = unlinkNotes(current.planning, noteId => noteId !== id);
        const next = makeWorkspaceBackup(current.notes.filter(note => note.id !== id), planning);
        tx.objectStore(NOTES_STORE).delete(id);
        tx.objectStore(WORKSPACE_STORE).put(next.planning, PLANNING_KEY);
      }, fail);
    });
  },

  async importNotes(notes: Note[], mode: ImportMode): Promise<void> {
    if (mode !== 'merge' && mode !== 'replace') throw new Error('Bitte wähle Zusammenführen oder Ersetzen als Importmodus.');
    const incoming = makeBackup(notes).notes;
    return transaction<void>([NOTES_STORE, WORKSPACE_STORE, METADATA_STORE], 'readwrite', (tx, _setResult, fail) => {
      const store = tx.objectStore(NOTES_STORE);
      readWorkspace(tx, (current) => {
        if (mode === 'replace') {
          const noteIds = new Set(incoming.map(note => note.id));
          const planning = unlinkNotes(current.planning, id => noteIds.has(id));
          const next = makeWorkspaceBackup(incoming, planning);
          // Backup and replacement commit together, or neither is changed.
          tx.objectStore(METADATA_STORE).put(makeBackup(current.notes), LAST_BACKUP_KEY);
          tx.objectStore(METADATA_STORE).put(current, LAST_WORKSPACE_BACKUP_KEY);
          store.clear();
          for (const note of incoming) store.add(note);
          tx.objectStore(WORKSPACE_STORE).put(next.planning, PLANNING_KEY);
        } else {
          const merged = mergeNotes(current.notes, incoming);
          // Enforce the total file limit as well, keeping full exports possible.
          makeWorkspaceBackup([...current.notes, ...merged], current.planning);
          for (const note of merged) store.add(note);
        }
      }, fail);
    });
  },

  async getPlanning(): Promise<PlanningData> {
    return transaction<PlanningData>([NOTES_STORE, WORKSPACE_STORE], 'readonly', (tx, setResult, fail) => {
      readWorkspace(tx, snapshot => setResult(snapshot.planning), fail);
    });
  },

  async putPlanning(data: PlanningData): Promise<void> {
    // Snapshot synchronously, then validate note references against this transaction.
    const snapshot = structuredClone(data);
    return transaction<void>([NOTES_STORE, WORKSPACE_STORE], 'readwrite', (tx, _setResult, fail) => {
      const request = tx.objectStore(NOTES_STORE).getAll();
      request.onsuccess = () => {
        try {
          const next = makeWorkspaceBackup(request.result as Note[], snapshot);
          tx.objectStore(WORKSPACE_STORE).put(next.planning, PLANNING_KEY);
        } catch (error) { fail(error); }
      };
    });
  },

  async exportWorkspace(): Promise<WorkspaceBackup> {
    return transaction<WorkspaceBackup>([NOTES_STORE, WORKSPACE_STORE], 'readonly', (tx, setResult, fail) => {
      readWorkspace(tx, setResult, fail);
    });
  },

  async importWorkspace(backup: WorkspaceBackup, mode: ImportMode): Promise<void> {
    if (mode !== 'merge' && mode !== 'replace') throw new Error('Bitte wähle Zusammenführen oder Ersetzen als Importmodus.');
    // Public callers cannot bypass format/version or graph validation.
    const incoming = parseWorkspaceBackup(JSON.stringify(backup));
    return transaction<void>([NOTES_STORE, WORKSPACE_STORE, METADATA_STORE], 'readwrite', (tx, _setResult, fail) => {
      readWorkspace(tx, current => {
        const next = mode === 'merge' ? mergeWorkspaces(current, incoming) : incoming;
        // An explicit import configures this existing workspace even if the file
        // originated before a welcome choice; merge keeps other current settings.
        next.planning.settings.onboardingDone = true;
        const store = tx.objectStore(NOTES_STORE);
        tx.objectStore(METADATA_STORE).put(current, LAST_WORKSPACE_BACKUP_KEY);
        store.clear();
        for (const note of next.notes) store.add(note);
        tx.objectStore(WORKSPACE_STORE).put(next.planning, PLANNING_KEY);
      }, fail);
    });
  },

  async getLastWorkspaceBackup(): Promise<WorkspaceBackup | null> {
    return transaction<WorkspaceBackup | null>([METADATA_STORE], 'readonly', (tx, setResult, fail) => {
      const request = tx.objectStore(METADATA_STORE).get(LAST_WORKSPACE_BACKUP_KEY);
      request.onsuccess = () => {
        try { setResult(request.result === undefined ? null : parseWorkspaceBackup(JSON.stringify(request.result))); }
        catch (error) { fail(error); }
      };
    });
  },

  async getLastMigrationBackup(): Promise<WorkspaceBackup | null> {
    return transaction<WorkspaceBackup | null>([METADATA_STORE], 'readonly', (tx, setResult, fail) => {
      const request = tx.objectStore(METADATA_STORE).get(LAST_MIGRATION_BACKUP_KEY);
      request.onsuccess = () => {
        try { setResult(request.result === undefined ? null : parseWorkspaceBackup(JSON.stringify(request.result))); }
        catch (error) { fail(error); }
      };
    });
  },

  async getLastBackup(): Promise<Backup | null> {
    return transaction<Backup | null>([METADATA_STORE], 'readonly', (tx, setResult, fail) => {
      const request = tx.objectStore(METADATA_STORE).get(LAST_BACKUP_KEY);
      request.onsuccess = () => {
        try {
          setResult(request.result === undefined ? null : parseBackup(JSON.stringify(request.result)));
        } catch (error) {
          fail(error);
        }
      };
    });
  },
  };
}

// Resolve only after AccountBoundary has verified and selected an identity.
export const repository = createRepository(() => getWorkspaceScope().databaseName);
