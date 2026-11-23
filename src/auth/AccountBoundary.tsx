import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { LoginScreen } from './LoginScreen';
import { AccountClientError, loadAccountConfig, loadAccountSession, loginAccount, registerAccount, resetAccount, changeAccountPassword, logoutAccount, type AccountConfig, type AccountSession } from './accountClient';
import { selectAccountWorkspace, WorkspaceScopeChangeError } from './workspaceScope';

const AccountContext = createContext<{
  email?: string;
  userId?: string;
  active: boolean;
  logout: () => Promise<void>;
  registerLeaveGuard: (guard: () => Promise<boolean>) => () => void;
} | null>(null);
export const useAccount = () => useContext(AccountContext);
const localOnly = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) && import.meta.env.VITE_NEXUS_CLOUD_MODE !== '1';
let initialRecoveryToken: string | null = null;
if (/(?:access_token|refresh_token|error_description)=/.test(location.hash)) {
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (fragment.get('type') === 'recovery') initialRecoveryToken = fragment.get('access_token');
  history.replaceState(null, '', location.pathname + location.search);
}

/** Public shell first; no workspace mounts before the server verifies its identity. */
export function AccountBoundary({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AccountConfig | null>(null);
  const [session, setSession] = useState<AccountSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [recoveryToken, setRecoveryToken] = useState(initialRecoveryToken);
  const [accountChanged, setAccountChanged] = useState(false);
  const currentSession = useRef<AccountSession | null>(null);
  const sessionGeneration = useRef(0);
  const changingCredentials = useRef(false);
  const leaveGuard = useRef<(() => Promise<boolean>) | null>(null);
  const switching = useRef(false);
  const channel = useRef<BroadcastChannel | null>(null);
  const transitionDialog = useRef<HTMLDialogElement>(null);
  const registerLeaveGuard = useCallback((guard: () => Promise<boolean>) => {
    leaveGuard.current = guard;
    return () => { if (leaveGuard.current === guard) leaveGuard.current = null; };
  }, []);
  const holdChangedAccount = useCallback(async () => {
    if (switching.current) return;
    switching.current = true;
    const generation = sessionGeneration.current;
    // Keep the old component tree (and any unsaved drafts) alive, but inaccessible.
    // Its immutable scope can only write to the previous account's local DB.
    setAccountChanged(true);
    setNotice('Das Konto wurde in einem anderen Fenster gewechselt. Melde dich mit dem bisherigen Konto erneut an, um deine lokalen Entwürfe fortzusetzen.');
    try {
      if (leaveGuard.current && await leaveGuard.current() && generation === sessionGeneration.current) location.reload();
    } catch { /* Preserve drafts and require an explicit return to the old account. */ }
    finally { switching.current = false; }
  }, []);
  function acceptSession(current: AccountSession | null) {
    if (current?.authenticated) selectAccountWorkspace(current.userId);
    sessionGeneration.current++;
    currentSession.current = current;
    setSession(current);
    setAccountChanged(false);
  }
  useEffect(() => {
    if (localOnly) return;
    let active = true;
    // Supabase has already confirmed the email before redirecting here. Do not
    // retain its fragment tokens in navigation, browser history or application state.
    if (/(?:access_token|refresh_token|error_description)=/.test(location.hash)) {
      history.replaceState(null, '', location.pathname + location.search);
      setNotice('Du kannst dich jetzt mit deiner E-Mail-Adresse und deinem Passwort anmelden.');
    }
    void (async () => {
      try {
        const next = await loadAccountConfig();
        const current = next.enabled ? await loadAccountSession() : null;
        if (active) { acceptSession(current); setConfig(next); setError(null); }
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : 'Die Anmeldung ist gerade nicht erreichbar.'); }
    })();
    return () => { active = false; };
  }, [attempt]);
  useEffect(() => {
    if (localOnly) return;
    let active = true;
    let checking = false;
    const check = async () => {
      if (!currentSession.current?.authenticated || checking || changingCredentials.current) return;
      checking = true;
      const generation = sessionGeneration.current;
      const expectedUserId = currentSession.current.userId;
      try {
        const verified = await loadAccountSession();
        if (active && generation === sessionGeneration.current && !changingCredentials.current
          && (!verified.authenticated || verified.userId !== expectedUserId)) await holdChangedAccount();
      } catch (cause) {
        if (active && generation === sessionGeneration.current && !changingCredentials.current
          && cause instanceof AccountClientError && (cause.status === 401 || cause.status === 403)) await holdChangedAccount();
        // Temporary network loss does not discard a verified local workspace.
      }
      finally { checking = false; }
    };
    const visible = () => { if (document.visibilityState === 'visible') void check(); };
    const focus = () => { void check(); };
    const communication = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('nexus-account-session') : null;
    channel.current = communication;
    if (communication) communication.onmessage = () => { void check(); };
    window.addEventListener('focus', focus);
    window.addEventListener('pageshow', focus);
    document.addEventListener('visibilitychange', visible);
    return () => {
      active = false; communication?.close();
      if (channel.current === communication) channel.current = null;
      window.removeEventListener('focus', focus);
      window.removeEventListener('pageshow', focus);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [holdChangedAccount]);
  useEffect(() => {
    const dialog = transitionDialog.current;
    if (!accountChanged || !dialog) return;
    // An already-open editor remains modal even while its subtree is hidden.
    // Put re-authentication above it instead of closing that editor: close
    // handlers would otherwise discard the very draft we need to preserve.
    if (!dialog.open) dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, [accountChanged]);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(null); setNotice(null);
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Die Anmeldung konnte nicht abgeschlossen werden.'); }
    finally { setBusy(false); }
  }
  if (localOnly) return children;
  if (config?.enabled === false) return <main className="startup-state"><div className="eyebrow">NEXUS</div><h1>Die Anmeldung wird eingerichtet.</h1><p>Der Arbeitsbereich ist noch nicht freigeschaltet.</p></main>;
  if (!config) return <main className="startup-state"><div className="eyebrow">NEXUS</div><h1>{error ? 'Verbindung nicht verfügbar' : 'Nexus wird geöffnet …'}</h1>{error && <><p role="alert">{error}</p><button onClick={() => { setError(null); setAttempt(value => value + 1); }}>Erneut versuchen</button></>}</main>;
  const login = <LoginScreen busy={busy} error={error} notice={notice} registrationOpen={config.registrationOpen && !accountChanged} recovery={!!recoveryToken}
    onPasswordChange={password => run(async () => { if (!recoveryToken) throw new Error('Bitte öffne den Link aus deiner E-Mail erneut.'); await changeAccountPassword(password, recoveryToken); initialRecoveryToken = null; setRecoveryToken(null); setNotice('Dein Passwort wurde geändert. Du kannst dich jetzt anmelden.'); })}
    onLogin={(email, password) => run(async () => {
      changingCredentials.current = true;
      sessionGeneration.current++;
      try {
        const next = await loginAccount(email, password);
        try { acceptSession(next); }
        catch (cause) {
          if (cause instanceof WorkspaceScopeChangeError) await holdChangedAccount();
          throw cause;
        }
        channel.current?.postMessage('changed');
      } finally {
        changingCredentials.current = false;
      }
    })}
    onRegister={(email, password) => run(async () => { await registerAccount(email, password); setNotice('Prüfe dein E-Mail-Postfach und bestätige deinen Zugang. Melde dich anschließend hier an.'); })}
    onReset={email => run(async () => { await resetAccount(email); setNotice('Falls ein passendes Konto vorhanden ist, erhältst du eine E-Mail mit den nächsten Schritten.'); })} />;
  if (session?.authenticated && !recoveryToken) return <>
    <div hidden={accountChanged} style={{ display: accountChanged ? 'none' : 'contents' }}>
      <AccountContext.Provider value={{ email: session.email, userId: session.userId, active: !accountChanged && !changingCredentials.current, registerLeaveGuard, logout: async () => {
        changingCredentials.current = true;
        sessionGeneration.current++;
        try { await logoutAccount(); }
        catch (cause) { changingCredentials.current = false; throw cause; }
        channel.current?.postMessage('changed');
        setAccountChanged(true);
        // A full document transition disposes every store, queue and editor draft.
        location.reload();
      } }}>{children}</AccountContext.Provider>
    </div>
    {accountChanged && <dialog ref={transitionDialog} aria-label="Anmeldung nach Kontowechsel"
      onCancel={event => event.preventDefault()}
      style={{ position: 'fixed', inset: 0, margin: 0, border: 0, borderRadius: 0, padding: 0,
        width: '100vw', height: '100dvh', maxWidth: 'none', maxHeight: 'none',
        background: '#07090f', color: 'inherit', overflow: 'auto' }}>
      {login}
    </dialog>}
  </>;
  return login;
}
