/// <reference types="vite/client" />
import { CURRENT_BUILD, isOlderBuild, parseBuildInfo, type BuildInfo } from './update/build';

export interface UpdateSnapshot {
  phase: 'idle' | 'checking' | 'available' | 'applying' | 'unsupported';
  available?: BuildInfo;
  ready: boolean;
  checkedAt?: string;
  noticeRequest?: number;
  error?: string;
}
export type UpdatePreparation = boolean | { ready: boolean; release?: () => void };
let snapshot: UpdateSnapshot = { phase: 'idle', ready: false };
const listeners = new Set<() => void>();
export const getUpdateSnapshot = () => snapshot;
export const subscribeToUpdates = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function publish(change: Partial<UpdateSnapshot>) {
  snapshot = { ...snapshot, ...change };
  listeners.forEach(listener => listener());
}
let registrationStarted = false;
let checking: Promise<void> | undefined;
let registration: ServiceWorkerRegistration | undefined;
const watched = new WeakSet<ServiceWorkerRegistration>();
const baseURL = () => new URL(import.meta.env.BASE_URL, window.location.href);
const supported = () => import.meta.env.PROD && 'serviceWorker' in navigator;

function askWorker(worker: ServiceWorker, message: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = window.setTimeout(() => { channel.port1.close(); reject(new Error('Der Offline-Dienst antwortet noch nicht. Bitte erneut prüfen.')); }, 2500);
    channel.port1.onmessage = event => { clearTimeout(timeout); channel.port1.close(); resolve(event.data); };
    worker.postMessage(message, [channel.port2]);
  });
}
async function workerBuild(worker: ServiceWorker | null): Promise<BuildInfo | undefined> {
  if (!worker) return;
  try { return parseBuildInfo((await askWorker(worker, { type: 'NEXUS_BUILD_INFO' }) as { build: unknown }).build); }
  catch { return; } // Legacy workers have no message protocol; registration upgrades them.
}
async function refreshAvailable(current: ServiceWorkerRegistration) {
  const worker = current.waiting ?? current.active;
  const build = await workerBuild(worker);
  if (!build || build.id === CURRENT_BUILD.id || isOlderBuild(build, CURRENT_BUILD)) return;
  if (snapshot.available && isOlderBuild(build, snapshot.available)) return;
  publish({ phase: snapshot.phase === 'applying' ? 'applying' : 'available', available: build, ready: true, error: undefined });
}
function watch(current: ServiceWorkerRegistration) {
  registration = current;
  if (watched.has(current)) return;
  watched.add(current);
  const installing = () => {
    const worker = current.installing;
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' || worker.state === 'activated') void refreshAvailable(current);
      if (worker.state === 'redundant' && snapshot.available && !snapshot.ready) publish({ error: 'Das Update konnte noch nicht vollständig geladen werden. Bitte erneut prüfen.' });
    });
  };
  current.addEventListener('updatefound', installing);
  installing();
}

/** A fixed script URL lets an already-open document discover the current deployment. */
export function checkForUpdates(revealNotice = false): Promise<void> {
  if (revealNotice) publish({ noticeRequest: (snapshot.noticeRequest ?? 0) + 1 });
  if (!supported()) { publish({ phase: 'unsupported' }); return Promise.resolve(); }
  if (snapshot.phase === 'applying') return Promise.resolve();
  if (checking) return checking;
  checking = (async () => {
    publish({ phase: 'checking', error: undefined });
    try {
      const base = baseURL();
      const existing = await navigator.serviceWorker.getRegistration(base.href);
      if (existing) { watch(existing); await refreshAvailable(existing); }
      const response = await fetch(new URL('build.json', base), { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(10000) });
      if (!response.ok || response.redirected) throw new Error('Die Installation ist gerade nicht erreichbar. Deine geöffnete Version bleibt nutzbar.');
      const latest = parseBuildInfo(await response.json().catch(() => { throw new Error('Die Build-Information konnte nicht gelesen werden. Bitte erneut prüfen.'); }));
      if (isOlderBuild(latest, CURRENT_BUILD) || (snapshot.available && isOlderBuild(latest, snapshot.available))) {
        throw new Error('Der Server liefert einen älteren Build. Die geöffnete Version wird beibehalten.');
      }
      const changed = latest.id !== CURRENT_BUILD.id;
      const alreadyReady = snapshot.available?.id === latest.id && snapshot.ready;
      publish({ phase: changed ? 'available' : 'idle', available: changed ? latest : undefined, ready: changed && alreadyReady, checkedAt: new Date().toISOString() });
      const script = new URL('sw.js', base);
      const previousScript = existing?.active?.scriptURL ?? existing?.waiting?.scriptURL ?? existing?.installing?.scriptURL;
      const current = existing && previousScript === script.href ? existing
        : await navigator.serviceWorker.register(script, { scope: base.pathname, updateViaCache: 'none' });
      watch(current);
      if (current === existing) await current.update();
      await refreshAvailable(current);
    } catch (cause) {
      const networkError = cause instanceof TypeError || (typeof DOMException !== 'undefined' && cause instanceof DOMException);
      publish({ phase: snapshot.available ? 'available' : 'idle', error: networkError
        ? 'Die Installation ist gerade nicht erreichbar. Prüfe deine Verbindung und versuche es erneut. Deine geöffnete Version bleibt nutzbar.'
        : cause instanceof Error ? cause.message : 'Updates können gerade nicht geprüft werden. Bitte erneut versuchen.' });
    }
  })().finally(() => { checking = undefined; });
  return checking;
}

function waitForActivation(worker: ServiceWorker): Promise<void> {
  if (worker.state === 'activated') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const clean = () => { clearTimeout(timeout); worker.removeEventListener('statechange', changed); };
    const changed = () => {
      if (worker.state === 'activated') { clean(); resolve(); }
      else if (worker.state === 'redundant') { clean(); reject(new Error('Das Update wurde ersetzt. Bitte erneut prüfen.')); }
    };
    const timeout = window.setTimeout(() => { clean(); reject(new Error('Das Update braucht länger. Deine geöffnete Version bleibt erhalten; bitte erneut versuchen.')); }, 10000);
    worker.addEventListener('statechange', changed);
    changed();
  });
}

/** Never reload until the application's complete draft guard has succeeded. */
export async function applyAvailableUpdate(prepare: () => Promise<UpdatePreparation>): Promise<void> {
  const desired = snapshot.available;
  if (!desired || !snapshot.ready || snapshot.phase === 'applying' || !registration) return;
  let release: (() => void) | undefined;
  let reloading = false;
  publish({ phase: 'applying', error: undefined });
  try {
    const preparation = await prepare();
    release = typeof preparation === 'object' ? preparation.release : undefined;
    if (!(typeof preparation === 'boolean' ? preparation : preparation.ready)) throw new Error('Bitte schließe offene Entwürfe ab und speichere deine Änderungen. Danach kannst du das Update erneut öffnen.');
    if (snapshot.available?.id !== desired.id) throw new Error('Eine andere Version ist inzwischen verfügbar. Bitte erneut prüfen.');
    const waiting = registration.waiting;
    if (waiting && (await workerBuild(waiting))?.id === desired.id) {
      const result = await askWorker(waiting, { type: 'NEXUS_ACTIVATE_UPDATE', buildId: desired.id }) as { ok?: boolean; reason?: string };
      if (!result?.ok) throw new Error(result?.reason === 'other-tabs'
        ? 'Bitte schließe zuerst die anderen NEXUS-Tabs und -Fenster dieser Installation. Deine Änderungen hier sind gespeichert.'
        : 'Das Update ist noch nicht bereit. Bitte erneut prüfen.');
      await waitForActivation(waiting);
    } else if ((await workerBuild(registration.active))?.id !== desired.id) {
      throw new Error('Das Update ist noch nicht bereit. Bitte erneut prüfen.');
    }
    window.location.reload();
    reloading = true;
  } catch (cause) {
    publish({ phase: 'available', error: cause instanceof Error ? cause.message : 'Das Update konnte nicht geöffnet werden. Deine Eingaben bleiben erhalten.' });
  } finally {
    if (!reloading) release?.();
  }
}

/** Retry network/registration failures; never automatically replace or reload a tab. */
export function registerOffline(): void {
  if (registrationStarted) return;
  registrationStarted = true;
  if (!supported()) { publish({ phase: 'unsupported' }); return; }
  const check = () => { void checkForUpdates(); };
  const visible = () => { if (document.visibilityState === 'visible') check(); };
  window.addEventListener('online', check);
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', visible);
  window.setInterval(visible, 5 * 60 * 1000);
  if (document.readyState === 'complete') check();
  else window.addEventListener('load', check, { once: true });
}
