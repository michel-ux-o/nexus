import type { WorkspaceBackup } from '../planning/types';
import type { WorkspaceMergeConflict } from './merge';

export type SyncStatus = 'local' | 'offline' | 'pending' | 'syncing' | 'synced' | 'conflict' | 'error';

export interface RemoteWorkspace {
  revision: number;
  snapshot: WorkspaceBackup | null;
  committedAt: string | null;
}

/** This exact body is committed locally before its first network attempt. */
export interface SyncMutation {
  expectedRevision: number;
  mutationId: string;
  snapshot: WorkspaceBackup;
}

export interface SyncCommitResult {
  revision: number;
  committedAt: string;
  replayed: boolean;
}

export interface SyncConflict {
  base: WorkspaceBackup | null;
  local: WorkspaceBackup;
  remote: WorkspaceBackup;
  revision: number;
  committedAt: string | null;
  items: WorkspaceMergeConflict[];
}

/** Both complete copies survive an explicit whole-workspace choice. */
export interface SyncRecoveryBackup {
  choice: 'local' | 'remote';
  resolvedAt: string;
  base: WorkspaceBackup | null;
  local: WorkspaceBackup;
  remote: WorkspaceBackup | null;
}

export interface SyncMetadata {
  version: 1;
  accountId: string;
  base: RemoteWorkspace | null;
  pending: SyncMutation | null;
  conflict: SyncConflict | null;
  recovery: SyncRecoveryBackup | null;
}

export interface SyncState {
  status: SyncStatus;
  error: string | null;
  conflict: SyncConflict | null;
  lastSyncedAt: string | null;
  revision: number | null;
}

export interface SyncRepository {
  readSyncedWorkspace<T>(): Promise<{ workspace: WorkspaceBackup; syncState: T | null }>;
  compareAndSetSyncState<T>(expected: T | null, next: T): Promise<boolean>;
  applySyncedWorkspace<T>(expected: WorkspaceBackup, next: WorkspaceBackup, syncState: T, expectedSyncState?: T | null): Promise<boolean>;
}

export interface SyncTransport {
  /** Transport must also bind requests to this identity (X-Nexus-Account). */
  get(accountId: string, signal: AbortSignal): Promise<RemoteWorkspace>;
  put(accountId: string, mutation: SyncMutation, signal: AbortSignal): Promise<SyncCommitResult>;
}

export interface SyncControllerOptions {
  accountId: string;
  getAccountId: () => string | null;
  repository: SyncRepository;
  transport: SyncTransport;
  /** False while any editor/dialog contains a draft or a local operation runs. */
  canRun: () => boolean;
  /** Lock editors, flush both stores, invoke work, then unlock in finally. No network runs inside work. */
  withLocalLock: <T>(work: () => Promise<T>) => Promise<T | undefined>;
  /** Reload both stores while withLocalLock still owns the local write lease. */
  onApplied: () => Promise<void>;
  isOnline?: () => boolean;
  isLocalEmpty?: (workspace: WorkspaceBackup) => boolean;
  onStatus?: (state: SyncState) => void;
  createMutationId?: () => string;
  now?: () => string;
  pollIntervalMs?: number;
  debounceMs?: number;
}

export interface SyncController {
  start(): void;
  /** Disposes this account-bound controller permanently; a new lifecycle needs a new instance. */
  stop(): void;
  syncNow(): Promise<void>;
  notifyLocalCommit(): void;
  notifySafe(): void;
  resolveConflict(choice: 'local' | 'remote'): Promise<void>;
  getRecoveryBackup(): Promise<SyncRecoveryBackup | null>;
  getState(): SyncState;
  subscribe(listener: () => void): () => void;
}
