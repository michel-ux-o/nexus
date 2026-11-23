import { parseWorkspaceBackup } from '../data/workspaceBackup';
import type { SyncTransport } from './types';

export class SyncHttpError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

async function request(accountId: string, signal: AbortSignal, body?: unknown) {
  const timeout = new AbortController();
  const cancel = () => timeout.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) timeout.abort();
  const timer = setTimeout(cancel, 40_000);
  try {
  const response = await fetch('/api/workspace', {
    method: body === undefined ? 'GET' : 'PUT', credentials: 'same-origin',
    cache: 'no-store', redirect: 'error', signal: timeout.signal,
    headers: { 'x-nexus-client': '1', 'X-Nexus-Account': accountId, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new SyncHttpError(value?.error || 'Die Synchronisierung ist gerade nicht erreichbar.', value?.code === 'ACCOUNT_CHANGED' ? 401 : response.status);
  if (!value || value.accountId !== accountId || !Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new SyncHttpError('Die Synchronisierungsantwort gehört nicht zum geöffneten Konto oder ist ungültig.', 401);
  }
  return value;
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', cancel);
  }
}

export const workspaceTransport: SyncTransport = {
  async get(accountId, signal) {
    const value = await request(accountId, signal);
    if ((value.revision === 0) !== (value.snapshot === null)) throw new Error('Ungültiger Cloud-Datenstand. Lokale Daten bleiben erhalten.');
    return { revision: value.revision, snapshot: value.snapshot === null ? null : parseWorkspaceBackup(JSON.stringify(value.snapshot)), committedAt: value.committedAt };
  },
  async put(accountId, mutation, signal) {
    const value = await request(accountId, signal, mutation);
    if (value.revision < 1 || typeof value.committedAt !== 'string' || typeof value.replayed !== 'boolean') throw new Error('Die Speicherung wurde nicht eindeutig bestätigt.');
    return { revision: value.revision, committedAt: value.committedAt, replayed: value.replayed };
  },
};
