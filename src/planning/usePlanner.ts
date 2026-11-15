import { useEffect, useState, useSyncExternalStore } from 'react';
import { PlannerStore } from './plannerStore';
import type { Planner } from './types';

export function usePlanner(): Planner {
  const [store] = useState(() => new PlannerStore());
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    store.start();
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      if (!store.hasUnsavedChanges()) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeLeaving);
    return () => { window.removeEventListener('beforeunload', warnBeforeLeaving); void store.flush(); };
  }, [store]);
  return { ...snapshot, undo: store.undo, update: store.update, saveTask: store.saveTask, deleteTask: store.deleteTask,
    setTaskStatus: store.setTaskStatus, moveTask: store.moveTask, saveAppointment: store.saveAppointment,
    deleteAppointment: store.deleteAppointment, saveTimeBlock: store.saveTimeBlock, deleteTimeBlock: store.deleteTimeBlock,
    updateDay: store.updateDay, updateWeek: store.updateWeek, updateSettings: store.updateSettings,
    commitCapture: store.commitCapture, undoCapture: store.undoCapture, flush: store.flush, retry: store.retry,
    reload: store.reload, setBlocked: store.setBlocked, saveTaskRule: store.saveTaskRule,
    materializeRecurring: store.materializeRecurring, materializeMorningRoutine: store.materializeMorningRoutine,
    skipMorningRoutine: store.skipMorningRoutine, saveReminder: store.saveReminder, deleteReminder: store.deleteReminder,
    acknowledgeReminder: store.acknowledgeReminder, markReminderNotified: store.markReminderNotified };
}
