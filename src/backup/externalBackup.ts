import { MAX_WORKSPACE_BACKUP_BYTES, parseWorkspaceBackup } from '../data/workspaceBackup';
import type { WorkspaceBackup } from '../planning/types';
import { getWorkspaceScope } from '../auth/workspaceScope';

type Permission = 'granted' | 'denied' | 'prompt';
interface BackupFileHandle {
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>;
}
interface BackupDirectoryHandle {
  name: string;
  queryPermission(options: { mode: 'readwrite' }): Promise<Permission>;
  requestPermission(options: { mode: 'readwrite' }): Promise<Permission>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<BackupFileHandle>;
  values(): AsyncIterableIterator<{ kind: string; name: string }>;
}
type PickerWindow = Window & { showDirectoryPicker?: (options: { mode: 'readwrite' }) => Promise<BackupDirectoryHandle> };
const storeName = 'handles';
const handleKey = 'directory';
const prefix = 'nexus-workspace-';
let directory: BackupDirectoryHandle | null = null;

function supported(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && typeof (window as PickerWindow).showDirectoryPicker === 'function' && typeof indexedDB !== 'undefined' && typeof crypto.randomUUID === 'function';
}
function openAccess(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(getWorkspaceScope().backupDatabaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Der lokale Ordnerzugriff konnte nicht geöffnet werden.', { cause: request.error }));
    request.onblocked = () => reject(new Error('Der lokale Ordnerzugriff ist durch einen anderen Tab blockiert.'));
  });
}
async function access<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openAccess();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const request = action(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(new Error('Der lokale Ordnerzugriff konnte nicht gespeichert werden.', { cause: tx.error }));
      tx.onerror = () => reject(new Error('Der lokale Ordnerzugriff ist fehlgeschlagen.', { cause: tx.error }));
    });
  } finally { db.close(); }
}
function requireSupport(): void {
  if (!supported()) throw new Error('Dieser Browser unterstützt die lokale Ordnerauswahl hier nicht. Bitte nutze den normalen Datei-Export und -Import.');
}
async function requireDirectory(): Promise<BackupDirectoryHandle> {
  requireSupport();
  if (!directory) throw new Error('Bitte zuerst einen Sicherungsordner auswählen.');
  if (await directory.queryPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Der Zugriff auf den Sicherungsordner muss erneut erlaubt werden.');
  return directory;
}
function validName(name: string): boolean {
  return name.startsWith(prefix) && name.endsWith('.json') && !name.includes('/') && !name.includes('\\') && name !== '.' && name !== '..';
}
function describe(error: unknown, action: string): Error {
  const name = error instanceof DOMException ? error.name : '';
  const detail = name === 'AbortError' ? 'Der Vorgang wurde abgebrochen.' : name === 'NotAllowedError' || name === 'SecurityError' ? 'Der Ordnerzugriff wurde verweigert oder ist schreibgeschützt.' : name === 'QuotaExceededError' ? 'Es steht nicht genügend Speicherplatz zur Verfügung.' : 'Bitte prüfe Ordnerzugriff und verfügbaren Speicherplatz.';
  return new Error(`${action} ${detail}`, { cause: error });
}

export const externalBackup = {
  supported,
  async restoreDirectory(): Promise<string | null> {
    if (!supported()) return null;
    try {
      directory = (await access('readonly', store => store.get(handleKey)) as BackupDirectoryHandle | undefined) ?? null;
      return directory?.name ?? null;
    } catch (error) { throw describe(error, 'Der gespeicherte Sicherungsordner konnte nicht geladen werden.'); }
  },
  async chooseDirectory(): Promise<string> {
    requireSupport();
    try {
      // Invoke the picker before the first await to retain browser user activation.
      const selected = await (window as PickerWindow).showDirectoryPicker!({ mode: 'readwrite' });
      await access('readwrite', store => store.put(selected, handleKey));
      directory = selected;
      return selected.name;
    } catch (error) { throw describe(error, 'Der Sicherungsordner konnte nicht ausgewählt werden.'); }
  },
  async authorizeDirectory(): Promise<void> {
    requireSupport();
    if (!directory) throw new Error('Bitte zuerst einen Sicherungsordner auswählen.');
    try {
      // Invoke permission directly in the click handler, before awaiting anything else.
      if (await directory.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Der Zugriff wurde nicht erlaubt.');
    } catch (error) { throw describe(error, 'Der Sicherungsordner konnte nicht freigegeben werden.'); }
  },
  async forgetDirectory(): Promise<void> {
    requireSupport();
    try { await access('readwrite', store => store.delete(handleKey)); directory = null; }
    catch (error) { throw describe(error, 'Der Sicherungsordner konnte nicht entfernt werden.'); }
  },
  async saveBackup(backup: WorkspaceBackup): Promise<{ filename: string; verifiedAt: string }> {
    const dir = await requireDirectory();
    let text: string;
    try {
      text = JSON.stringify(backup);
      if (new TextEncoder().encode(text).byteLength > MAX_WORKSPACE_BACKUP_BYTES) throw new Error('Die Sicherung ist zu groß.');
      parseWorkspaceBackup(text);
    } catch (error) { throw new Error('Die Sicherung ist ungültig oder zu groß und wurde nicht geschrieben.', { cause: error }); }
    const filename = `${prefix}${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}.json`;
    try {
      try {
        await dir.getFileHandle(filename);
        throw new Error('Eine Sicherung mit diesem Namen existiert bereits.');
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
      }
      const file = await dir.getFileHandle(filename, { create: true });
      const writer = await file.createWritable();
      try { await writer.write(text); await writer.close(); }
      catch (error) { try { await writer.abort(); } catch { /* The stream may already be closed. */ } throw error; }
      const written = await file.getFile();
      if (written.size > MAX_WORKSPACE_BACKUP_BYTES) throw new Error('Die zurückgelesene Sicherung ist zu groß.');
      const actual = await written.text();
      if (actual !== text) throw new Error('Die zurückgelesene Sicherung stimmt nicht mit dem Original überein.');
      parseWorkspaceBackup(actual);
      return { filename, verifiedAt: new Date().toISOString() };
    } catch (error) { throw describe(error, 'Die Sicherung konnte nicht vollständig geschrieben und überprüft werden.'); }
  },
  async listBackups(): Promise<Array<{ name: string; lastModified: number; size: number }>> {
    const dir = await requireDirectory();
    try {
      const result: Array<{ name: string; lastModified: number; size: number }> = [];
      for await (const entry of dir.values()) {
        if (entry.kind !== 'file' || !validName(entry.name)) continue;
        const file = await (await dir.getFileHandle(entry.name)).getFile();
        if (file.size <= MAX_WORKSPACE_BACKUP_BYTES) result.push({ name: entry.name, lastModified: file.lastModified, size: file.size });
      }
      return result.sort((a, b) => b.lastModified - a.lastModified || b.name.localeCompare(a.name));
    } catch (error) { throw describe(error, 'Die Sicherungsliste konnte nicht gelesen werden.'); }
  },
  async readBackup(name: string): Promise<WorkspaceBackup> {
    if (!validName(name)) throw new Error('Ungültiger Sicherungsdateiname.');
    const dir = await requireDirectory();
    try {
      const file = await (await dir.getFileHandle(name)).getFile();
      if (file.size > MAX_WORKSPACE_BACKUP_BYTES) throw new Error('Die Sicherungsdatei ist zu groß.');
      return parseWorkspaceBackup(await file.text());
    } catch (error) { throw describe(error, 'Die Sicherung konnte nicht gelesen oder validiert werden.'); }
  },
};
