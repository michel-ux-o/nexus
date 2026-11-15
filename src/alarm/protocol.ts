export const ALARM_CHANNEL = 'nexus.android.alarm';
export const ALARM_BRIDGE_VERSION = 1;
const MAX_MESSAGE_LENGTH = 8_192;
export const MAX_TEXT_DOCUMENT_BYTES = 20 * 1024 * 1024;

export type AlarmMethod = 'getCapabilities' | 'openAlarmSettings' | 'consumeMorningRequest' | 'acknowledgeMorningRequest' | 'saveTextDocument';
export interface AndroidTextDocument {
  filename: string;
  mimeType: 'application/json' | 'text/plain' | 'text/csv';
  text: string;
}
export type AndroidDocumentSaveResult = 'saved' | 'cancelled';
export type AlarmRequestParams = { requestId: string } | AndroidTextDocument;
export interface AndroidAlarmCapabilities {
  platform: 'android';
  nativeAlarm: true;
  bridgeVersion: 1;
  origin: string;
  /** Older Android builds may provide alarms without a document picker. */
  textDocuments?: true;
}
export interface AndroidMorningRequest {
  requestId: string;
  requestedAt: number;
  /** Device date is informational. The planner uses its own configured zone. */
  localDate: string;
}

export function parseAlarmMessage(data: unknown): Record<string, unknown> | null {
  if (typeof data !== 'string' || data.length > MAX_MESSAGE_LENGTH) return null;
  try {
    const value: unknown = JSON.parse(data);
    return isRecord(value) ? value : null;
  } catch { return null; }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isAlarmRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
}

/** Only the declared operations are available. No native paths or URLs are accepted. */
export function encodeAlarmRequest(id: string, method: AlarmMethod, params?: AlarmRequestParams): string {
  if (!isAlarmRequestId(id)) throw new Error('Ungültige Weckeranfrage.');
  switch (method) {
    case 'getCapabilities':
    case 'openAlarmSettings':
    case 'consumeMorningRequest':
      if (params !== undefined) throw new Error('Unerwartete Weckerparameter.');
      return JSON.stringify({ id, method });
    case 'acknowledgeMorningRequest':
      if (!isRecord(params) || Object.keys(params).length !== 1 || !isAlarmRequestId(params.requestId)) {
        throw new Error('Ungültige Bestätigung des Morgenstarts.');
      }
      return JSON.stringify({ id, method, params });
    case 'saveTextDocument':
      return JSON.stringify({ id, method, params: validateTextDocument(params) });
    default: throw new Error('Diese Weckerfunktion ist nicht freigegeben.');
  }
}

export function readAlarmCapabilities(value: unknown, origin: string): AndroidAlarmCapabilities | null {
  if (!isRecord(value) || value.platform !== 'android' || value.nativeAlarm !== true ||
    value.bridgeVersion !== ALARM_BRIDGE_VERSION || value.origin !== origin) return null;
  return { platform: 'android', nativeAlarm: true, bridgeVersion: 1, origin,
    ...(value.textDocuments === true ? { textDocuments: true } : {}) };
}

export function validateTextDocument(value: unknown): AndroidTextDocument {
  if (!isRecord(value) || Object.keys(value).length !== 3 ||
    typeof value.filename !== 'string' || !value.filename.trim() || value.filename.length > 512 ||
    !['application/json', 'text/plain', 'text/csv'].includes(value.mimeType as string) ||
    typeof value.text !== 'string') throw new Error('Ungültige Datei zum Speichern.');
  // Check the cheap UTF-16 length first, then the actual encoded byte budget.
  if (value.text.length > MAX_TEXT_DOCUMENT_BYTES || new TextEncoder().encode(value.text).byteLength > MAX_TEXT_DOCUMENT_BYTES) {
    throw new Error('Die Datei ist größer als 20 MiB.');
  }
  const mimeType = value.mimeType as AndroidTextDocument['mimeType'];
  const extension = mimeType === 'application/json' ? '.json' : mimeType === 'text/csv' ? '.csv' : '.txt';
  let filename = value.filename.replace(/[\x00-\x1f\x7f\\/:*?"<>|\u202a-\u202e\u2066-\u2069]/g, '_')
    .replace(/^\.+/, '').trim().slice(0, 120);
  if (!filename) filename = 'Nexus';
  if (!filename.toLowerCase().endsWith(extension)) filename += extension;
  return { filename, mimeType, text: value.text };
}

export function readDocumentSaveResult(value: unknown): AndroidDocumentSaveResult {
  if (!isRecord(value) || (value.status !== 'saved' && value.status !== 'cancelled')) {
    throw new Error('Die Android-App hat das Speichern nicht bestätigt.');
  }
  return value.status;
}

export function readMorningRequest(value: unknown): AndroidMorningRequest | null {
  if (!isRecord(value)) throw new Error('Die Android-App hat einen ungültigen Morgenstart gesendet.');
  if (value.pending === false) return null;
  if (value.pending !== true || !isAlarmRequestId(value.requestId) ||
    typeof value.requestedAt !== 'number' || !Number.isSafeInteger(value.requestedAt) || value.requestedAt <= 0 ||
    typeof value.localDate !== 'string' || !isLocalDate(value.localDate)) {
    throw new Error('Die Android-App hat einen ungültigen Morgenstart gesendet.');
  }
  return { requestId: value.requestId, requestedAt: value.requestedAt, localDate: value.localDate };
}

function isLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
