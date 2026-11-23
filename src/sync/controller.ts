import { makeWorkspaceBackup, parseWorkspaceBackup } from '../data/workspaceBackup';
import { emptyPlanning } from '../planning/types';
import type { WorkspaceBackup } from '../planning/types';
import { mergeWorkspaceSnapshots, withLocalSyncPreferences, workspaceContentEqual } from './merge';
import type {
  RemoteWorkspace, SyncConflict, SyncController, SyncControllerOptions,
  SyncMetadata, SyncMutation, SyncRecoveryBackup, SyncState, SyncStatus,
} from './types';

class CancelledSync extends Error {}

function httpStatus(error: unknown): number | null {
  return typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
    ? error.status : null;
}

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function snapshot(value: WorkspaceBackup): WorkspaceBackup {
  return parseWorkspaceBackup(JSON.stringify(value));
}

function validateRemote(value: RemoteWorkspace): RemoteWorkspace {
  if (!value || !validRevision(value.revision)
    || (value.committedAt !== null && (typeof value.committedAt !== 'string' || !Number.isFinite(Date.parse(value.committedAt))))
    || (value.snapshot === null && value.revision !== 0)) {
    throw new Error('Der Sync-Dienst hat einen ungültigen Arbeitsbereich geliefert. Deine lokalen Daten bleiben erhalten.');
  }
  return { revision: value.revision, committedAt: value.committedAt, snapshot: value.snapshot === null ? null : snapshot(value.snapshot) };
}

/** New installations must fetch the account workspace before publishing defaults. */
export function isEmptySyncWorkspace(workspace: WorkspaceBackup): boolean {
  return workspaceContentEqual(workspace, makeWorkspaceBackup([], emptyPlanning()));
}

/**
 * The repository owns durability/CAS, the host owns editor safety, and the
 * transport owns HTTP identity binding. No network request holds the UI lease.
 */
export function createSyncController(options: SyncControllerOptions): SyncController {
  const accountId = options.accountId;
  if (!accountId) throw new Error('Für den Abgleich fehlt die bestätigte Kontokennung.');
  const now = options.now ?? (() => new Date().toISOString());
  const isOnline = options.isOnline ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false);
  const isEmpty = options.isLocalEmpty ?? isEmptySyncWorkspace;
  const createMutationId = options.createMutationId ?? (() => crypto.randomUUID());
  const listeners = new Set<() => void>();
  let state: SyncState = { status: 'local', error: null, conflict: null, lastSyncedAt: null, revision: null };
  let running: Promise<void> | null = null;
  let requested = false;
  let started = false;
  let stopped = false;
  let identityFailed = false;
  let authenticationFailed = false;
  let localEpoch = 0;
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;

  function publish(status: SyncStatus, patch: Partial<Omit<SyncState, 'status'>> = {}): void {
    state = { ...state, status, error: null, ...patch };
    options.onStatus?.(state);
    for (const listener of listeners) listener();
  }

  function assertIdentity(): void {
    if (stopped || identityFailed) throw new CancelledSync();
    if (options.getAccountId() !== accountId) {
      identityFailed = true;
      abort.abort();
      publish('error', { error: 'Das Konto wurde gewechselt. Bitte lade Nexus neu, bevor du weiter synchronisierst.' });
      throw new CancelledSync();
    }
  }

  function blankMetadata(): SyncMetadata {
    return { version: 1, accountId, base: null, pending: null, conflict: null, recovery: null };
  }

  function validateMetadata(value: SyncMetadata | null): SyncMetadata {
    if (value === null) return blankMetadata();
    if (value.version !== 1 || value.accountId !== accountId
      || !('base' in value) || !('pending' in value) || !('conflict' in value) || !('recovery' in value)) {
      throw new Error('Die gespeicherte Sync-Zuordnung passt nicht zu diesem Konto. Es werden keine Daten übertragen.');
    }
    if (value.base) validateRemote(value.base);
    if (value.pending) {
      if (typeof value.pending.mutationId !== 'string' || !value.pending.mutationId
        || !validRevision(value.pending.expectedRevision) || !value.base
        || value.pending.expectedRevision !== value.base.revision) {
        throw new Error('Der ausstehende Sync-Auftrag ist ungültig. Die lokale Sicherung bleibt erhalten.');
      }
      snapshot(value.pending.snapshot);
    }
    return value;
  }

  async function read() {
    assertIdentity();
    const value = await options.repository.readSyncedWorkspace<SyncMetadata>();
    assertIdentity();
    return { workspace: value.workspace, expected: value.syncState, metadata: validateMetadata(value.syncState) };
  }

  async function save(expected: SyncMetadata | null, next: SyncMetadata): Promise<boolean> {
    assertIdentity();
    const result = await options.repository.compareAndSetSyncState(expected, structuredClone(next));
    assertIdentity();
    return result;
  }

  async function getRemote(): Promise<RemoteWorkspace> {
    assertIdentity();
    const result = await options.transport.get(accountId, abort.signal);
    assertIdentity();
    return validateRemote(result);
  }

  function pendingFor(remote: RemoteWorkspace, workspace: WorkspaceBackup): SyncMutation | null {
    if (remote.snapshot ? workspaceContentEqual(workspace, remote.snapshot) : isEmpty(workspace)) return null;
    return { expectedRevision: remote.revision, mutationId: createMutationId(), snapshot: structuredClone(workspace) };
  }

  function makeConflict(metadata: SyncMetadata, local: WorkspaceBackup, remote: RemoteWorkspace): SyncConflict | null {
    if (!remote.snapshot) return null;
    const merged = mergeWorkspaceSnapshots(metadata.base?.snapshot ?? null, local, remote.snapshot);
    return merged.conflicts.length ? {
      base: structuredClone(metadata.base?.snapshot ?? null), local: structuredClone(local),
      remote: structuredClone(remote.snapshot), revision: remote.revision, committedAt: remote.committedAt,
      items: merged.conflicts,
    } : null;
  }

  async function acknowledgePending(value: Awaited<ReturnType<typeof read>>): Promise<void> {
    const pending = value.metadata.pending!;
    assertIdentity();
    try {
      // Give the transport a copy; retries always use the durable original.
      const result = await options.transport.put(accountId, structuredClone(pending), abort.signal);
      assertIdentity();
      if (result.revision !== pending.expectedRevision + 1 || typeof result.replayed !== 'boolean'
        || typeof result.committedAt !== 'string' || !Number.isFinite(Date.parse(result.committedAt))) {
        throw new Error('Der Sync-Dienst hat den Auftrag nicht eindeutig bestätigt. Er bleibt für einen sicheren erneuten Versuch gespeichert.');
      }
      await save(value.expected, {
        ...value.metadata, pending: null,
        base: { revision: result.revision, snapshot: pending.snapshot, committedAt: result.committedAt },
      });
    } catch (error) {
      if (httpStatus(error) !== 409) throw error;
      // A revision rejection is definite. Ambiguous network/5xx failures never
      // clear this immutable request, including after closing/reloading the app.
      await save(value.expected, { ...value.metadata, pending: null });
    }
  }

  async function reportCurrent(remote: RemoteWorkspace): Promise<void> {
    const epoch = localEpoch;
    const latest = await read();
    if (latest.metadata.conflict) {
      publish('conflict', { conflict: structuredClone(latest.metadata.conflict), revision: latest.metadata.conflict.revision });
    } else if (latest.metadata.pending || epoch !== localEpoch || !options.canRun()) {
      publish('pending', { conflict: null, revision: remote.revision });
    } else if (remote.snapshot && latest.metadata.base?.revision === remote.revision
      && workspaceContentEqual(latest.workspace, remote.snapshot)) {
      publish('synced', { conflict: null, revision: remote.revision, lastSyncedAt: now() });
    } else {
      publish(remote.snapshot ? 'pending' : 'local', { conflict: null, revision: remote.revision });
    }
  }

  /** Returns true when another cycle is needed; only local graph changes take a lease. */
  async function reconcile(remote: RemoteWorkspace): Promise<boolean> {
    const current = await read();
    if (current.metadata.pending) return true;
    if (current.metadata.conflict) {
      publish('conflict', { conflict: structuredClone(current.metadata.conflict), revision: current.metadata.conflict.revision });
      return false;
    }
    const base = current.metadata.base;
    if (base && (remote.revision < base.revision
      || (remote.revision === base.revision && !workspaceContentEqual(remote.snapshot, base.snapshot)))) {
      throw new Error('Der Serverstand widerspricht dem zuletzt bestätigten Stand. Die lokalen Daten bleiben unverändert.');
    }
    if (!options.canRun()) { publish('pending'); return false; }

    const localIsNew = base === null && isEmpty(current.workspace);
    const merged = remote.snapshot
      ? localIsNew ? { workspace: withLocalSyncPreferences(remote.snapshot, current.workspace), conflicts: [] }
        : mergeWorkspaceSnapshots(base?.snapshot ?? null, current.workspace, remote.snapshot)
      : { workspace: current.workspace, conflicts: [] };
    if (merged.conflicts.length || !merged.workspace) {
      const conflict = makeConflict(current.metadata, current.workspace, remote);
      if (!conflict) throw new Error('Der Arbeitsbereich konnte nicht sicher zusammengeführt werden.');
      if (!await save(current.expected, { ...current.metadata, conflict })) return true;
      publish('conflict', { conflict: structuredClone(conflict), revision: remote.revision });
      return false;
    }

    if (workspaceContentEqual(merged.workspace, current.workspace)) {
      const pending = pendingFor(remote, merged.workspace);
      if (!await save(current.expected, { ...current.metadata, base: remote, pending })) return true;
      if (pending) { publish('pending', { revision: remote.revision, conflict: null }); return true; }
      await reportCurrent(remote);
      return false;
    }

    // Flushes performed by the host can reveal newer committed local changes.
    // Re-read and merge those changes while editors are blocked, then CAS both
    // graph and metadata to protect writes from other windows as well.
    const applied = await options.withLocalLock(async () => {
      const latest = await read();
      if (latest.metadata.pending || latest.metadata.conflict) return 'retry' as const;
      if (JSON.stringify(latest.expected) !== JSON.stringify(current.expected)) return 'retry' as const;
      const fresh = latest.metadata.base === null && isEmpty(latest.workspace)
        ? { workspace: withLocalSyncPreferences(remote.snapshot!, latest.workspace), conflicts: [] }
        : mergeWorkspaceSnapshots(latest.metadata.base?.snapshot ?? null, latest.workspace, remote.snapshot!);
      if (!fresh.workspace || fresh.conflicts.length) {
        const conflict = makeConflict(latest.metadata, latest.workspace, remote)!;
        if (!await save(latest.expected, { ...latest.metadata, conflict })) return 'retry' as const;
        publish('conflict', { conflict: structuredClone(conflict), revision: remote.revision });
        return 'conflict' as const;
      }
      const pending = pendingFor(remote, fresh.workspace);
      const next = { ...latest.metadata, base: remote, pending };
      assertIdentity();
      const changed = await options.repository.applySyncedWorkspace(latest.workspace, fresh.workspace, next, latest.expected);
      assertIdentity();
      if (!changed) return 'retry' as const;
      await options.onApplied();
      assertIdentity();
      return pending ? 'pending' as const : 'applied' as const;
    });
    assertIdentity();
    if (applied === undefined) { publish('pending'); return false; }
    if (applied === 'conflict') return false;
    if (applied === 'retry' || applied === 'pending') return true;
    await reportCurrent(remote);
    return false;
  }

  async function synchronize(): Promise<void> {
    // Bound continuous races; the next poll/commit resumes without blocking UI.
    for (let pass = 0; pass < 12; pass++) {
      assertIdentity();
      if (!isOnline()) { publish('offline'); return; }
      if (!options.canRun()) { publish(state.conflict ? 'conflict' : 'pending'); return; }
      const current = await read();
      if (current.metadata.conflict) {
        publish('conflict', { conflict: structuredClone(current.metadata.conflict), revision: current.metadata.conflict.revision });
        return;
      }
      publish('syncing', { conflict: null, revision: current.metadata.base?.revision ?? null });
      if (current.metadata.pending) {
        await acknowledgePending(current);
        continue;
      }
      const remote = await getRemote();
      if (!await reconcile(remote)) return;
    }
    publish('pending');
    if (started) schedule();
  }

  function handleError(error: unknown): void {
    if (error instanceof CancelledSync || stopped || identityFailed) return;
    if (httpStatus(error) === 401) authenticationFailed = true;
    publish(!isOnline() ? 'offline' : 'error', {
      error: authenticationFailed ? 'Die Anmeldung ist abgelaufen. Bitte melde dich erneut an. Dein lokaler Stand bleibt erhalten.'
        : error instanceof Error ? error.message : 'Der Abgleich ist fehlgeschlagen. Dein lokaler Stand bleibt erhalten.',
    });
  }

  function schedule(): void {
    if (timer !== null) clearTimeout(timer);
    if (stopped || authenticationFailed || identityFailed) return;
    timer = setTimeout(() => { timer = null; void syncNow(); }, options.debounceMs ?? 700);
  }

  function syncNow(): Promise<void> {
    if (stopped || authenticationFailed || identityFailed) return Promise.resolve();
    if (running) { requested = true; return running; }
    running = (async () => {
      do {
        requested = false;
        await synchronize();
      } while (requested && !stopped && !identityFailed && !authenticationFailed);
    })().catch(handleError).finally(() => { running = null; });
    return running;
  }

  async function resolveConflict(choice: 'local' | 'remote'): Promise<void> {
    while (running) await running;
    if (stopped || authenticationFailed || identityFailed) return;
    running = (async () => {
      assertIdentity();
      if (!isOnline()) { publish('offline'); return; }
      if (!options.canRun()) {
        publish('conflict', { error: 'Bitte schließe zuerst offene Eingaben, bevor du den gesamten Arbeitsbereich auswählst.' });
        return;
      }
      const remote = await getRemote();
      const result = await options.withLocalLock(async () => {
        const current = await read();
        if (!current.metadata.conflict || current.metadata.pending) return false;
        const preview = current.metadata.conflict;
        if (!remote.snapshot || remote.revision < preview.revision) {
          throw new Error('Der Cloud-Stand wurde unerwartet zurückgesetzt. Bitte sichere beide Fassungen, bevor du fortfährst.');
        }
        if (remote.revision !== preview.revision || !workspaceContentEqual(remote.snapshot, preview.remote)
          || !workspaceContentEqual(current.workspace, preview.local)) {
          const merged = mergeWorkspaceSnapshots(current.metadata.base?.snapshot ?? null, current.workspace, remote.snapshot);
          const conflict: SyncConflict = {
            base: structuredClone(current.metadata.base?.snapshot ?? null), local: structuredClone(current.workspace),
            remote: structuredClone(remote.snapshot), revision: remote.revision, committedAt: remote.committedAt,
            items: merged.conflicts.length ? merged.conflicts : [{
              path: 'workspace.review', label: 'Arbeitsbereich inzwischen geändert – bitte beide Fassungen erneut prüfen.',
              base: current.metadata.base?.snapshot ?? null, local: current.workspace, remote: remote.snapshot,
            }],
          };
          if (!await save(current.expected, { ...current.metadata, conflict })) return false;
          publish('conflict', {
            conflict: structuredClone(conflict), revision: remote.revision,
            error: 'Der Geräte- oder Cloud-Stand hat sich inzwischen geändert. Bitte prüfe beide Fassungen und bestätige deine Auswahl erneut.',
          });
          return 'review' as const;
        }
        const recovery: SyncRecoveryBackup = {
          choice, resolvedAt: now(), base: structuredClone(current.metadata.base?.snapshot ?? null),
          local: structuredClone(current.workspace), remote: structuredClone(remote.snapshot),
        };
        const selected = choice === 'local' ? current.workspace
          : withLocalSyncPreferences(remote.snapshot ?? makeWorkspaceBackup([], emptyPlanning()), current.workspace);
        const next: SyncMetadata = {
          ...current.metadata, base: remote, conflict: null, recovery,
          pending: choice === 'local' ? pendingFor(remote, selected) : null,
        };
        assertIdentity();
        const applied = await options.repository.applySyncedWorkspace(current.workspace, selected, next, current.expected);
        assertIdentity();
        if (!applied) return false;
        await options.onApplied();
        assertIdentity();
        return true;
      });
      assertIdentity();
      if (result === 'review') return;
      if (result === true) {
        publish('pending', { conflict: null, revision: remote.revision });
        await synchronize();
      } else {
        const current = await read();
        publish(current.metadata.conflict ? 'conflict' : 'pending', {
          conflict: structuredClone(current.metadata.conflict),
          error: 'Der lokale Stand hat sich geändert. Bitte prüfe die Auswahl und versuche es erneut.',
        });
      }
    })().catch(handleError).finally(() => { running = null; });
    return running;
  }

  const onWake = () => { void syncNow(); };
  return {
    start() {
      if (started || stopped || identityFailed || authenticationFailed) return;
      started = true;
      poll = setInterval(onWake, options.pollIntervalMs ?? 15_000);
      if (typeof window !== 'undefined') { window.addEventListener('online', onWake); window.addEventListener('focus', onWake); }
      void syncNow();
    },
    stop() {
      stopped = true;
      started = false;
      requested = false;
      abort.abort();
      if (timer !== null) clearTimeout(timer);
      if (poll !== null) clearInterval(poll);
      timer = null;
      poll = null;
      if (typeof window !== 'undefined') { window.removeEventListener('online', onWake); window.removeEventListener('focus', onWake); }
    },
    syncNow,
    notifyLocalCommit() {
      localEpoch++;
      if (stopped || identityFailed || authenticationFailed) return;
      publish(state.conflict ? 'conflict' : isOnline() ? 'pending' : 'offline');
      schedule();
    },
    notifySafe: schedule,
    resolveConflict,
    async getRecoveryBackup() { return structuredClone((await read()).metadata.recovery); },
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
