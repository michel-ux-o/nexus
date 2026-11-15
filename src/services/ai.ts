import type { CaptureContext, CaptureItem } from '../planning/types';

export interface AIStatus { configured: boolean; transcriptionModel: string; textModel: string }
export class APIError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); this.name = 'APIError'; }
}
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!navigator.onLine) throw new APIError('Du bist offline. Lokale Notizen und Planung funktionieren weiterhin. Für OpenAI ist eine Verbindung erforderlich.', 0, 'offline');
  let response: Response;
  try {
    response = await fetch(`/api/${path}`, { ...init, credentials: 'same-origin', cache: 'no-store', headers: { 'X-Nexus-Client': 'nexus-ui', ...init.headers } });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new APIError('Das lokale KI-Backend ist nicht erreichbar. Starte es mit „npm run api“ und versuche es erneut.', 0, 'unreachable');
  }
  let body: unknown;
  try { body = await response.json(); } catch { throw new APIError('Das KI-Backend hat keine gültige Antwort geliefert. Prüfe, ob es gestartet ist.', response.status, 'invalid-response'); }
  if (!response.ok) {
    const detail = (body && typeof body === 'object' ? body : {}) as { error?: string; code?: string };
    throw new APIError(typeof detail.error === 'string' ? detail.error : 'Die KI-Anfrage ist fehlgeschlagen. Bitte erneut versuchen.', response.status, detail.code);
  }
  return body as T;
}
function json<T>(path: string, body: unknown, signal?: AbortSignal) {
  return request<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
}
export const api = {
  async getStatus(signal?: AbortSignal): Promise<AIStatus> {
    const status = await request<AIStatus>('status', { signal });
    if (typeof status.configured !== 'boolean' || typeof status.transcriptionModel !== 'string' || typeof status.textModel !== 'string') throw new APIError('Ungültige Backend-Konfiguration empfangen.', 502, 'invalid-response');
    return status;
  },
  async transcribe(blob: Blob, context: CaptureContext, signal?: AbortSignal): Promise<{ transcript: string }> {
    const form = new FormData();
    const extension = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : blob.type.includes('wav') ? 'wav' : 'webm';
    form.append('audio', blob, `aufnahme.${extension}`);
    for (const [key, value] of Object.entries(context)) form.append(key, value);
    const result = await request<{ transcript: string }>('transcribe', { method: 'POST', body: form, signal });
    if (!result || typeof result.transcript !== 'string' || result.transcript.length > 200000) throw new APIError('Die Transkription enthält keinen gültigen Text. Bitte erneut versuchen.', 502, 'invalid-response');
    return result;
  },
  async interpret(transcript: string, context: CaptureContext, signal?: AbortSignal): Promise<{ items: CaptureItem[] }> {
    const result = await json<{ items: CaptureItem[] }>('interpret', { ...context, transcript }, signal);
    if (!result || !Array.isArray(result.items) || result.items.length > 100) throw new APIError('Die Auswertung enthält keine gültige Aufgabenliste.', 502, 'invalid-response');
    return result;
  },
  async assist(prompt: string, action: string, operationId: string, signal?: AbortSignal): Promise<{ text: string }> {
    const result = await json<{ text: string }>('assist', { operationId, action, prompt }, signal);
    if (!result || typeof result.text !== 'string' || result.text.length > 200000) throw new APIError('Die KI-Antwort enthält keinen gültigen Vorschlag.', 502, 'invalid-response');
    return result;
  },
};
