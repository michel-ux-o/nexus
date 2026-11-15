import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Download, X } from 'lucide-react';
import './PlanningComponents.css';

interface PlanningDialogProps {
  title: string;
  eyebrow: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
  footer: ReactNode;
}

/** A native modal keeps focus inside the panel, including on touch devices. */
export function PlanningDialog({ title, eyebrow, busy, onClose, onSubmit, children, footer }: PlanningDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    if (dialog && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLElement>('.planning-inputs input, .planning-inputs select, .planning-inputs textarea')?.focus({ preventScroll: true });
    }
    return () => {
      if (dialog?.open) dialog.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  return (
    <dialog ref={dialogRef} className="dialog planning-dialog" aria-labelledby={heading} aria-busy={busy}
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
      <form className="planning-dialog-form" onSubmit={onSubmit}>
        <header className="planning-dialog-header">
          <div><p className="eyebrow">{eyebrow}</p><h2 id={heading}>{title}</h2></div>
          <button type="button" className="secondary-button planning-close" aria-label={`${title} schließen`} disabled={busy} onClick={onClose}>
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <div className="planning-dialog-body">{children}</div>
        <footer className="planning-dialog-footer">{footer}</footer>
      </form>
    </dialog>
  );
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Der Vorgang konnte nicht abgeschlossen werden.';
}

export function SaveFailure({ error, draft, filename }: { error: string; draft: string; filename: string }) {
  const [downloadError, setDownloadError] = useState('');
  const backupRef = useRef<HTMLTextAreaElement>(null);
  if (!error) return null;

  function download() {
    try {
      const url = URL.createObjectURL(new Blob([draft], { type: 'text/plain;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${filename}.txt`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDownloadError('');
    } catch {
      setDownloadError('Der Download war nicht möglich. Öffne den Entwurf unten und kopiere ihn als Text.');
    }
  }

  return <section className="planning-save-error" aria-label="Speicherfehler und Entwurfssicherung">
    <p role="alert"><strong>Nicht gespeichert.</strong> {error} Dein Entwurf bleibt hier erhalten.</p>
    <button type="button" className="secondary-button" onClick={download}><Download size={16} aria-hidden="true" /> Entwurf als Text sichern</button>
    {downloadError && <p role="alert">{downloadError}</p>}
    <details><summary>Entwurf zum Kopieren anzeigen</summary>
      <label className="field"><span>Vollständiger Entwurf · nur zum Kopieren</span><textarea ref={backupRef} readOnly rows={8} value={draft} onFocus={(event) => event.currentTarget.select()} /></label>
      <button type="button" className="secondary-button" onClick={() => { backupRef.current?.focus(); backupRef.current?.select(); }}>Gesamten Entwurf markieren</button>
    </details>
  </section>;
}

export function DeleteConfirmation({ noun, details, busy, onCancel, onConfirm }: {
  noun: string; details: string; busy: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  return <section className="planning-delete-confirm" aria-label={`${noun} löschen bestätigen`}>
    <p><strong>{noun} wirklich löschen?</strong> {details}</p>
    <div className="planning-button-row">
      <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>Behalten</button>
      <button type="button" className="danger-button" disabled={busy} onClick={onConfirm}>{busy ? 'Wird gelöscht …' : `Ja, ${noun} löschen`}</button>
    </div>
  </section>;
}
