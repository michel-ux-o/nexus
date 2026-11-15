import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { LoginScreen } from './LoginScreen';
import { loadAccountConfig, loadAccountSession, loginAccount, registerAccount, resetAccount, changeAccountPassword, logoutAccount, type AccountConfig, type AccountSession } from './accountClient';

const AccountContext = createContext<{ email?: string; logout: () => Promise<void> } | null>(null);
export const useAccount = () => useContext(AccountContext);
const localOnly = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) && import.meta.env.VITE_NEXUS_CLOUD_MODE !== '1';
let initialRecoveryToken: string | null = null;
if (/(?:access_token|refresh_token|error_description)=/.test(location.hash)) {
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (fragment.get('type') === 'recovery') initialRecoveryToken = fragment.get('access_token');
  history.replaceState(null, '', location.pathname + location.search);
}

/** Public shell first; no workspace mounts before the server verifies its owner. */
export function AccountBoundary({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AccountConfig | null>(null);
  const [session, setSession] = useState<AccountSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [recoveryToken, setRecoveryToken] = useState(initialRecoveryToken);
  useEffect(() => {
    if (localOnly) return;
    let active = true;
    // Supabase has already confirmed the invite before redirecting here. Do not
    // retain its fragment tokens in navigation, browser history or application state.
    if (/(?:access_token|refresh_token|error_description)=/.test(location.hash)) {
      history.replaceState(null, '', location.pathname + location.search);
      setNotice('Du kannst dich jetzt mit deiner E-Mail-Adresse und deinem Passwort anmelden.');
    }
    void (async () => {
      try {
        const next = await loadAccountConfig();
        const current = next.enabled ? await loadAccountSession() : null;
        if (active) { setConfig(next); setSession(current); setError(null); }
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : 'Die Anmeldung ist gerade nicht erreichbar.'); }
    })();
    return () => { active = false; };
  }, [attempt]);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(null); setNotice(null);
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Die Anmeldung konnte nicht abgeschlossen werden.'); }
    finally { setBusy(false); }
  }
  if (localOnly) return children;
  if (config?.enabled === false) return <main className="startup-state"><div className="eyebrow">NEXUS</div><h1>Die Anmeldung wird eingerichtet.</h1><p>Der private Arbeitsbereich ist noch nicht freigeschaltet.</p></main>;
  if (session?.authenticated && !recoveryToken) return <AccountContext.Provider value={{ email: session.email, logout: async () => { await logoutAccount(); setSession({ authenticated: false }); } }}>{children}</AccountContext.Provider>;
  if (!config) return <main className="startup-state"><div className="eyebrow">NEXUS</div><h1>{error ? 'Verbindung nicht verfügbar' : 'Nexus wird geöffnet …'}</h1>{error && <><p role="alert">{error}</p><button onClick={() => { setError(null); setAttempt(value => value + 1); }}>Erneut versuchen</button></>}</main>;
  return <LoginScreen busy={busy} error={error} notice={notice} registrationOpen={config.registrationOpen} recovery={!!recoveryToken}
    onPasswordChange={password => run(async () => { if (!recoveryToken) throw new Error('Bitte öffne den Link aus deiner E-Mail erneut.'); await changeAccountPassword(password, recoveryToken); initialRecoveryToken = null; setRecoveryToken(null); setNotice('Dein Passwort wurde geändert. Du kannst dich jetzt anmelden.'); })}
    onLogin={(email, password) => run(async () => { setSession(await loginAccount(email, password)); })}
    onRegister={(email, password, setupCode) => run(async () => { await registerAccount(email, password, setupCode); setNotice('Prüfe dein E-Mail-Postfach und bestätige deinen Zugang. Melde dich anschließend hier an.'); })}
    onReset={email => run(async () => { await resetAccount(email); setNotice('Falls ein passendes Konto vorhanden ist, erhältst du eine E-Mail mit den nächsten Schritten.'); })} />;
}
