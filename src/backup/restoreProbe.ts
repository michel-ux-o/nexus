import { parseWorkspaceBackup } from '../data/workspaceBackup';
import { createRepository } from '../data/repository';
import type { WorkspaceBackup } from '../planning/types';

export interface RestoreProbeResult {
  checkedAt: string;
  notes: number;
  tasks: number;
  appointments: number;
  timeBlocks: number;
  reminders: number;
  rules: number;
  verified: true;
  cleanupWarning?: string;
}

// IndexedDB returns notes in primary-key order; object property order is immaterial.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}
function graph(backup: WorkspaceBackup): string {
  const { exportedAt: _exportedAt, ...data } = backup;
  return JSON.stringify(canonical({ ...data, notes: [...data.notes].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) }));
}

function deleteProbe(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error('Die isolierte Prüfdatenbank konnte nicht gelöscht werden.'));
    request.onblocked = () => reject(new Error('Das Löschen der isolierten Prüfdatenbank ist blockiert.'));
  });
}

export async function probeWorkspaceRestore(input: string | WorkspaceBackup): Promise<RestoreProbeResult> {
  const backup = parseWorkspaceBackup(typeof input === 'string' ? input : JSON.stringify(input));
  const expected = structuredClone(backup);
  // The repository's explicit replace import completes onboarding by design.
  expected.planning.settings.onboardingDone = true;
  const name = `nexus-restore-probe-${crypto.randomUUID()}`;
  const writer = createRepository(name);
  let reader: ReturnType<typeof createRepository> | undefined;
  let result: RestoreProbeResult | undefined;
  let failure: unknown;
  let cleanupFailed = false;
  try {
    await writer.importWorkspace(backup, 'replace');
    await writer.close();
    reader = createRepository(name);
    const exported = await reader.exportWorkspace();
    const restored = parseWorkspaceBackup(JSON.stringify(exported));
    if (graph(restored) !== graph(expected)) throw new Error('Die wiederhergestellten Daten stimmen nicht mit der geprüften Sicherung überein.');
    result = { checkedAt: new Date().toISOString(), notes: restored.notes.length, tasks: restored.planning.tasks.length, appointments: restored.planning.appointments.length, timeBlocks: restored.planning.timeBlocks.length, reminders: restored.planning.reminders!.length, rules: restored.planning.taskRules!.length, verified: true };
  } catch (error) { failure = error; }
  finally {
    try { await writer.close(); } catch { cleanupFailed = true; }
    try { await reader?.close(); } catch { cleanupFailed = true; }
    try { await deleteProbe(name); } catch { cleanupFailed = true; }
  }
  if (failure !== undefined) {
    if (cleanupFailed) throw new Error('Wiederherstellungsprobe fehlgeschlagen; die isolierte Prüfdatenbank konnte möglicherweise nicht bereinigt werden.', { cause: failure });
    throw failure;
  }
  if (!result) throw new Error('Die Wiederherstellungsprobe lieferte kein Ergebnis.');
  if (cleanupFailed) result.cleanupWarning = 'Die isolierte Prüfdatenbank konnte möglicherweise nicht bereinigt werden.';
  return result;
}
