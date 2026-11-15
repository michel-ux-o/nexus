import { createHash } from 'node:crypto';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const LIMITS = Object.freeze({ audio: 20 * 1024 * 1024, json: 256 * 1024, transcript: 60_000, prompt: 100_000, output: 120_000, upstream: 2 * 1024 * 1024, items: 100 });
const fields = ['itemId', 'intent', 'sourceText', 'title', 'description', 'priority', 'estimatedMinutes', 'dueDate', 'plannedDate', 'plannedWeek', 'startTime', 'durationMinutes', 'questions', 'suggestions'];
const nullableString = { type: ['string', 'null'] };
const nullableMinutes = { type: ['integer', 'null'], minimum: 1, maximum: 1440 };
export const CAPTURE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: { items: { type: 'array', maxItems: LIMITS.items, items: {
    type: 'object', additionalProperties: false, required: fields,
    properties: {
      itemId: { type: 'string' }, intent: { type: 'string', enum: ['create', 'change', 'delete', 'unclear'] },
      sourceText: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' },
      priority: { type: ['string', 'null'], enum: ['low', 'normal', 'high', null] },
      estimatedMinutes: nullableMinutes, dueDate: nullableString, plannedDate: nullableString,
      plannedWeek: nullableString, startTime: nullableString, durationMinutes: nullableMinutes,
      questions: { type: 'array', items: { type: 'string' }, maxItems: 20 },
      suggestions: { type: 'array', items: { type: 'string' }, maxItems: 20 },
    },
  } } },
};

export function exactObject(value, keys, label = 'Anfrage') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new ApiError(400, 'INVALID_INPUT', `${label}: unerwartete oder fehlende Felder.`);
  }
  return value;
}

export function string(value, label, max, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()) || value.includes('\u0000')) {
    throw new ApiError(400, 'INVALID_INPUT', `${label} ist leer, zu lang oder ungültig.`);
  }
  return value;
}

export function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '9999-12-31') return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function validContext(input) {
  const operationId = string(input.operationId, 'operationId', 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(operationId)) throw new ApiError(400, 'INVALID_INPUT', 'operationId enthält ungültige Zeichen.');
  const capturedAt = string(input.capturedAt, 'capturedAt', 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(capturedAt) || !isDate(capturedAt.slice(0, 10)) || !Number.isFinite(Date.parse(capturedAt)) || new Date(capturedAt).toISOString().slice(0, 19) !== capturedAt.slice(0, 19)) {
    throw new ApiError(400, 'INVALID_INPUT', 'capturedAt muss ein gültiger UTC-ISO-Zeitpunkt sein.');
  }
  const timeZone = string(input.timeZone, 'timeZone', 100);
  try { new Intl.DateTimeFormat('en', { timeZone }).format(); } catch { throw new ApiError(400, 'INVALID_INPUT', 'Ungültige IANA-Zeitzone.'); }
  return { operationId, capturedAt, timeZone };
}

export function interpretationInput(input) {
  exactObject(input, ['operationId', 'transcript', 'capturedAt', 'timeZone']);
  return { ...validContext(input), transcript: string(input.transcript, 'Transkript', LIMITS.transcript) };
}

export function assistanceInput(input) {
  exactObject(input, ['operationId', 'action', 'prompt']);
  const operationId = string(input.operationId, 'operationId', 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(operationId)) throw new ApiError(400, 'INVALID_INPUT', 'Ungültige operationId.');
  return { operationId, action: string(input.action, 'Aktion', 100), prompt: string(input.prompt, 'Prompt', LIMITS.prompt) };
}

export function hash(value) { return createHash('sha256').update(value).digest('hex'); }
export function dateInZone(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant));
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function addDays(date, days) { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function monday(date) { return addDays(date, -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7)); }

// Count matching real instants instead of silently normalizing a DST gap/fold.
export function localTimeMatches(date, time, timeZone) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const offsets = new Set();
  for (const delta of [-36, -12, 0, 12, 36]) {
    const instant = wall + delta * 3600_000;
    const p = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(part => [part.type, part.value]));
    offsets.add(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - instant);
  }
  let matches = 0;
  for (const offset of offsets) {
    const p = Object.fromEntries(formatter.formatToParts(new Date(wall - offset)).map(part => [part.type, part.value]));
    if (`${p.year}-${p.month}-${p.day}` === date && `${p.hour}:${p.minute}` === time) matches++;
  }
  return matches;
}

function stringArray(value) { return Array.isArray(value) && value.length <= 20 && value.every(entry => typeof entry === 'string' && !!entry.trim() && entry.length <= 2000 && !entry.includes('\u0000')); }
function validMinutes(value) { return value === null || Number.isInteger(value) && value >= 1 && value <= 1440; }

export function validateCaptureOutput(value, context) {
  try {
    exactObject(value, ['items'], 'Modellantwort');
    if (!Array.isArray(value.items) || value.items.length > LIMITS.items) throw new Error();
    const occurrences = new Map();
    return { items: value.items.map(original => {
      exactObject(original, fields, 'CaptureItem');
      for (const [key, max] of [['itemId', 200], ['sourceText', LIMITS.transcript], ['title', 500], ['description', 10_000]]) string(original[key], key, max, true);
      if (!['create', 'change', 'delete', 'unclear'].includes(original.intent) || !['low', 'normal', 'high', null].includes(original.priority) || !validMinutes(original.estimatedMinutes) || !validMinutes(original.durationMinutes) || !stringArray(original.questions) || !stringArray(original.suggestions)) throw new Error();
      for (const key of ['dueDate', 'plannedDate', 'plannedWeek']) if (original[key] !== null && !isDate(original[key])) throw new Error();
      if (original.startTime !== null && (typeof original.startTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(original.startTime))) throw new Error();
      const item = { ...original, questions: [...original.questions], suggestions: [...original.suggestions] };
      const ask = question => { if (!item.questions.includes(question)) item.questions.push(question); };
      const sourceValid = item.sourceText.trim().length > 0 && context.transcript.includes(item.sourceText);
      if (!sourceValid) { item.intent = 'unclear'; ask('Welche genaue Stelle des Transkripts beschreibt diesen Vorschlag?'); }
      const occurrence = (occurrences.get(item.sourceText) ?? 0) + 1;
      occurrences.set(item.sourceText, occurrence);
      item.itemId = `capture-${hash(item.sourceText).slice(0, 40)}-${occurrence}`;
      if (sourceValid && occurrence > context.transcript.split(item.sourceText).length - 1) {
        item.intent = 'unclear'; ask('Dieselbe Textstelle wurde mehrfach als Aufgabe erkannt. Welche Aufgabe soll übernommen werden?');
      }
      if (!item.title.trim()) { item.intent = 'unclear'; ask('Wie soll die Aufgabe heißen?'); }
      if (item.intent === 'change' || item.intent === 'delete') ask('Bitte die bestehende Aufgabe manuell auswählen und die Änderung oder Löschung bestätigen.');
      if (item.intent === 'unclear' && item.questions.length === 0) ask('Soll daraus eine neue Aufgabe entstehen, und welche Angaben gelten?');
      if (item.plannedWeek !== null && monday(item.plannedWeek) !== item.plannedWeek) ask('An welchem Montag beginnt die gewünschte Planungswoche?');
      if (item.plannedDate !== null && item.plannedWeek !== null) ask('Soll die Aufgabe an einem bestimmten Tag oder im Wochenpool geplant werden?');
      if (item.startTime !== null && item.plannedDate === null) ask('An welchem Datum soll der Zeitblock beginnen?');
      if (item.startTime !== null && item.durationMinutes === null) ask('Wie viele Minuten soll der Zeitblock dauern?');
      if (item.durationMinutes !== null && item.startTime === null) ask('Um welche Uhrzeit soll der Zeitblock beginnen?');
      if (item.plannedDate !== null && item.startTime !== null) {
        const matches = localTimeMatches(item.plannedDate, item.startTime, context.timeZone);
        if (matches === 0) ask('Diese Uhrzeit existiert wegen der Zeitumstellung nicht. Welche Uhrzeit gilt?');
        if (matches > 1) ask('Diese Uhrzeit kommt bei der Zeitumstellung zweimal vor. Bitte den Zeitpunkt manuell festlegen.');
      }
      if (item.dueDate && item.plannedDate && item.plannedDate > item.dueDate) ask('Die Planung liegt nach der Fälligkeit. Ist das beabsichtigt?');
      if (item.dueDate && item.plannedWeek && item.plannedWeek > item.dueDate) ask('Die Planungswoche beginnt nach der Fälligkeit. Ist das beabsichtigt?');
      if (sourceValid) {
        const today = dateInZone(context.capturedAt, context.timeZone);
        const source = item.sourceText.toLocaleLowerCase('de');
        const hasDateCue = /\b(?:heute|morgen|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|woche|monat|jahr|januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember)\b/u.test(source) || /übermorgen|\b\d{1,4}[./-]\d{1,2}|\bin\s+(?:\d+|einer?|zwei|drei|vier|fünf|sechs|sieben)\s+tagen?\b/u.test(source);
        if ((item.plannedDate || item.plannedWeek || item.dueDate) && !hasDateCue) ask('Im Quelltext ist kein eindeutiger Datumsbezug erkennbar. Welches Datum gilt?');
        if (item.plannedWeek && !/woche/u.test(source)) ask('Wurde die Planung für eine ganze Woche ausdrücklich gewünscht?');
        if (item.dueDate && !/\bbis\b|spätestens|fällig|deadline|abgabe|frist|abgeben/u.test(source)) ask('Ist das genannte Datum eine Fälligkeit oder ein gewünschter Planungstag?');
        if (item.startTime && !/\buhr\b|\b\d{1,2}[:.]\d{2}\b|\b(?:um|ab|von)\s+(?:\d{1,2}|eins?|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf)\b/u.test(source)) ask('Welche ausdrücklich gewünschte Startuhrzeit gilt?');
        if ((item.estimatedMinutes || item.durationMinutes) && !/minute|stunde|\b\d+\s*(?:min|h|m)\b/u.test(source)) ask('Wurde die geschätzte Dauer ausdrücklich genannt?');
        const relative = /(?:^|\s|[,;])übermorgen\b/u.test(source) ? addDays(today, 2) : /\bmorgen\b/u.test(source) && !/\bheute\b/u.test(source) ? addDays(today, 1) : /\bheute\b/u.test(source) && !/\bmorgen\b/u.test(source) ? today : null;
        const actualDates = [item.plannedDate, item.dueDate].filter(Boolean);
        if (relative && actualDates.length && !actualDates.includes(relative)) ask('Die relative Datumsangabe passt nicht zum Aufnahmezeitpunkt. Welches Datum gilt?');
        if (/nächste[nr]?\s+woche/u.test(source) && item.plannedWeek && item.plannedWeek !== addDays(monday(today), 7)) ask('Die nächste Woche beginnt am folgenden Montag. Bitte den Planungszeitraum prüfen.');
        const explicitDates = [...source.matchAll(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g)].map(match => `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`);
        explicitDates.push(...source.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []);
        if (explicitDates.length === 1 && actualDates.length && !actualDates.includes(explicitDates[0])) ask('Das erkannte Datum weicht vom ausdrücklich genannten Datum ab. Welches Datum gilt?');
      }
      return item;
    }) };
  } catch {
    throw new ApiError(502, 'INVALID_MODEL_OUTPUT', 'Die KI-Antwort enthält ungültige oder unvollständige Aufgaben. Bitte erneut versuchen.');
  }
}
