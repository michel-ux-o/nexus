import { useEffect, useState, useSyncExternalStore } from 'react';
import { NotesStore } from './notesStore';

export function useNotes() {
  const [store] = useState(() => new NotesStore());
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useEffect(() => {
    store.start();
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      if (!store.hasUnsavedChanges()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeLeaving);
    return () => {
      window.removeEventListener('beforeunload', warnBeforeLeaving);
      // Best effort on unmount; browser shutdown is protected by the warning.
      void store.flush();
    };
  }, [store]);

  return {
    ...snapshot,
    selectNote: store.selectNote,
    createNote: store.createNote,
    captureNote: store.captureNote,
    updateNote: store.updateNote,
    duplicateNote: store.duplicateNote,
    trashNote: store.trashNote,
    restoreNote: store.restoreNote,
    permanentlyDelete: store.permanentlyDelete,
    flush: store.flush,
    retry: store.retry,
    reload: store.reload,
    applyAI: store.applyAI,
    restoreRevision: store.restoreRevision,
    setBlocked: store.setBlocked,
  };
}
