/// <reference types="vite/client" />

let registrationStarted = false;

/** Register after the first production page load. Registration alone is not offline readiness. */
export function registerOffline(): void {
  if (registrationStarted || !import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  registrationStarted = true;

  const register = async (): Promise<void> => {
    const base = new URL(import.meta.env.BASE_URL, window.location.href);
    const assets = new Set<string>();
    const assetRoot = new URL('assets/', base).pathname;
    const buildFilename = /-[a-z\d_-]{8,}\.(?:m?js|css)$/i;

    document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>(
      'script[type="module"][src],link[rel~="stylesheet"][href],link[rel~="modulepreload"][href]',
    ).forEach((element) => {
      const path = element.getAttribute('src') ?? element.getAttribute('href');
      if (!path) return;
      const url = new URL(path, document.baseURI);
      if (url.origin === base.origin && url.pathname.startsWith(assetRoot) && buildFilename.test(url.pathname)) {
        url.hash = '';
        assets.add(url.href);
      }
    });

    if (assets.size === 0) return;
    // CSS can change without changing the entry JS. Include every initial build asset.
    const digest = await crypto.subtle.digest(
      'SHA-256', new TextEncoder().encode([...assets].sort().join('\n')),
    );
    const revision = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const worker = new URL('sw.js', base);
    worker.searchParams.set('build', revision);

    await navigator.serviceWorker.register(worker, { scope: base.pathname, updateViaCache: 'none' });
    // No automatic skipWaiting: existing tabs retain their coherent app version.
  };

  const start = (): void => {
    void register().catch((error: unknown) => {
      console.warn('NEXUS: Offline-Einrichtung nicht abgeschlossen.', error);
    });
  };

  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}
