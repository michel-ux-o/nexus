export interface AccountConfig {
  enabled: boolean;
  registrationOpen: boolean;
}

export interface AccountSession {
  authenticated: boolean;
  email?: string;
  userId?: string;
}

export class AccountClientError extends Error {
  constructor(message: string, public readonly status: number | null = null) {
    super(message);
    this.name = 'AccountClientError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fallbackError(status: number): string {
  if (status === 401) return 'Die Anmeldung ist fehlgeschlagen. Bitte prüfe deine Zugangsdaten.';
  if (status === 403) return 'Für diesen Vorgang fehlt die Berechtigung.';
  if (status === 429) return 'Zu viele Versuche. Bitte warte kurz und versuche es erneut.';
  return 'Der Kontodienst ist gerade nicht verfügbar. Bitte versuche es erneut.';
}

function responseError(value: unknown, status: number): string {
  if (isObject(value) && typeof value.error === 'string') {
    const message = value.error.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (message) return message.slice(0, 300);
  }
  return fallbackError(status);
}

async function request(path: string, body?: Record<string, string>): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`/api/account/${path}`, {
      method: body ? 'POST' : 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: body
        ? { 'Content-Type': 'application/json', 'x-nexus-client': '1' }
        : { 'x-nexus-client': '1' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new AccountClientError('Der Kontodienst ist nicht erreichbar. Bitte prüfe deine Internetverbindung.');
  }

  let value: unknown;
  try {
    value = response.status === 204 ? undefined : await response.json();
  } catch {
    if (!response.ok) throw new AccountClientError(fallbackError(response.status), response.status);
    throw new AccountClientError('Der Kontodienst hat eine ungültige Antwort geliefert. Bitte versuche es erneut.', response.status);
  }
  if (!response.ok) throw new AccountClientError(responseError(value, response.status), response.status);
  return value;
}

function parseSession(value: unknown): AccountSession {
  if (!isObject(value) || typeof value.authenticated !== 'boolean'
    || (value.email !== undefined && typeof value.email !== 'string')
    || (value.userId !== undefined && typeof value.userId !== 'string')) {
    throw new AccountClientError('Der Kontodienst hat eine ungültige Sitzungsantwort geliefert. Bitte versuche es erneut.');
  }
  if (!value.authenticated) return { authenticated: false };
  return {
    authenticated: true,
    ...(typeof value.email === 'string' ? { email: value.email } : {}),
    ...(typeof value.userId === 'string' ? { userId: value.userId } : {}),
  };
}

export async function loadAccountConfig(): Promise<AccountConfig> {
  const value = await request('config');
  if (!isObject(value) || typeof value.enabled !== 'boolean' || typeof value.registrationOpen !== 'boolean') {
    throw new AccountClientError('Der Kontodienst hat eine ungültige Konfiguration geliefert. Bitte versuche es erneut.');
  }
  return { enabled: value.enabled, registrationOpen: value.registrationOpen };
}

export async function loadAccountSession(): Promise<AccountSession> {
  return parseSession(await request('session'));
}

export async function loginAccount(email: string, password: string): Promise<AccountSession> {
  return parseSession(await request('login', { email: email.trim(), password }));
}

export async function registerAccount(email: string, password: string): Promise<AccountSession> {
  return parseSession(await request('register', { email: email.trim(), password }));
}

export async function resetAccount(email: string): Promise<void> {
  await request('reset', { email: email.trim() });
}

export async function changeAccountPassword(password: string, recoveryToken: string): Promise<void> {
  await request('password', { password, recoveryToken });
}

export async function logoutAccount(): Promise<void> {
  await request('logout', {});
}
