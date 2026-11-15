import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import './WorkspaceDialog.css';

interface WorkspaceDialogProps {
  title: string;
  eyebrow?: string;
  busy?: boolean;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}

/** Native modal semantics keep focus inside; closing restores the initiating control. */
export function WorkspaceDialog({ title, eyebrow, busy = false, className = '', onClose, children }: WorkspaceDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previousFocus = document.activeElement;
    if (dialog && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLElement>('[data-initial-focus]')?.focus({ preventScroll: true });
    }
    return () => {
      if (dialog?.open) dialog.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={ref} className={`nexus-workspace-dialog ${className}`} aria-labelledby={titleId} aria-busy={busy}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="nexus-dialog-heading"><div>{eyebrow && <p>{eyebrow}</p>}<h2 id={titleId}>{title}</h2></div>
      <button type="button" className="nexus-dialog-close" aria-label={`${title} schließen`} disabled={busy} onClick={onClose}><X size={19} aria-hidden="true" /></button>
    </header>
    {children}
  </dialog>;
}
