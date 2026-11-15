import type { Backup, Note, NoteRevision } from '../types';

export const MAX_BACKUP_BYTES = 20 * 1024 * 1024;

/**
 * Backups are UTF-8 JSON. Limits apply to the complete backup, including trash
 * and revision history; they are checked before an import can touch IndexedDB.
 * Text lengths are JavaScript UTF-16 code units. The complete file is limited
 * to 20 MiB in UTF-8, notes to 10,000, revisions to 100 per note, tags to 20
 * per note/revision, IDs to 128, titles to 500, tags to 64 and bodies to
 * 2,097,152 code units. Unknown properties are ignored and never persisted.
 */
export const BACKUP_LIMITS = Object.freeze({
  bytes: MAX_BACKUP_BYTES,
  notes: 10_000,
  revisions: 100,
  tags: 20,
  id: 128,
  title: 500,
  tag: 64,
  content: 2 * 1024 * 1024,
});

function invalid(path: string, message: string): never {
  throw new Error(`Ungültige Sicherung: ${path} ${message}`);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid(path, 'muss ein Objekt sein.');
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string') return invalid(path, 'muss Text enthalten.');
  if (value.length > max) {
    return invalid(path, `darf höchstens ${max.toLocaleString('de-DE')} Zeichen enthalten.`);
  }
  return value;
}

function id(value: unknown, path: string): string {
  const result = string(value, path, BACKUP_LIMITS.id);
  if (result.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(result)) {
    return invalid(path, 'muss eine nicht leere Kennung ohne Steuerzeichen sein.');
  }
  return result;
}

function timestamp(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    return invalid(path, 'muss ein gültiger ISO-Zeitstempel in UTC sein.');
  }
  const date = new Date(value);
  const expected = value.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction: string | undefined) => `.${(fraction ?? '').padEnd(3, '0')}Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== expected) {
    return invalid(path, 'muss ein gültiger ISO-Zeitstempel in UTC sein.');
  }
  return value;
}

function tags(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length > BACKUP_LIMITS.tags) {
    return invalid(path, `muss eine Liste mit höchstens ${BACKUP_LIMITS.tags} Tags sein.`);
  }
  return value.map((item: unknown, index: number) => {
    const tag = string(item, `${path}[${index + 1}]`, BACKUP_LIMITS.tag);
    if (!tag.trim()) return invalid(`${path}[${index + 1}]`, 'darf nicht leer sein.');
    return tag;
  });
}

function revision(value: unknown, path: string): NoteRevision {
  const item = object(value, path);
  return {
    id: id(item.id, `${path}.id`),
    createdAt: timestamp(item.createdAt, `${path}.createdAt`),
    title: string(item.title, `${path}.title`, BACKUP_LIMITS.title),
    content: string(item.content, `${path}.content`, BACKUP_LIMITS.content),
    tags: tags(item.tags, `${path}.tags`),
  };
}

function note(value: unknown, path: string): Note {
  const item = object(value, path);
  if (typeof item.pinned !== 'boolean') return invalid(`${path}.pinned`, 'muss wahr oder falsch sein.');
  if (!Array.isArray(item.revisions) || item.revisions.length > BACKUP_LIMITS.revisions) {
    return invalid(`${path}.revisions`, `muss eine Liste mit höchstens ${BACKUP_LIMITS.revisions} Versionen sein.`);
  }
  const revisions = item.revisions.map((entry: unknown, index: number) => revision(entry, `${path}.revisions[${index + 1}]`));
  const revisionIds = new Set<string>();
  for (const entry of revisions) {
    if (revisionIds.has(entry.id)) return invalid(`${path}.revisions`, `enthält die Kennung „${entry.id}“ mehrfach.`);
    revisionIds.add(entry.id);
  }
  return {
    id: id(item.id, `${path}.id`),
    title: string(item.title, `${path}.title`, BACKUP_LIMITS.title),
    content: string(item.content, `${path}.content`, BACKUP_LIMITS.content),
    tags: tags(item.tags, `${path}.tags`),
    pinned: item.pinned,
    createdAt: timestamp(item.createdAt, `${path}.createdAt`),
    updatedAt: timestamp(item.updatedAt, `${path}.updatedAt`),
    deletedAt: item.deletedAt === null ? null : timestamp(item.deletedAt, `${path}.deletedAt`),
    revisions,
  };
}

function notes(value: unknown): Note[] {
  if (!Array.isArray(value) || value.length > BACKUP_LIMITS.notes) {
    return invalid('notes', `muss eine Liste mit höchstens ${BACKUP_LIMITS.notes.toLocaleString('de-DE')} Notizen sein.`);
  }
  const ids = new Set<string>();
  return value.map((entry: unknown, index: number) => {
    const result = note(entry, `Notiz ${index + 1}`);
    if (ids.has(result.id)) return invalid('notes', `enthält die Kennung „${result.id}“ mehrfach.`);
    ids.add(result.id);
    return result;
  });
}

function assertSize(text: string): void {
  // A cheap guard avoids allocating a second copy for obviously oversized input.
  if (text.length > BACKUP_LIMITS.bytes || new TextEncoder().encode(text).byteLength > BACKUP_LIMITS.bytes) {
    throw new Error('Die Sicherung ist zu groß. Erlaubt sind höchstens 20 MiB einschließlich Papierkorb und Versionsverlauf.');
  }
}

/** Validate and copy a complete snapshot, retaining IDs and all history. */
export function makeBackup(value: Note[]): Backup {
  const backup: Backup = {
    format: 'nexus-notes',
    version: 1,
    exportedAt: new Date().toISOString(),
    notes: notes(value),
  };
  assertSize(JSON.stringify(backup));
  return backup;
}

/** Parse untrusted JSON without changing storage or evaluating imported content. */
export function parseBackup(text: string): Backup {
  if (typeof text !== 'string') throw new Error('Die Sicherung muss als JSON-Text vorliegen.');
  assertSize(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Die Datei enthält kein gültiges JSON. Bitte wähle eine NEXUS-Sicherung.');
  }
  const value = object(parsed, 'Datei');
  if (value.format !== 'nexus-notes') throw new Error('Das Dateiformat wird nicht unterstützt. Erwartet wird eine NEXUS-Notes-Sicherung.');
  if (value.version !== 1) throw new Error('Diese Sicherungsversion wird nicht unterstützt. Unterstützt wird Version 1.');
  return {
    format: 'nexus-notes',
    version: 1,
    exportedAt: timestamp(value.exportedAt, 'exportedAt'),
    notes: notes(value.notes),
  };
}
