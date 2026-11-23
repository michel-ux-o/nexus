import { useEffect, useRef, useState } from 'react';
import { createSyncController } from './controller';
import type { SyncController, SyncControllerOptions, SyncState } from './types';
import { repository } from '../data/repository';
import { workspaceTransport } from './transport';
import { LOCAL_SYNC } from './SyncContext';

type Integration = Pick<SyncControllerOptions, 'canRun' | 'withLocalLock' | 'onApplied'>;
export function useWorkspaceSync(accountId: string | null, active: boolean, integration: Integration, commitToken: unknown) {
  const latest = useRef({ accountId, active, integration });
  latest.current = { accountId, active, integration };
  const [state, setState] = useState<SyncState>(LOCAL_SYNC);
  const [controller, setController] = useState<SyncController | null>(null);
  useEffect(() => {
    if (!accountId) { setState(LOCAL_SYNC); return; }
    const sync = createSyncController({
      accountId, repository, transport: workspaceTransport,
      getAccountId: () => latest.current.active ? latest.current.accountId : null,
      canRun: () => latest.current.active && latest.current.integration.canRun(),
      withLocalLock: work => latest.current.integration.withLocalLock(work),
      onApplied: () => latest.current.integration.onApplied(),
      onStatus: setState,
    });
    setController(sync); sync.start();
    const wake = () => sync.notifySafe();
    window.addEventListener('online', wake); window.addEventListener('focus', wake);
    document.addEventListener('focusout', wake);
    return () => {
      sync.stop();
      window.removeEventListener('online', wake); window.removeEventListener('focus', wake);
      document.removeEventListener('focusout', wake);
    };
  }, [accountId]);
  useEffect(() => { controller?.notifyLocalCommit(); }, [controller, commitToken]);
  useEffect(() => { controller?.notifySafe(); }, [controller, active]);
  return { state, controller };
}
