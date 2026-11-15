import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, BookOpen, Layers3, ShieldCheck } from 'lucide-react';
import type { Planner } from '../planning/types';
import './Onboarding.css';

interface OnboardingProps { planner: Planner; onEmpty: () => Promise<void>; onDemo: () => Promise<void> }

/** The App displays this only for a genuinely new and empty workspace. */
export function Onboarding({ planner, onEmpty, onDemo }: OnboardingProps) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const running = useRef(false);
  const mounted = useRef(true);
  const [choice, setChoice] = useState<'empty' | 'demo' | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { mounted.current = false; if (dialog?.open) dialog.close(); };
  }, []);
  async function choose(value: 'empty' | 'demo'): Promise<void> {
    if (running.current || planner.loading || planner.loadError) return;
    running.current = true; setChoice(value); setError(null);
    try { await (value === 'empty' ? onEmpty() : onDemo()); }
    catch (cause) { if (mounted.current) setError(`Der Arbeitsbereich konnte nicht geöffnet werden. ${cause instanceof Error ? cause.message : 'Bitte versuche es erneut.'}`); }
    finally { running.current = false; if (mounted.current) setChoice(null); }
  }
  const disabled = choice !== null || planner.loading || !!planner.loadError;
  return <dialog ref={dialogRef} className="dialog onboarding-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-intro`} onCancel={(event) => event.preventDefault()}>
    <div className="onboarding-content">
      <div className="onboarding-mark" aria-hidden="true"><Layers3 size={32} /></div>
      <p className="eyebrow">NEXUS · Dein neuer Arbeitsbereich</p>
      <h1 id={`${id}-title`}>Raum für deine Gedanken.<br />Klarheit für deinen Tag.</h1>
      <p id={`${id}-intro`}>Notizen, Aufgaben und Zeitplanung an einem Ort. Wie möchtest du beginnen?</p>
      {error && <p className="onboarding-error" role="alert">{error}</p>}
      {planner.loadError && <p className="onboarding-error" role="alert">{planner.loadError}</p>}
      <div className="onboarding-choices">
        <button type="button" className="onboarding-choice onboarding-choice-primary" onClick={() => { void choose('empty'); }} disabled={disabled} autoFocus><ArrowRight size={22} aria-hidden="true" /><strong>Leer starten</strong><span>Mit deinen eigenen Gedanken und Plänen beginnen.</span></button>
        <button type="button" className="onboarding-choice" onClick={() => { void choose('demo'); }} disabled={disabled}><BookOpen size={22} aria-hidden="true" /><strong>Mit Beispieldaten erkunden</strong><span>Ausdrücklich fiktive Notizen, Aufgaben und Termine laden. Alles lässt sich bearbeiten und löschen.</span></button>
      </div>
      {choice && <p className="onboarding-status" role="status">{choice === 'demo' ? 'Fiktive Beispieldaten werden sicher angelegt …' : 'Dein leerer Arbeitsbereich wird vorbereitet …'}</p>}
      <p className="onboarding-privacy"><ShieldCheck size={18} aria-hidden="true" /><span>Deine Daten bleiben in diesem Browser. Es gibt keine automatische Synchronisation. Sichere deinen Arbeitsbereich regelmäßig als Datei.</span></p>
    </div>
  </dialog>;
}

export default Onboarding;
