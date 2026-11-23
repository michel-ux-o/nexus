import { ApiError, exactObject } from './validation.mjs';

export const MAX_WORKSPACE_REQUEST_BYTES = 50 * 1024 * 1024;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let validator;

async function sharedValidator() {
  // Created during build/start by scripts/build-sync-validator.mjs. Loading on
  // demand keeps the local-only server independent of cloud configuration.
  validator ??= import('../.work/sync-validator/data/workspaceBackup.js').then(module => module.parseWorkspaceBackup ?? module.default?.parseWorkspaceBackup);
  try {
    const parse = await validator;
    if (typeof parse !== 'function') throw new Error('missing validator');
    return parse;
  } catch {
    throw new ApiError(503, 'SYNC_NOT_CONFIGURED', 'Die Workspace-Synchronisierung wird gerade eingerichtet. Bitte versuche es später erneut.');
  }
}

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function revision(value, min = 0) { return Number.isSafeInteger(value) && value >= min; }
function timestamp(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }

async function checkedSnapshot(value, stored = false) {
  const parse = await sharedValidator();
  try {
    if (!object(value) || value.format !== 'nexus-workspace' || value.version !== 4) throw new Error();
    return parse(JSON.stringify(value));
  } catch {
    if (stored) throw new ApiError(503, 'INVALID_CLOUD_WORKSPACE', 'Der gespeicherte Workspace konnte nicht sicher gelesen werden. Deine lokalen Daten bleiben erhalten.');
    throw new ApiError(400, 'INVALID_WORKSPACE', 'Der Workspace ist unvollständig oder ungültig. Bitte prüfe die Daten vor einer erneuten Synchronisierung.');
  }
}

function unavailable() {
  return new ApiError(503, 'SYNC_UNAVAILABLE', 'Die Workspace-Synchronisierung ist gerade nicht erreichbar. Bitte versuche es erneut.');
}

async function responseJson(response, maxBytes) {
  // A remote response is still an input. Bound it before allocating/parsing the
  // entire snapshot, and never pass provider diagnostics through to the client.
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw unavailable();
  if (!response.body) throw unavailable();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw unavailable(); }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  } catch { throw unavailable(); }
  finally { reader.releaseLock(); }
}

/** Server-only snapshot storage. Account IDs must come from cloud-auth. */
export function createWorkspaceSync({ env = process.env, fetchImpl = fetch } = {}) {
  let origin;
  try {
    const parsed = new URL(env.SUPABASE_URL);
    if (parsed.protocol === 'https:' && parsed.origin === env.SUPABASE_URL && !parsed.username && !parsed.password) origin = parsed.origin;
  } catch { /* Missing configuration fails only the sync endpoint. */ }
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

  function requireAccount(account) {
    if (!object(account) || !ID_PATTERN.test(account.id ?? '')) throw new ApiError(401, 'AUTH_REQUIRED', 'Bitte melde dich an.');
    if (!origin || !serviceKey) throw new ApiError(503, 'SYNC_NOT_CONFIGURED', 'Die Workspace-Synchronisierung wird gerade eingerichtet. Bitte versuche es später erneut.');
    return account.id;
  }

  async function request(path, { method = 'GET', body, signal } = {}) {
    let response;
    try {
      response = await fetchImpl(`${origin}/rest/v1/${path}`, {
        method,
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000), redirect: 'error',
      });
    } catch { throw unavailable(); }
    const data = await responseJson(response, method === 'GET' && response.ok ? MAX_WORKSPACE_REQUEST_BYTES + 64 * 1024 : 16 * 1024);
    if (!response.ok) {
      if (data?.code === '40001' && data.message === 'NEXUS_REVISION_CONFLICT') throw new ApiError(409, 'REVISION_CONFLICT', 'Der Workspace wurde inzwischen auf einem anderen Gerät geändert. Bitte lade zuerst den aktuellen Stand.');
      if (data?.code === '22023' && data.message === 'NEXUS_MUTATION_REUSED') throw new ApiError(409, 'MUTATION_REUSED', 'Diese Synchronisierungskennung gehört bereits zu einer anderen Änderung. Bitte lade zuerst den aktuellen Stand.');
      if (data?.code === '42501' && data.message === 'NEXUS_CONFIRMED_ACCOUNT_REQUIRED') throw new ApiError(401, 'AUTH_REQUIRED', 'Bitte melde dich erneut an.');
      throw unavailable();
    }
    return data;
  }

  async function get(account, signal) {
    const ownerId = requireAccount(account);
    const query = new URLSearchParams({ owner_id: `eq.${ownerId}`, select: 'owner_id,revision,snapshot,committed_at', limit: '1' });
    const rows = await request(`nexus_workspace?${query}`, { signal });
    if (!Array.isArray(rows) || rows.length > 1) throw unavailable();
    if (!rows.length) return { revision: 0, snapshot: null, committedAt: null };
    const row = rows[0];
    if (!object(row) || row.owner_id !== ownerId || !revision(row.revision, 1) || !timestamp(row.committed_at)) throw unavailable();
    const snapshot = await checkedSnapshot(row.snapshot, true);
    return { revision: row.revision, snapshot, committedAt: row.committed_at };
  }

  async function put(account, input, signal) {
    const ownerId = requireAccount(account);
    exactObject(input, ['expectedRevision', 'mutationId', 'snapshot'], 'Synchronisierung');
    if (!revision(input.expectedRevision) || input.expectedRevision >= Number.MAX_SAFE_INTEGER || typeof input.mutationId !== 'string' || !ID_PATTERN.test(input.mutationId)) throw new ApiError(400, 'INVALID_INPUT', 'Die Synchronisierung benötigt eine gültige Revision und eine UUID als Änderungskennung.');
    const snapshot = await checkedSnapshot(input.snapshot);
    const data = await request('rpc/nexus_commit_workspace', { method: 'POST', body: {
      p_owner_id: ownerId, p_expected_revision: input.expectedRevision, p_mutation_id: input.mutationId, p_snapshot: snapshot,
    }, signal });
    if (!object(data) || !revision(data.revision, 1) || !timestamp(data.committedAt) || typeof data.replayed !== 'boolean' || data.revision !== input.expectedRevision + 1) throw unavailable();
    return { revision: data.revision, committedAt: data.committedAt, replayed: data.replayed };
  }

  return { get, put };
}
