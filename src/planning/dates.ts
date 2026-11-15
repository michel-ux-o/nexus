const zoneFormatters = new Map<string, Intl.DateTimeFormat>();
function zoneFormatter(zone: string): Intl.DateTimeFormat {
  const cached = zoneFormatters.get(zone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, calendar: 'gregory', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit',
    era: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  if (zoneFormatters.size >= 100) zoneFormatters.clear();
  zoneFormatters.set(zone, formatter);
  return formatter;
}

/** Calendar dates are civil dates, never UTC slices of a user's instant. */
export function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  if (year < 1) return false;
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 100 || /^[+-]/.test(value)) return false;
  try { zoneFormatter(value); return true; }
  catch { return false; }
}

function instantDate(value: string | Date): Date {
  const result = new Date(value instanceof Date ? value.getTime() : value);
  if (!Number.isFinite(result.getTime())) throw new Error('Der Zeitpunkt ist ungültig.');
  return result;
}

function parts(instant: string | Date, zone: string): Record<string, string> {
  if (!isTimeZone(zone)) throw new Error('Bitte wähle eine gültige Zeitzone.');
  return Object.fromEntries(zoneFormatter(zone).formatToParts(instantDate(instant)).map((part) => [part.type, part.value]));
}

export function dateInZone(instant: string | Date, zone: string): string {
  const value = parts(instant, zone);
  const year = value.era === 'BC' ? 1 - Number(value.year) : Number(value.year);
  return `${String(year).padStart(4, '0')}-${value.month}-${value.day}`;
}

export function todayInZone(zone: string, now = new Date()): string { return dateInZone(now, zone); }

export function addDays(date: string, count: number): string {
  if (!isDate(date) || !Number.isInteger(count)) throw new Error('Datum oder Anzahl der Tage ist ungültig.');
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + count);
  const result = value.toISOString().slice(0, 10);
  if (!isDate(result)) throw new Error('Das Datum liegt außerhalb des unterstützten Kalenderbereichs.');
  return result;
}

export function startOfWeek(date: string): string {
  if (!isDate(date)) throw new Error('Das Wochendatum ist ungültig.');
  const day = new Date(`${date}T12:00:00.000Z`).getUTCDay();
  return addDays(date, -((day + 6) % 7));
}

export function weekDates(date: string): string[] {
  const monday = startOfWeek(date);
  return Array.from({ length: Math.min(7, daysBetween(monday, '9999-12-31') + 1) }, (_, index) => addDays(monday, index));
}

export function formatDate(date: string, options?: Intl.DateTimeFormatOptions): string {
  if (!isDate(date)) throw new Error('Das Datum ist ungültig.');
  return new Intl.DateTimeFormat('de-DE', {
    ...(options ?? { day: 'numeric', month: 'long', year: 'numeric' }), timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00.000Z`));
}

export function localTime(instant: string | Date, zone: string): string {
  const value = parts(instant, zone);
  return `${value.hour}:${value.minute}`;
}

export function localSubMinute(instant: string | Date, zone: string): number {
  return Number(parts(instant, zone).second) * 1000 + instantDate(instant).getUTCMilliseconds();
}

export function formatTime(instant: string | Date, zone: string): string { return localTime(instant, zone); }

export function daysBetween(from: string, to: string): number {
  if (!isDate(from) || !isDate(to)) throw new Error('Das Kalenderdatum ist ungültig.');
  return Math.round((Date.parse(`${to}T12:00:00.000Z`) - Date.parse(`${from}T12:00:00.000Z`)) / 86_400_000);
}

const boundaries = new Map<string, number>();
/** The first actual instant on or after this civil date, including skipped midnights/days. */
export function dayBoundary(date: string, zone: string): number {
  // The exclusive boundary after the last supported input date is internal only.
  if ((!isDate(date) && date !== '10000-01-01') || !isTimeZone(zone)) throw new Error('Datum oder Zeitzone ist ungültig.');
  const key = `${zone}\u0000${date}`;
  const cached = boundaries.get(key);
  if (cached !== undefined) return cached;
  let result: number;
  try { result = Date.parse(localToInstant(date, '00:00', zone, 'earlier')); }
  catch {
    let low = Date.parse(`${date === '10000-01-01' ? '+010000-01-01' : date}T00:00:00.000Z`) - 36 * 3_600_000;
    let high = low + 72 * 3_600_000;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (dateInZone(new Date(middle), zone).padStart(12, '0') < date.padStart(12, '0')) low = middle + 1;
      else high = middle;
    }
    result = low;
  }
  if (boundaries.size >= 2000) boundaries.clear();
  boundaries.set(key, result);
  return result;
}

export function dayBounds(date: string, zone: string): [number, number] {
  return [dayBoundary(date, zone), dayBoundary(date === '9999-12-31' ? '10000-01-01' : addDays(date, 1), zone)];
}

/** Resolve all real instants for a wall-clock minute, including both sides of DST. */
export function localToInstant(date: string, time: string, zone: string, choice?: 'earlier' | 'later'): string {
  if (!isDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error('Bitte gib ein gültiges Datum und eine Uhrzeit von 00:00 bis 23:59 ein.');
  }
  if (!isTimeZone(zone)) throw new Error('Bitte wähle eine gültige Zeitzone.');
  if (choice !== undefined && choice !== 'earlier' && choice !== 'later') throw new Error('Die Auswahl der Zeitumstellung ist ungültig.');
  const wall = new Date(`${date}T${time}:00.000Z`).getTime();
  const offsets = new Set<number>();
  // Offsets on both sides of any nearby transition, including half-hour DST.
  for (let hours = -48; hours <= 48; hours += 6) {
    const probe = wall + hours * 3_600_000;
    const value = parts(new Date(probe), zone);
    const year = value.era === 'BC' ? 1 - Number(value.year) : Number(value.year);
    const isoYear = year >= 0 && year <= 9999 ? String(year).padStart(4, '0') : `${year < 0 ? '-' : '+'}${String(Math.abs(year)).padStart(6, '0')}`;
    const represented = new Date(`${isoYear}-${value.month}-${value.day}T${value.hour}:${value.minute}:${value.second}.000Z`).getTime();
    offsets.add(represented - probe);
  }
  const candidates = [...offsets].map((offset) => wall - offset).filter((value) => {
    const candidate = new Date(value);
    return dateInZone(candidate, zone) === date && localTime(candidate, zone) === time;
  }).sort((left, right) => left - right);
  if (!candidates.length) throw new Error('Diese Uhrzeit existiert wegen der Zeitumstellung in dieser Zeitzone nicht. Bitte wähle eine andere Uhrzeit.');
  if (candidates.length > 1 && !choice) throw new Error('Diese Uhrzeit kommt bei der Zeitumstellung zweimal vor. Bitte wähle die frühere oder spätere Uhrzeit.');
  return new Date(choice === 'later' ? candidates[candidates.length - 1] : candidates[0]).toISOString();
}
