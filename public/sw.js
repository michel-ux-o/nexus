/*
 * Native production-only app-shell cache, without runtime/API caching.
 * The production build stamps its identity into both this worker and HTML. On
 * install verify that identity and discover local hashed imports, lazy chunks, CSS
 * URLs, and fonts recursively. A failed asset fetch fails the whole install.
 * Bump CACHE_SCHEMA when changing this worker's cache/discovery semantics.
 * Updates wait for tabs to close or an explicit guarded request from the only
 * open app window. Retain old assets for old documents, including back/forward
 * cache restores; automatic activation never discards another tab's assets.
 */
const CACHE_SCHEMA = 3;
const BUILD = /* __NEXUS_BUILD__ */ null;
const SCOPE = new URL(self.registration.scope);
const SHELL = new URL('index.html', SCOPE);
const ASSET_ROOT = new URL('assets/', SCOPE).pathname;
const BUILD_INFO = new URL('build.json', SCOPE);
const CACHE_PREFIX = `nexus-notes:${SCOPE.pathname}:`;
const CACHE_NAME = `${CACHE_PREFIX}v${CACHE_SCHEMA}:${BUILD?.id}`;
// Vite's default content hashes distinguish build files from text literals such
// as "example.js" in the application, or ordinary API/static URLs.
const BUILD_FILENAME = /-[a-z\d_-]{8,}\.(?:m?js|css|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|wasm)$/i;

function isBuildAsset(url) {
  return url.origin === SCOPE.origin && url.pathname.startsWith(ASSET_ROOT)
    && BUILD_FILENAME.test(url.pathname);
}

function assetURL(path, parent) {
  try {
    // Vite's __vite__mapDeps arrays use paths relative to the application root.
    const url = new URL(path, path.startsWith('assets/') ? SCOPE : parent);
    url.hash = '';
    return isBuildAsset(url) ? url : null;
  } catch {
    return null;
  }
}

function attribute(tag, name) {
  const value = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, 'i'));
  return (value?.[1] ?? value?.[2] ?? value?.[3] ?? '').replace(/&amp;/g, '&');
}

function initialAssets(html) {
  const assets = new Set();
  for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const script = /^<script\b/i.test(tag);
    const rel = attribute(tag, 'rel').toLowerCase().split(/\s+/);
    if (script ? attribute(tag, 'type').toLowerCase() !== 'module'
      : !rel.some((value) => value === 'stylesheet' || value === 'modulepreload')) continue;
    const url = assetURL(attribute(tag, script ? 'src' : 'href'), SHELL);
    if (url) assets.add(url.href);
  }
  return assets;
}

function referencedAssets(source, parent) {
  const urls = new Set();
  const add = (path) => {
    const url = assetURL(path, parent);
    if (url) urls.add(url.href);
  };
  // Matches Vite's static/dynamic import paths, preload maps and asset literals.
  for (const match of source.matchAll(/(["'`])([^"'`\\\s<>]+\.(?:m?js|css|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|wasm)(?:\?[^"'`\\\s<>]*)?)\1/gi)) {
    add(match[2]);
  }
  for (const match of source.matchAll(/\burl\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)]+))\s*\)/gi)) {
    add(match[1] ?? match[2] ?? match[3]);
  }
  return urls;
}

async function fetchStatic(url, html = false) {
  const response = await fetch(url, { cache: 'reload', credentials: 'same-origin' });
  const type = response.headers.get('content-type') ?? '';
  if (!response.ok || response.redirected || response.type === 'opaque'
    || (html ? !type.includes('text/html') : type.includes('text/html'))) {
    throw new Error(`Offline-Datei nicht verfügbar: ${url}`);
  }
  return response;
}

async function precache() {
  if (!BUILD?.id || !Number.isFinite(Date.parse(BUILD.builtAt))) throw new Error('Fehlende Build-Kennung.');
  // An old document or stale server must never replace a more recent cache.
  for (const key of await caches.keys()) {
    if (!key.startsWith(CACHE_PREFIX)) continue;
    const previous = await (await caches.open(key)).match(BUILD_INFO.href);
    if (previous && Date.parse((await previous.json()).builtAt) > Date.parse(BUILD.builtAt)) {
      throw new Error('Ein neuerer Build ist bereits installiert.');
    }
  }
  const shell = await fetchStatic(SHELL.href, true);
  const html = await shell.clone().text();
  const meta = [...html.matchAll(/<meta\b[^>]*>/gi)].map(([tag]) => tag)
    .find(tag => attribute(tag, 'name') === 'nexus-build');
  if (!meta || attribute(meta, 'content') !== BUILD.id) throw new Error('Der Build hat sich während der Einrichtung geändert.');
  const assets = initialAssets(html);
  if (![...assets].some((path) => /\.m?js(?:\?|$)/.test(path))) {
    throw new Error('Kein Produktions-Bundle gefunden.');
  }
  const cache = await caches.open(CACHE_NAME);
  try {
    // Set iteration also visits newly discovered chunks; every URL is fetched once.
    for (const path of assets) {
      const response = await fetchStatic(path);
      if (/\.(?:m?js|css)(?:\?|$)/i.test(path)) {
        for (const dependency of referencedAssets(await response.clone().text(), path)) assets.add(dependency);
      }
      await cache.put(path, response);
    }
    await cache.put(SHELL.href, shell);
    await cache.put(BUILD_INFO.href, new Response(JSON.stringify(BUILD), { headers: { 'content-type': 'application/json' } }));
  } catch (error) {
    await caches.delete(CACHE_NAME);
    throw error;
  }
}

self.addEventListener('install', (event) => event.waitUntil(precache()));

self.addEventListener('activate', (event) => {
  // Old hashed assets remain available even if an old tab is restored from
  // the browser's back/forward cache after this activation.
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const port = event.ports?.[0];
  if (!port) return;
  if (event.data?.type === 'NEXUS_BUILD_INFO') { port.postMessage({ build: BUILD }); return; }
  if (event.data?.type !== 'NEXUS_ACTIVATE_UPDATE') return;
  event.waitUntil((async () => {
    const source = event.source;
    if (!source?.id || event.data.buildId !== BUILD?.id) { port.postMessage({ ok: false, reason: 'build-changed' }); return; }
    const windows = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .filter(client => { const url = new URL(client.url); return url.origin === SCOPE.origin && url.pathname.startsWith(SCOPE.pathname); });
    if (!windows.some(client => client.id === source.id) || windows.some(client => client.id !== source.id)) {
      port.postMessage({ ok: false, reason: 'other-tabs' }); return;
    }
    port.postMessage({ ok: true });
    await self.skipWaiting();
  })());
});

function isAppNavigation(url) {
  if (!url.pathname.startsWith(SCOPE.pathname)) return false;
  const route = url.pathname.slice(SCOPE.pathname.length);
  if (/^(?:api|graphql|rpc)(?:\/|$)/i.test(route)) return false;
  const lastSegment = route.split('/').pop() ?? '';
  return !lastSegment.includes('.') || /\.html$/i.test(lastSegment);
}

async function navigate(request) {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 4000);
  try {
    const response = await fetch(request, { signal: abort.signal });
    if (response.ok) return response;
  } catch {
    // Includes unavailable network and a stalled connection.
  } finally {
    clearTimeout(timeout);
  }
  const cache = await caches.open(CACHE_NAME);
  const shell = await cache.match(SHELL.href);
  return shell ?? new Response('NEXUS ist offline noch nicht verfügbar. Bitte einmal online öffnen.', {
    status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== SCOPE.origin) return;

  if (request.mode === 'navigate' && isAppNavigation(url)) {
    event.respondWith(navigate(request));
  } else if (isBuildAsset(url)) {
    // Only installation-discovered resources are cached. Unknown assets go to
    // the network and are never added, so no API or external response is stored.
    // Static hosts may add Vary: Origin. Module/stylesheet CORS requests carry
    // Origin, whereas install-time same-origin fetches do not. These exact,
    // content-hashed, same-origin files have one representation for this app.
    event.respondWith((async () => {
      const own = await (await caches.open(CACHE_NAME)).match(request, { ignoreVary: true });
      if (own) return own;
      // Exact content-hashed URLs are safe across builds. Never serve another
      // build's HTML or downgrade the current navigation shell.
      for (const key of await caches.keys()) {
        if (!key.startsWith(CACHE_PREFIX) || key === CACHE_NAME) continue;
        const old = await (await caches.open(key)).match(request, { ignoreVary: true });
        if (old) return old;
      }
      return fetch(request);
    })());
  }
});
