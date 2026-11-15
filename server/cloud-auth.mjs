import { createHash, timingSafeEqual } from 'node:crypto';

const PREFIX = '/api/account/';
const ACCESS_COOKIE = '__Host-nexus-access';
const REFRESH_COOKIE = '__Host-nexus-refresh';
const BODY_LIMIT = 16 * 1024;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESET_MESSAGE = 'Wenn diese Adresse zu deinem Konto gehört, erhältst du eine E-Mail mit den nächsten Schritten.';

class AccountError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function reply(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

function originValue(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.origin === value && !parsed.username && !parsed.password ? parsed.origin : null;
  } catch { return null; }
}

function emailValue(value) {
  if (typeof value !== 'string') throw new AccountError(400, 'Bitte gib eine gültige E-Mail-Adresse ein.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AccountError(400, 'Bitte gib eine gültige E-Mail-Adresse ein.');
  return email;
}

function passwordValue(value, registration = false) {
  if (typeof value !== 'string' || value.length > 1024 || value.length < (registration ? 12 : 1)) throw new AccountError(400, registration ? 'Das Passwort muss mindestens 12 Zeichen lang sein.' : 'Bitte gib dein Passwort ein.');
  return value;
}

function tokenValue(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 8192 && /^[A-Za-z0-9_.~-]+$/.test(value) ? value : null;
}

function cookies(req) {
  const result = new Map();
  const source = req.headers.cookie;
  if (typeof source !== 'string' || source.length > 24576) return result;
  for (const part of source.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key !== ACCESS_COOKIE && key !== REFRESH_COOKIE) continue;
    // Ambiguous duplicate cookies fail closed.
    if (result.has(key)) { result.set(key, null); continue; }
    result.set(key, tokenValue(part.slice(index + 1).trim()));
  }
  return result;
}

function setCookies(res, session) {
  const suffix = '; Path=/; HttpOnly; Secure; SameSite=Lax';
  const previous = res.getHeader('Set-Cookie');
  const headers = previous ? (Array.isArray(previous) ? previous : [previous]) : [];
  if (!session) {
    headers.push(`${ACCESS_COOKIE}=; Max-Age=0${suffix}`, `${REFRESH_COOKIE}=; Max-Age=0${suffix}`);
  } else {
    const lifetime = Math.min(3600, Math.max(1, Math.floor(Number(session.expires_in) || 3600)));
    headers.push(`${ACCESS_COOKIE}=${session.access_token}; Max-Age=${lifetime}${suffix}`, `${REFRESH_COOKIE}=${session.refresh_token}; Max-Age=2592000${suffix}`);
  }
  res.setHeader('Set-Cookie', headers);
}

async function readJson(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) throw new AccountError(415, 'Bitte sende die Anfrage als JSON.');
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > BODY_LIMIT)) { req.resume(); throw new AccountError(413, 'Die Anfrage ist zu groß.'); }
  const body = await new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => {
      clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('error', fail); req.off('aborted', aborted);
    };
    const fail = error => { cleanup(); req.resume(); reject(error); };
    const aborted = () => fail(new AccountError(400, 'Die Anfrage wurde abgebrochen.'));
    const data = chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) { fail(new AccountError(413, 'Die Anfrage ist zu groß.')); return; }
      chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const timer = setTimeout(() => fail(new AccountError(408, 'Die Anfrage hat zu lange gedauert. Bitte versuche es erneut.')), 15000);
    timer.unref?.();
    req.on('data', data); req.once('end', end); req.once('error', fail); req.once('aborted', aborted);
  });
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new AccountError(400, 'Die Anfrage enthält kein gültiges JSON.'); }
}

function checkedUser(value) {
  if (!value || !ID_PATTERN.test(value.id ?? '') || typeof value.email !== 'string' || !value.email_confirmed_at) return null;
  return { id: value.id, email: value.email.trim().toLowerCase() };
}

/** Server-only Supabase authentication. Tokens and privileged keys never enter response JSON. */
export function createCloudAuth({ env = process.env, fetchImpl = fetch } = {}) {
  const enabled = env.NEXUS_CLOUD_MODE === '1';
  const origin = originValue(env.APP_ORIGIN);
  const supabase = originValue(env.SUPABASE_URL);
  const anonKey = env.SUPABASE_ANON_KEY;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const setupCode = env.NEXUS_SETUP_CODE;
  const configured = Boolean(origin && supabase && anonKey && serviceKey);
  const setupEnabled = typeof setupCode === 'string' && setupCode.length >= 24;
  const setupDigest = createHash('sha256').update(typeof setupCode === 'string' ? setupCode : '').digest();
  const limits = new Map();
  const refreshing = new Map();

  function requireConfigured() {
    if (!configured) throw new AccountError(503, 'Die Kontoanmeldung wird gerade eingerichtet. Bitte versuche es später erneut.');
  }

  function checkOrigin(req) {
    if (req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') throw new AccountError(403, 'Diese Anfrage stammt nicht von deiner NEXUS-Seite.');
  }

  function rateLimit(key, maximum) {
    const now = Date.now();
    for (const [key, entry] of limits) if (entry.until <= now) limits.delete(key);
    let entry = limits.get(key);
    if (!entry) {
      if (limits.size >= 2048) throw new AccountError(429, 'Zu viele Anfragen. Bitte versuche es später erneut.');
      entry = { count: 0, until: now + 15 * 60 * 1000 };
      limits.set(key, entry);
    }
    entry.count++;
    if (entry.count > maximum) throw new AccountError(429, 'Zu viele Versuche. Bitte warte 15 Minuten.');
  }

  function rateLimitPeer(req, action) {
    // Hosting proxies can share one transport address across visitors. Keep a
    // separate, larger safety cap for login/reset; their tight budgets are per
    // normalized email below. Never trust caller-controlled forwarding headers.
    const maximum = action === 'login' ? 200 : action === 'reset' ? 50 : 5;
    rateLimit(`peer:${action}:${req.socket?.remoteAddress ?? 'unknown'}`, maximum);
  }

  function rateLimitEmail(action, email) {
    const digest = createHash('sha256').update(email).digest('hex');
    rateLimit(`email:${action}:${digest}`, action === 'login' ? 20 : 5);
  }

  async function request(path, { method = 'GET', body, privileged = false, token, allowFailure = false } = {}) {
    const key = privileged ? serviceKey : anonKey;
    let response;
    try {
      response = await fetchImpl(`${supabase}${path}`, {
        method,
        headers: { apikey: key, Authorization: `Bearer ${token ?? key}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10000), redirect: 'error',
      });
    } catch { throw new AccountError(503, 'Der Kontodienst ist gerade nicht erreichbar. Bitte versuche es erneut.'); }
    let data = null;
    try { data = await response.json(); } catch { /* Never echo an upstream body. */ }
    if (!response.ok && !allowFailure) throw new AccountError(503, 'Der Kontodienst konnte die Anfrage nicht abschließen. Bitte versuche es erneut.');
    return { ok: response.ok, status: response.status, data };
  }

  async function owner() {
    const { data } = await request('/rest/v1/rpc/nexus_get_owner', { method: 'POST', body: {}, privileged: true });
    if (data === null) return null;
    if (!data || typeof data !== 'object' || typeof data.email !== 'string' || (data.user_id !== null && !ID_PATTERN.test(data.user_id ?? ''))) throw new AccountError(503, 'Die private Kontofreigabe ist noch nicht bereit.');
    return { email: data.email.toLowerCase(), userId: data.user_id };
  }

  async function matchesOwner(user, bind = false) {
    let current = await owner();
    if (!current || current.email !== user.email) return false;
    if (!current.userId && bind) {
      const { data } = await request('/rest/v1/rpc/nexus_bind_owner', { method: 'POST', privileged: true, body: { p_email: user.email, p_user_id: user.id } });
      if (data !== true) return false;
      current = await owner();
    }
    return current?.userId === user.id;
  }

  async function userForToken(token) {
    const result = await request('/auth/v1/user', { token, allowFailure: true });
    if (!result.ok) {
      if (result.status === 401 || result.status === 403) return null;
      throw new AccountError(503, 'Die Anmeldung konnte gerade nicht geprüft werden. Bitte versuche es erneut.');
    }
    return checkedUser(result.data);
  }

  async function refresh(token) {
    const key = createHash('sha256').update(token).digest('hex');
    const now = Date.now();
    for (const [stored, entry] of refreshing) if (entry.expires <= now) refreshing.delete(stored);
    let entry = refreshing.get(key);
    if (!entry) {
      if (refreshing.size >= 128) throw new AccountError(503, 'Die Anmeldung ist gerade ausgelastet. Bitte versuche es erneut.');
      const promise = request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: token }, allowFailure: true });
      entry = { promise, expires: now + 15000 };
      refreshing.set(key, entry);
      // Keep a brief result for overlapping browser requests with the old cookie.
      promise.finally(() => { entry.expires = Date.now() + 3000; }).catch(() => {});
    }
    const result = await entry.promise;
    if (!result.ok) {
      if (result.status === 400 || result.status === 401 || result.status === 403) return null;
      throw new AccountError(503, 'Deine Anmeldung konnte gerade nicht erneuert werden. Bitte versuche es erneut.');
    }
    if (!tokenValue(result.data?.access_token) || !tokenValue(result.data?.refresh_token)) throw new AccountError(503, 'Die Anmeldung konnte nicht erneuert werden.');
    return result.data;
  }

  async function authorize(req, res) {
    if (!enabled) return null;
    requireConfigured();
    const stored = cookies(req);
    let token = stored.get(ACCESS_COOKIE);
    let user = token ? await userForToken(token) : null;
    let session = null;
    if (!user && stored.get(REFRESH_COOKIE)) {
      session = await refresh(stored.get(REFRESH_COOKIE));
      token = session?.access_token;
      user = token ? await userForToken(token) : null;
    }
    if (!user || !await matchesOwner(user)) {
      if (stored.size) setCookies(res, null);
      return null;
    }
    if (session) setCookies(res, session);
    return user;
  }

  async function handle(req, res, url) {
    if (!url.pathname.startsWith(PREFIX)) return false;
    const endpoint = url.pathname.slice(PREFIX.length);
    if (!enabled && endpoint !== 'config') return false;
    try {
      const expected = endpoint === 'config' || endpoint === 'session' ? 'GET' : 'POST';
      if (!['config', 'session', 'login', 'register', 'logout', 'reset', 'password'].includes(endpoint)) { reply(res, 404, { error: 'Kontofunktion nicht gefunden.' }); return true; }
      if (req.method !== expected) { res.setHeader('Allow', expected); throw new AccountError(405, 'Diese Methode ist nicht erlaubt.'); }
      if (endpoint === 'config') {
        if (!enabled) { reply(res, 200, { enabled: false, registrationOpen: false }); return true; }
        requireConfigured();
        const current = await owner();
        reply(res, 200, { enabled: true, registrationOpen: setupEnabled && !current?.userId });
        return true;
      }
      requireConfigured();
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new AccountError(403, 'Diese Anfrage stammt nicht von deiner NEXUS-Seite.');
      if (req.method === 'POST') checkOrigin(req);
      if (endpoint === 'session') {
        const user = await authorize(req, res);
        reply(res, 200, user ? { authenticated: true, userId: user.id, email: user.email } : { authenticated: false });
        return true;
      }
      if (endpoint === 'logout') {
        const token = cookies(req).get(ACCESS_COOKIE);
        setCookies(res, null);
        if (token) {
          try { await request('/auth/v1/logout?scope=local', { method: 'POST', token, allowFailure: true }); } catch { /* Local cookies are already removed. */ }
        }
        reply(res, 200, { authenticated: false });
        return true;
      }
      rateLimitPeer(req, endpoint);
      const input = await readJson(req);
      if (endpoint === 'login') {
        const email = emailValue(input.email);
        rateLimitEmail(endpoint, email);
        const password = passwordValue(input.password);
        const result = await request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password }, allowFailure: true });
        if (!result.ok) {
          if (result.status >= 500 || result.status === 429) throw new AccountError(503, 'Die Anmeldung ist gerade nicht verfügbar. Bitte versuche es später erneut.');
          throw new AccountError(401, 'Anmeldung fehlgeschlagen. Prüfe E-Mail und Passwort und bestätige zuerst deine E-Mail-Adresse.');
        }
        if (!tokenValue(result.data?.access_token) || !tokenValue(result.data?.refresh_token)) throw new AccountError(503, 'Der Kontodienst hat keine gültige Sitzung geliefert.');
        const user = await userForToken(result.data.access_token);
        if (!user || !await matchesOwner(user, true)) {
          try { await request('/auth/v1/logout?scope=local', { method: 'POST', token: result.data.access_token, allowFailure: true }); } catch { /* Authorization remains denied. */ }
          throw new AccountError(403, 'Dieses Konto ist für diesen privaten Arbeitsbereich nicht freigegeben.');
        }
        setCookies(res, result.data);
        reply(res, 200, { authenticated: true, email: user.email, userId: user.id });
        return true;
      }
      if (endpoint === 'register') {
        const supplied = typeof input.setupCode === 'string' && input.setupCode.length <= 1024 ? input.setupCode : '';
        const digest = createHash('sha256').update(supplied).digest();
        if (!setupEnabled || !timingSafeEqual(digest, setupDigest)) throw new AccountError(403, 'Der Einrichtungscode ist ungültig.');
        const email = emailValue(input.email);
        const password = passwordValue(input.password, true);
        let reserved;
        try {
          ({ data: reserved } = await request('/rest/v1/rpc/nexus_reserve_owner', { method: 'POST', privileged: true, body: { p_email: email } }));
        } catch {
          throw new AccountError(503, 'Ob deine Adresse für den privaten Zugang reserviert wurde, konnte nicht bestätigt werden. Versuche die Einrichtung später mit derselben Adresse erneut. Eine bereits reservierte, falsch eingegebene Adresse muss die Administration kontrolliert korrigieren.');
        }
        if (reserved !== true) throw new AccountError(409, 'Der private Zugang ist bereits eingerichtet oder für eine andere Adresse reserviert.');
        let invitation;
        try {
          invitation = await request(`/auth/v1/invite?redirect_to=${encodeURIComponent(`${origin}/?account=confirmed`)}`, { method: 'POST', privileged: true, body: { email }, allowFailure: true });
        } catch {
          // A timeout can happen after the provider has created the account or
          // requested mail. Never release its reservation or replace its user.
          throw new AccountError(503, 'Deine Adresse bleibt für den privaten Zugang reserviert. Ob die Bestätigungs-E-Mail angefordert wurde, konnte nicht bestätigt werden. Falls sie ankommt, bestätige den Link und nutze anschließend „Passwort vergessen“. Bei einer falsch eingegebenen Adresse ist eine kontrollierte Korrektur durch die Administration nötig.');
        }
        if (!invitation.ok) throw new AccountError(invitation.status >= 500 || invitation.status === 429 ? 503 : 409, 'Deine Adresse bleibt für den privaten Zugang reserviert. Die Registrierung konnte nicht abgeschlossen werden. Falls du eine Bestätigungs-E-Mail erhalten hast, bestätige den Link und nutze anschließend „Passwort vergessen“. Falls der Dienst vorübergehend nicht erreichbar ist, versuche die Einrichtung später mit derselben Adresse erneut. Eine falsch eingegebene Adresse muss die Administration kontrolliert korrigieren.');
        const invited = invitation.data?.user ?? invitation.data;
        if (!ID_PATTERN.test(invited?.id ?? '') || typeof invited?.email !== 'string' || invited.email.toLowerCase() !== email) throw new AccountError(503, 'Deine Adresse bleibt für den privaten Zugang reserviert. Der Kontodienst hat die Einrichtung nicht eindeutig bestätigt. Falls eine Bestätigungs-E-Mail ankommt, bestätige den Link und nutze anschließend „Passwort vergessen“.');
        if (invited.email_confirmed_at) throw new AccountError(409, 'Der Zugang besteht bereits. Bitte melde dich an oder setze dein Passwort zurück.');
        try {
          await request(`/auth/v1/admin/users/${invited.id}`, { method: 'PUT', privileged: true, body: { password } });
        } catch {
          // The mail request already succeeded, but a network failure may leave
          // the password update's outcome unknown. Keep the reserved owner and
          // offer recovery instead of inviting or overwriting another account.
          throw new AccountError(503, 'Die Bestätigungs-E-Mail wurde angefordert. Die Speicherung deines Passworts konnte noch nicht bestätigt werden. Falls die E-Mail ankommt, bestätige den Link und nutze anschließend „Passwort vergessen“.');
        }
        reply(res, 202, { authenticated: false, pendingConfirmation: true, message: 'Bitte bestätige deine E-Mail-Adresse über den zugesandten Link. Danach kannst du dich hier anmelden.' });
        return true;
      }
      if (endpoint === 'reset') {
        const email = emailValue(input.email);
        rateLimitEmail(endpoint, email);
        const current = await owner();
        if (current?.email === email) {
          const result = await request(`/auth/v1/recover?redirect_to=${encodeURIComponent(`${origin}/?account=recovery`)}`, { method: 'POST', body: { email }, allowFailure: true });
          if (result.status >= 500 || result.status === 429) throw new AccountError(503, 'Die E-Mail konnte gerade nicht angefordert werden. Bitte versuche es später erneut.');
        }
        reply(res, 200, { message: RESET_MESSAGE });
        return true;
      }
      // A recovery token from the confirmation URL stays in page memory and is
      // exchanged only here; it is never stored in localStorage or returned.
      const recoveryToken = tokenValue(input.recoveryToken);
      const password = passwordValue(input.password, true);
      const user = recoveryToken ? await userForToken(recoveryToken) : null;
      if (!user || !await matchesOwner(user, true)) throw new AccountError(401, 'Der Link ist ungültig oder abgelaufen. Bitte fordere einen neuen Link an.');
      const updated = await request('/auth/v1/user', { method: 'PUT', token: recoveryToken, body: { password }, allowFailure: true });
      if (!updated.ok) throw new AccountError(400, 'Das Passwort konnte nicht geändert werden. Bitte verwende ein neues Passwort oder fordere einen neuen Link an.');
      try { await request('/auth/v1/logout?scope=local', { method: 'POST', token: recoveryToken, allowFailure: true }); } catch { /* Password was changed; require fresh login. */ }
      setCookies(res, null);
      reply(res, 200, { authenticated: false, message: 'Passwort gespeichert. Bitte melde dich mit deinem neuen Passwort an.' });
      return true;
    } catch (error) {
      reply(res, error instanceof AccountError ? error.status : 503, { error: error instanceof AccountError ? error.message : 'Die Kontofunktion ist gerade nicht erreichbar. Bitte versuche es erneut.' });
      return true;
    }
  }

  return { enabled, handle, authorize };
}
