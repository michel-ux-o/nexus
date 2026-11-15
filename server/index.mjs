import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createOpenAIClient } from './openai.mjs';
import { createCloudAuth } from './cloud-auth.mjs';
import { RequestCache } from './cache.mjs';
import { ApiError, LIMITS, assistanceInput, hash, interpretationInput, validContext } from './validation.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const audioTypes = new Map([
  ['audio/webm', 'webm'], ['video/webm', 'webm'], ['audio/mp4', 'mp4'], ['video/mp4', 'mp4'], ['audio/x-m4a', 'mp4'],
  ['audio/ogg', 'ogg'], ['application/ogg', 'ogg'], ['audio/wav', 'wav'], ['audio/wave', 'wav'], ['audio/x-wav', 'wav'],
  ['audio/mpeg', 'mpeg'], ['audio/mp3', 'mpeg'],
]);

function json(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

function isLoopback(hostname) { return ['localhost', '127.0.0.1', '[::1]'].includes(hostname); }
function normalizeOrigin(origin) {
  try {
    const url = new URL(origin);
    if (!isLoopback(url.hostname) || url.protocol !== 'http:' || url.origin !== origin) return null;
    return url.origin;
  } catch { return null; }
}
function allowedOriginSet(values) {
  const set = new Set();
  for (const value of values) {
    const origin = normalizeOrigin(value);
    if (!origin) throw new Error('NEXUS_ALLOWED_ORIGINS darf nur exakte lokale HTTP-Origins enthalten.');
    set.add(origin);
  }
  return set;
}

function guardLocalRequest(req, res, allowedOrigins, api = false) {
  const remote = req.socket.remoteAddress;
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') throw new ApiError(403, 'LOCAL_ONLY', 'Das Backend ist ausschließlich lokal erreichbar.');
  const authority = req.headers.host;
  if (typeof authority !== 'string' || !/^(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/.test(authority)) throw new ApiError(403, 'INVALID_HOST', 'Nicht erlaubter Host.');
  let hostUrl;
  try { hostUrl = new URL(`http://${authority}`); } catch { throw new ApiError(403, 'INVALID_HOST', 'Nicht erlaubter Host.'); }
  if (Number(hostUrl.port || 80) !== req.socket.localPort) throw new ApiError(403, 'INVALID_HOST', 'Nicht erlaubter Host-Port.');
  const origin = req.headers.origin;
  if (origin !== undefined) {
    const allowed = normalizeOrigin(origin);
    const ownPort = req.socket.localPort;
    const own = ['localhost', '127.0.0.1', '[::1]'].some(host => origin === `http://${host}:${ownPort}`);
    if (!allowed || (!own && !allowedOrigins.has(allowed))) throw new ApiError(403, 'INVALID_ORIGIN', 'Diese Origin darf das lokale Backend nicht verwenden.');
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else if (req.headers['sec-fetch-site'] === 'cross-site') {
    throw new ApiError(403, 'INVALID_ORIGIN', 'Eine fremde Website darf das lokale Backend nicht verwenden.');
  }
  if (api && req.method !== 'OPTIONS' && req.headers['x-nexus-client'] !== 'nexus-ui') throw new ApiError(403, 'CLIENT_HEADER_REQUIRED', 'Der NEXUS-Client-Header fehlt.');
}

async function readBody(req, limit, signal) {
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > limit)) {
    req.resume();
    throw new ApiError(413, 'BODY_TOO_LARGE', 'Die Anfrage überschreitet die erlaubte Größe.');
  }
  const chunks = [];
  let size = 0;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      req.off('data', data); req.off('end', end); req.off('error', fail); req.off('aborted', aborted);
      signal.removeEventListener('abort', abort);
    };
    const fail = error => { cleanup(); req.resume(); reject(error); };
    const aborted = () => fail(new ApiError(499, 'CANCELLED', 'Die Anfrage wurde abgebrochen.'));
    const abort = () => fail(signal.reason);
    const data = chunk => {
      size += chunk.length;
      if (size > limit) { fail(new ApiError(413, 'BODY_TOO_LARGE', 'Die Anfrage überschreitet die erlaubte Größe.')); return; }
      chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    req.on('data', data); req.once('end', end); req.once('error', fail); req.once('aborted', aborted);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function readJson(req, signal, maxBytes) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) throw new ApiError(415, 'CONTENT_TYPE', 'Content-Type application/json ist erforderlich.');
  const body = await readBody(req, maxBytes, signal);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { throw new ApiError(400, 'INVALID_JSON', 'Die Anfrage enthält kein gültiges UTF-8-JSON.'); }
}

function validAudioHeader(bytes, format) {
  if (format === 'webm') return bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3;
  if (format === 'mp4') return bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp';
  if (format === 'ogg') return bytes.length >= 4 && bytes.subarray(0, 4).toString('ascii') === 'OggS';
  if (format === 'wav') return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE';
  return bytes.length >= 3 && (bytes.subarray(0, 3).toString('ascii') === 'ID3' || bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
}

async function readAudio(req, signal, maxAudioBytes) {
  const contentType = req.headers['content-type'] ?? '';
  if (!/^multipart\/form-data\s*;/i.test(contentType) || contentType.length > 200) throw new ApiError(415, 'CONTENT_TYPE', 'Eine Multipart-Audioaufnahme ist erforderlich.');
  let body = await readBody(req, maxAudioBytes + 64 * 1024, signal);
  let form;
  try { form = await new Request('http://localhost/upload', { method: 'POST', headers: { 'Content-Type': contentType }, body }).formData(); } catch { throw new ApiError(400, 'INVALID_MULTIPART', 'Die Audioanfrage ist ungültig.'); } finally { body = null; }
  const fields = ['audio', 'operationId', 'capturedAt', 'timeZone'];
  if ([...form.keys()].length !== fields.length || fields.some(key => form.getAll(key).length !== 1)) throw new ApiError(400, 'INVALID_INPUT', 'Die Audioanfrage enthält fehlende oder doppelte Felder.');
  const context = validContext(Object.fromEntries(fields.slice(1).map(key => [key, form.get(key)])));
  const audio = form.get('audio');
  if (!(audio instanceof File) || audio.size === 0) throw new ApiError(400, 'INVALID_AUDIO', 'Die Aufnahme ist leer oder fehlt.');
  if (audio.size > maxAudioBytes) throw new ApiError(413, 'AUDIO_TOO_LARGE', 'Die Aufnahme darf höchstens 20 MiB groß sein.');
  const mime = audio.type.toLowerCase().split(';')[0].trim();
  const format = audioTypes.get(mime);
  if (!format) throw new ApiError(415, 'AUDIO_TYPE', 'Unterstützt werden WebM, MP4, Ogg, WAV und MPEG-Audio.');
  const bytes = Buffer.from(await audio.arrayBuffer());
  if (!validAudioHeader(bytes, format)) throw new ApiError(415, 'AUDIO_TYPE', 'Audioinhalt und Dateiformat stimmen nicht überein.');
  // Use our own extension and filename; never forward user-supplied paths.
  return { context, audio: new File([audio], `recording.${format === 'mpeg' ? 'mp3' : format}`, { type: mime }), digest: hash(bytes) };
}

async function serveStatic(req, res, pathname, distDir) {
  if (!['GET', 'HEAD'].includes(req.method)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Diese Methode ist nicht erlaubt.');
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { throw new ApiError(400, 'INVALID_PATH', 'Ungültiger Pfad.'); }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some(segment => segment.startsWith('.'))) throw new ApiError(404, 'NOT_FOUND', 'Datei nicht gefunden.');
  const root = await realpath(distDir).catch(() => null);
  if (!root) throw new ApiError(503, 'BUILD_MISSING', 'Die App wurde noch nicht gebaut. Bitte zuerst npm run build ausführen.');
  let target = resolve(root, `.${decoded}`);
  const isInside = path => { const rel = relative(root, path); return !rel.startsWith('..') && !isAbsolute(rel); };
  if (!isInside(target)) throw new ApiError(404, 'NOT_FOUND', 'Datei nicht gefunden.');
  let info = await stat(target).catch(() => null);
  if (!info?.isFile()) {
    if (extname(decoded)) throw new ApiError(404, 'NOT_FOUND', 'Datei nicht gefunden.');
    target = resolve(root, 'index.html');
    info = await stat(target).catch(() => null);
  }
  const actual = await realpath(target).catch(() => null);
  if (!info?.isFile() || !actual || !isInside(actual)) throw new ApiError(404, 'NOT_FOUND', 'Datei nicht gefunden.');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  res.writeHead(200, { 'Content-Type': mimeTypes[extname(target)] ?? 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': extname(target) === '.html' || target.endsWith('sw.js') ? 'no-cache' : 'public, max-age=3600' });
  res.end(req.method === 'HEAD' ? undefined : await readFile(actual));
}

export function createAppServer(options = {}) {
  const env = { ...(options.env ?? process.env) };
  // Render supplies the assigned HTTPS URL before the first service start.
  // An explicitly configured custom origin continues to take precedence.
  if (!env.APP_ORIGIN && env.NEXUS_CLOUD_MODE === '1') env.APP_ORIGIN = env.RENDER_EXTERNAL_URL;
  const cloud = env.NEXUS_CLOUD_MODE === '1';
  let publicOrigin;
  if (cloud) {
    publicOrigin = new URL(env.APP_ORIGIN ?? '');
    if (publicOrigin.protocol !== 'https:' || publicOrigin.origin !== env.APP_ORIGIN) throw new Error('APP_ORIGIN muss eine exakte HTTPS-Origin sein.');
  }
  const account = createCloudAuth({ env, fetchImpl: options.authFetchImpl ?? options.fetchImpl ?? fetch });
  const apiKey = options.apiKey ?? env.OPENAI_API_KEY ?? '';
  const transcriptionModel = options.transcriptionModel ?? env.OPENAI_TRANSCRIPTION_MODEL ?? 'gpt-transcribe';
  const textModel = options.textModel ?? env.OPENAI_TEXT_MODEL ?? 'gpt-5.6-terra';
  for (const model of [transcriptionModel, textModel]) if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(model)) throw new Error('Ungültige serverseitige Modellkonfiguration.');
  const defaults = [5173, 4173, 4175].flatMap(port => ['localhost', '127.0.0.1', '[::1]'].map(host => `http://${host}:${port}`));
  const configuredOrigins = options.allowedOrigins ?? (env.NEXUS_ALLOWED_ORIGINS ? env.NEXUS_ALLOWED_ORIGINS.split(',').map(value => value.trim()).filter(Boolean) : []);
  const allowedOrigins = allowedOriginSet([...defaults, ...configuredOrigins]);
  const cache = new RequestCache(options.cacheOptions);
  const client = createOpenAIClient({ apiKey, transcriptionModel, textModel, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs });
  const requestTimeoutMs = options.requestTimeoutMs ?? 90_000;
  const maxAudioBytes = Math.min(options.maxAudioBytes ?? LIMITS.audio, LIMITS.audio);
  const maxJsonBytes = Math.min(options.maxJsonBytes ?? LIMITS.json, LIMITS.json);
  const maxActiveRequests = options.maxActiveRequests ?? 4;
  let activeRequests = 0;
  const controllers = new Set();
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const controller = new AbortController();
    let acquired = false;
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(new Error('request timeout')), requestTimeoutMs);
    timer.unref();
    const disconnect = () => { if (!res.writableEnded) controller.abort(new Error('client disconnected')); };
    req.once('aborted', disconnect);
    res.once('close', disconnect);
    const onAbort = () => {
      if (!res.destroyed && !res.writableEnded) {
        if (res.headersSent) { res.destroy(); req.destroy(); return; }
        res.setHeader('Connection', 'close');
        json(res, 504, { error: 'Die Anfrage hat zu lange gedauert und wurde abgebrochen.', code: 'REQUEST_TIMEOUT' });
      }
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new ApiError(400, 'INVALID_PATH', 'Ungültiger Anfragepfad.');
      const url = new URL(req.url, 'http://localhost');
      const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
      if (cloud) {
        if (req.headers.host !== publicOrigin.host) throw new ApiError(403, 'INVALID_HOST', 'Nicht erlaubter Host.');
        if (isApi && (req.headers.origin !== undefined && req.headers.origin !== publicOrigin.origin || req.headers['sec-fetch-site'] === 'cross-site')) throw new ApiError(403, 'INVALID_ORIGIN', 'Diese Anfrage ist nicht erlaubt.');
        if (isApi && !['GET', 'HEAD'].includes(req.method) && req.headers.origin !== publicOrigin.origin) throw new ApiError(403, 'INVALID_ORIGIN', 'Diese Anfrage benötigt die eigene Website als Ursprung.');
      } else {
        // Configuration is public but still subject to the local host/origin guard.
        guardLocalRequest(req, res, allowedOrigins, isApi && url.pathname !== '/api/account/config');
      }
      if (url.pathname === '/api/account/config' && !cloud) { json(res, 200, { enabled: false, registrationOpen: false }); return; }
      if (cloud && await account.handle(req, res, url)) return;
      if (!isApi) { await serveStatic(req, res, url.pathname, options.distDir ?? resolve(projectRoot, 'dist')); return; }
      const verifiedAccount = cloud ? await account.authorize(req, res) : null;
      if (cloud && !verifiedAccount) { json(res, 401, { error: 'Bitte melde dich an.', code: 'AUTH_REQUIRED' }); return; }
      // Only the provider-verified identity scopes private responses. A caller's
      // operation ID or account headers must never share results across accounts.
      const cacheScope = verifiedAccount ? `${verifiedAccount.id}\0` : '';
      if (req.method === 'OPTIONS') {
        const requestedHeaders = (req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
        if (!req.headers.origin || !['GET', 'POST'].includes(req.headers['access-control-request-method']) || requestedHeaders.some(header => !['content-type', 'x-nexus-client'].includes(header))) throw new ApiError(403, 'PREFLIGHT_DENIED', 'Diese Browseranfrage ist nicht erlaubt.');
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type, X-Nexus-Client', 'Access-Control-Max-Age': '600', 'Cache-Control': 'no-store' });
        res.end(); return;
      }
      if (url.pathname === '/api/status' && req.method === 'GET') { json(res, 200, { configured: !!apiKey, transcriptionModel, textModel }); return; }
      const stage = { '/api/transcribe': 'transcribe', '/api/interpret': 'interpret', '/api/assist': 'assist' }[url.pathname];
      if (!stage) throw new ApiError(404, 'NOT_FOUND', 'API-Endpunkt nicht gefunden.');
      if (req.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Dieser API-Endpunkt benötigt POST.');
      if (!apiKey) throw new ApiError(503, 'NOT_CONFIGURED', 'Das KI-Backend ist nicht eingerichtet. OPENAI_API_KEY muss nur im Serverprozess gesetzt sein.');
      if (activeRequests >= maxActiveRequests) throw new ApiError(429, 'BUSY', 'Das lokale Backend ist ausgelastet. Bitte kurz warten.');
      activeRequests++; acquired = true;
      let result;
      if (stage === 'transcribe') {
        let input = await readAudio(req, controller.signal, maxAudioBytes);
        try { result = await cache.run(stage, `${cacheScope}${input.context.operationId}`, hash(JSON.stringify({ ...input.context, digest: input.digest, type: input.audio.type })), () => client.transcribe(input.audio, controller.signal)); } finally { input = null; }
      } else {
        const value = await readJson(req, controller.signal, maxJsonBytes);
        const input = stage === 'interpret' ? interpretationInput(value) : assistanceInput(value);
        result = await cache.run(stage, `${cacheScope}${input.operationId}`, hash(JSON.stringify(input)), () => client[stage](input, controller.signal));
      }
      controller.signal.throwIfAborted();
      json(res, 200, result);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (res.headersSent) { res.destroy(); return; }
      if (error instanceof ApiError && error.status === 413) {
        res.setHeader('Connection', 'close');
      }
      if (error instanceof ApiError) json(res, error.status, { error: error.message, code: error.code });
      else json(res, 500, { error: 'Das lokale Backend konnte die Anfrage nicht verarbeiten.', code: 'INTERNAL_ERROR' });
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      req.off('aborted', disconnect);
      res.off('close', disconnect);
      controllers.delete(controller);
      if (acquired) activeRequests--;
    }
  });
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = Math.min(requestTimeoutMs, 15_000);
  server.on('close', () => { for (const controller of controllers) controller.abort(); cache.clear(); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const cloud = process.env.NEXUS_CLOUD_MODE === '1';
  const port = Number(cloud ? process.env.PORT ?? 10000 : process.env.NEXUS_API_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('NEXUS_API_PORT muss zwischen 1 und 65535 liegen.');
  const server = createAppServer();
  server.on('error', () => { console.error('NEXUS konnte den lokalen Server nicht starten. Bitte Port und Konfiguration prüfen.'); process.exitCode = 1; });
  server.listen(port, cloud ? '0.0.0.0' : '127.0.0.1', () => console.info(cloud ? `NEXUS Cloud hört auf Port ${port}.` : `NEXUS läuft lokal unter http://127.0.0.1:${port}. API-Konfiguration ist über /api/status prüfbar.`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeAllConnections(); });
}
