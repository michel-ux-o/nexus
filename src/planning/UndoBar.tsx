import { useCallback, useEffect, useRef, useState } from 'react';
import { Info, Undo2 } from 'lucide-react';
import type { Planner } from './types';
import './UndoBar.css';

export function UndoBar({ planner, disabled = false }: { planner: Planner; disabled?: boolean }) {
  const { undo, undoState } = planner;
  const [message, setMessage] = useState('');
  const [localError, setLocalError] = useState('');
  const running = useRef(false);
  const available = Boolean(undo && undoState && (undoState.canUndo || undoState.pending));
  const blocked = disabled || !available || Boolean(undoState?.busy);

  const performUndo = useCallback(async () => {
    if (blocked || running.current || !undo) return;
    running.current = true;
    setMessage('');
    setLocalError('');
    try {
      await undo();
      setMessage('Rückgängig gemacht.');
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Rückgängig machen fehlgeschlagen.');
    } finally {
      running.current = false;
    }
  }, [blocked, undo]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z' || blocked) return;
      const target = event.target;
      if (target instanceof Element && (target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), dialog, [role="dialog"], [role="alertdialog"]') || (target instanceof HTMLElement && target.isContentEditable))) return;
      if (document.querySelector('dialog[open], [role="dialog"], [role="alertdialog"]')) return;
      event.preventDefault();
      void performUndo();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [blocked, performUndo]);

  useEffect(() => {
    setMessage('');
    setLocalError('');
  }, [undoState.label, undoState.count, undoState.pending]);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(''), 3000);
    return () => window.clearTimeout(timer);
  }, [message]);

  const error = undoState.error || localError;
  if (!undoState.label && !undoState.count && !undoState.pending && !error && !message) return null;
  const retry = undoState.pending && Boolean(error);
  return <section className="undo-bar" aria-label="Änderungen rückgängig machen">
    <div className="undo-bar-main">
      <button type="button" className="undo-bar-button" disabled={blocked} onClick={() => void performUndo()}>
        <Undo2 size={16} aria-hidden="true" />{undoState.busy ? 'Wird gespeichert …' : retry ? 'Erneut versuchen' : 'Rückgängig'}
      </button>
      <div className="undo-bar-details">
        <span className="undo-bar-label" title={undoState.label || 'Keine Änderung verfügbar'}>{undoState.label || 'Keine Änderung verfügbar'}</span>
        <span className="undo-bar-count">{undoState.count} {undoState.count === 1 ? 'Änderung' : 'Änderungen'}</span>
      </div>
      <details className="undo-bar-history">
        <summary aria-label="Hinweise zum Rückgängig-Verlauf"><Info size={15} aria-hidden="true" /><span>Verlauf</span></summary>
        <p className="undo-bar-hint">Nur für diese Sitzung: Der Verlauf endet beim Neuladen oder Import.<span>Strg/Cmd + Z macht die letzte Planungsaktion rückgängig. In Textfeldern gilt das normale Text-Undo.</span></p>
      </details>
    </div>
    <p className={`undo-bar-status${error ? ' is-error' : ''}`} role="status" aria-live="polite">{error || (undoState.busy ? 'Rückgängig machen wird gespeichert.' : message)}</p>
  </section>;
}
