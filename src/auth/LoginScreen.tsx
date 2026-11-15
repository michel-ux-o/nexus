import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, Eye, EyeOff, LockKeyhole, Pause, Play } from 'lucide-react';
import { ParticleLandscape } from '../horizon/ParticleLandscape';
import './LoginScreen.css';

type LoginMode = 'login' | 'register' | 'reset';

export interface LoginScreenProps {
  mode?: LoginMode;
  busy: boolean;
  error: string | null;
  notice: string | null;
  registrationOpen: boolean;
  recovery?: boolean;
  onLogin: (email: string, password: string) => Promise<void>;
  onRegister: (email: string, password: string) => Promise<void>;
  onReset: (email: string) => Promise<void>;
  onPasswordChange?: (password: string) => Promise<void>;
}

const headings: Record<LoginMode, string> = {
  login: 'Anmelden',
  register: 'Konto einrichten',
  reset: 'Passwort zurücksetzen',
};

export function LoginScreen({
  mode = 'login', busy, error, notice, registrationOpen, recovery = false,
  onLogin, onRegister, onReset, onPasswordChange,
}: LoginScreenProps) {
  const [activeMode, setActiveMode] = useState<LoginMode>(mode === 'register' && !registrationOpen ? 'login' : mode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [landscapePaused, setLandscapePaused] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [showFeedback, setShowFeedback] = useState(true);
  const submitLock = useRef(false);
  const fieldPrefix = useId();
  const pending = busy || submitting;
  const visibleError = localError || (showFeedback ? error : null);
  const visibleNotice = showFeedback ? notice : null;

  useEffect(() => {
    setActiveMode(mode === 'register' && !registrationOpen ? 'login' : mode);
  }, [mode, registrationOpen]);

  function changeMode(next: LoginMode) {
    if (pending) return;
    setActiveMode(next);
    setPassword('');
    setConfirmation('');
    setPasswordVisible(false);
    setLocalError(null);
    setShowFeedback(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || submitLock.current) return;
    setLocalError(null);
    setShowFeedback(true);

    if (recovery || activeMode === 'register') {
      if (password !== confirmation) {
        setLocalError('Die Passwörter stimmen nicht überein.');
        return;
      }
    }
    if (!recovery && activeMode === 'register') {
      if (!registrationOpen) {
        setLocalError('Die Registrierung ist gerade nicht verfügbar. Bitte versuche es später erneut.');
        return;
      }
    }
    if (recovery && !onPasswordChange) {
      setLocalError('Das neue Passwort kann gerade nicht gespeichert werden. Öffne den Wiederherstellungslink erneut.');
      return;
    }

    submitLock.current = true;
    setSubmitting(true);
    try {
      if (recovery) await onPasswordChange!(password);
      else if (activeMode === 'register') await onRegister(email.trim(), password);
      else if (activeMode === 'reset') await onReset(email.trim());
      else await onLogin(email.trim(), password);
    } catch {
      setLocalError('Die Anfrage konnte nicht abgeschlossen werden. Bitte versuche es erneut.');
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  }

  return <main className="nexus-login" data-mode={recovery ? 'recovery' : activeMode}>
    <ParticleLandscape view="home" still={landscapePaused} particleColor="#8ebed4" />
    <div className="nexus-login-atmosphere" aria-hidden="true" />
    <div className="nexus-login-layout">
      <header className="nexus-login-brand">
        <span className="nexus-login-brand-index" aria-hidden="true">N / 01</span>
        <div className="nexus-login-brand-copy"><p className="nexus-login-wordmark">NEXUS</p><p className="nexus-login-subtitle">Notizen <span aria-hidden="true">/</span> Planung</p></div>
      </header>

      <section className="nexus-login-panel" aria-labelledby={`${fieldPrefix}-heading`} data-scene-region="home">
        <div className="nexus-login-panel-heading">
          <p className="nexus-login-eyebrow"><LockKeyhole size={13} aria-hidden="true" /> Persönlicher Arbeitsbereich</p>
          <h1 id={`${fieldPrefix}-heading`}>{recovery ? 'Neues Passwort festlegen' : headings[activeMode]}</h1>
          {!recovery && activeMode === 'reset' && <p className="nexus-login-description">Wir senden dir einen Link, mit dem du ein neues Passwort festlegen kannst.</p>}
          {!recovery && activeMode === 'register' && <p className="nexus-login-description">Erstelle dein Konto und bestätige anschließend deine E-Mail-Adresse.</p>}
        </div>

        <form onSubmit={submit} className="nexus-login-form" aria-busy={pending}>
          <fieldset disabled={pending}>
            {!recovery && <label className="nexus-login-field" htmlFor={`${fieldPrefix}-email`}>
              <span>E-Mail-Adresse</span>
              <input id={`${fieldPrefix}-email`} name="email" type="email" autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false} required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} />
            </label>}

            {(recovery || activeMode !== 'reset') && <div className="nexus-login-field">
              <label htmlFor={`${fieldPrefix}-password`}>{recovery ? 'Neues Passwort' : 'Passwort'}</label>
              <span className="nexus-login-password">
                <input id={`${fieldPrefix}-password`} name="password" type={passwordVisible ? 'text' : 'password'} autoComplete={recovery || activeMode === 'register' ? 'new-password' : 'current-password'} required minLength={recovery || activeMode === 'register' ? 12 : undefined} value={password} onChange={event => setPassword(event.target.value)} aria-describedby={recovery || activeMode === 'register' ? `${fieldPrefix}-password-help` : undefined} />
                <button type="button" className="nexus-login-reveal" aria-label={passwordVisible ? 'Passwort verbergen' : 'Passwort anzeigen'} aria-pressed={passwordVisible} onClick={() => setPasswordVisible(value => !value)}>{passwordVisible ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}</button>
              </span>
              {(recovery || activeMode === 'register') && <small id={`${fieldPrefix}-password-help`}>Mindestens 12 Zeichen.</small>}
            </div>}

            {(recovery || activeMode === 'register') && <>
              <label className="nexus-login-field" htmlFor={`${fieldPrefix}-confirmation`}>
                <span>Passwort wiederholen</span>
                <input id={`${fieldPrefix}-confirmation`} name="passwordConfirmation" type={passwordVisible ? 'text' : 'password'} autoComplete="new-password" required minLength={12} value={confirmation} onChange={event => setConfirmation(event.target.value)} />
              </label>
            </>}
          </fieldset>

          {visibleError && <p className="nexus-login-feedback nexus-login-error" role="alert">{visibleError}</p>}
          {visibleNotice && <p className="nexus-login-feedback nexus-login-notice" role="status">{visibleNotice}</p>}

          <button type="submit" className="nexus-login-submit" disabled={pending}>
            <span>{pending ? 'Bitte warten …' : recovery ? 'Passwort speichern' : activeMode === 'register' ? 'Konto einrichten' : activeMode === 'reset' ? 'Link anfordern' : 'Anmelden'}</span>
            {pending ? <span className="nexus-login-spinner" aria-hidden="true" /> : <ArrowRight size={18} aria-hidden="true" />}
          </button>
        </form>

        <nav className="nexus-login-actions" aria-label="Kontooptionen">
          {recovery ? <a href="./">Zur Anmeldung</a> : activeMode === 'login' ? <>
            <button type="button" disabled={pending} onClick={() => changeMode('reset')}>Passwort vergessen?</button>
            {registrationOpen && <button type="button" disabled={pending} onClick={() => changeMode('register')}>Konto einrichten</button>}
          </> : <button type="button" disabled={pending} onClick={() => changeMode('login')}>Zur Anmeldung</button>}
        </nav>
      </section>

      <footer className="nexus-login-footer">
        <span><LockKeyhole size={12} aria-hidden="true" /> Deine Inhalte sind nach der Anmeldung zugänglich.</span>
        <button type="button" className="nexus-login-motion" aria-pressed={landscapePaused} onClick={() => setLandscapePaused(value => !value)}>
          {landscapePaused ? <Play size={13} aria-hidden="true" /> : <Pause size={13} aria-hidden="true" />}
          <span>{landscapePaused ? 'Bewegung fortsetzen' : 'Bewegung pausieren'}</span>
        </button>
      </footer>
    </div>
  </main>;
}

export default LoginScreen;
