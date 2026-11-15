export interface WorkspaceScope {
  readonly key: string;
  readonly userId: string | null;
  readonly databaseName: string;
  readonly backupDatabaseName: string;
  readonly writerLockName: string;
}

const LOCAL_SCOPE: WorkspaceScope = Object.freeze({
  key: 'local', userId: null, databaseName: 'nexus-notes',
  backupDatabaseName: 'nexus-backup-access', writerLockName: 'nexus-notes-writer',
});

export class WorkspaceScopeChangeError extends Error {
  constructor() {
    super('Das Konto wurde gewechselt. Bitte öffne Nexus erneut, damit keine Daten verschiedener Konten vermischt werden.');
    this.name = 'WorkspaceScopeChangeError';
  }
}

/** A document keeps one identity for its entire lifetime, including queued writes. */
export function createWorkspaceScopeController(local: boolean) {
  let scope: WorkspaceScope | null = local ? LOCAL_SCOPE : null;
  return {
    selectAccount(userId: unknown): WorkspaceScope {
      if (typeof userId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
        throw new Error('Die bestätigte Kontokennung fehlt oder ist ungültig. Bitte melde dich erneut an.');
      }
      const id = userId.toLowerCase();
      if (scope && scope.userId !== id) throw new WorkspaceScopeChangeError();
      scope ??= Object.freeze({
        key: `account:${id}`, userId: id, databaseName: `nexus-account-${id}`,
        backupDatabaseName: `nexus-backup-access-${id}`, writerLockName: `nexus-notes-writer-${id}`,
      });
      return scope;
    },
    get(): WorkspaceScope {
      if (!scope) throw new Error('Der Arbeitsbereich darf erst nach bestätigter Anmeldung geöffnet werden.');
      return scope;
    },
  };
}

// Node-based data tests and local-only installations retain the established DB.
// Public origins and explicitly enabled local cloud previews start without one.
const local = typeof location === 'undefined'
  || (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) && import.meta.env.VITE_NEXUS_CLOUD_MODE !== '1');
const controller = createWorkspaceScopeController(local);
export const selectAccountWorkspace = controller.selectAccount;
export const getWorkspaceScope = controller.get;
