import { useId } from 'react';
import { dateInZone, formatTime, isDate, localTime, localToInstant, todayInZone } from '../dates';

export interface TimeDraft {
  date: string;
  time: string;
  duration: string;
  choice: '' | 'earlier' | 'later';
  sourceStartAt?: string;
}

export function initialTimeDraft(zone: string, existing?: { startAt?: string; durationMinutes?: number }, date?: string): TimeDraft {
  const startAt = existing?.startAt;
  const result: TimeDraft = {
    date: startAt ? dateInZone(startAt, zone) : date ?? todayInZone(zone),
    time: startAt ? localTime(startAt, zone) : '09:00',
    duration: String(existing?.durationMinutes ?? 30),
    choice: '',
    ...(startAt ? { sourceStartAt: startAt } : {}),
  };
  if (startAt) {
    const earlier = localToInstant(result.date, result.time, zone, 'earlier');
    const later = localToInstant(result.date, result.time, zone, 'later');
    if (earlier !== later) result.choice = Math.floor(Date.parse(startAt) / 60_000) === Math.floor(Date.parse(later) / 60_000) ? 'later' : 'earlier';
  }
  return result;
}

interface TimeResolution { startAt: string | null; error: string; ambiguous: boolean; earlier: string | null; later: string | null }

export function resolveTimeDraft(value: TimeDraft, zone: string): TimeResolution {
  const base = { startAt: null, error: '', ambiguous: false, earlier: null, later: null };
  if (!isDate(value.date)) return { ...base, error: 'Wähle ein gültiges Datum.' };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)) return { ...base, error: 'Gib eine gültige Uhrzeit im 24-Stunden-Format an.' };
  const minutes = Number(value.duration);
  if (!value.duration.trim() || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    return { ...base, error: 'Die Dauer muss eine ganze Zahl zwischen 1 und 1.440 Minuten sein.' };
  }
  try {
    const earlier = localToInstant(value.date, value.time, zone, 'earlier');
    const later = localToInstant(value.date, value.time, zone, 'later');
    const ambiguous = earlier !== later;
    if (ambiguous && !value.choice) return { ...base, ambiguous, earlier, later, error: 'Diese Uhrzeit kommt durch die Zeitumstellung zweimal vor. Wähle das erste oder das zweite Vorkommen.' };
    let startAt = value.choice === 'later' ? later : earlier;
    // Editing another field must preserve the exact instant, including imported seconds.
    if (value.sourceStartAt && Math.floor(Date.parse(value.sourceStartAt) / 60_000) === Math.floor(Date.parse(startAt) / 60_000)) startAt = value.sourceStartAt;
    return { startAt, error: '', ambiguous, earlier, later };
  } catch (cause) {
    return { ...base, error: cause instanceof Error ? cause.message : 'Diese Ortszeit ist in der gewählten Zeitzone nicht gültig. Prüfe Datum und Uhrzeit, insbesondere die Zeitumstellung.' };
  }
}

export function DateTimeFields({ value, onChange, zone, disabled }: {
  value: TimeDraft; onChange: (value: TimeDraft) => void; zone: string; disabled: boolean;
}) {
  const id = useId();
  const resolution = resolveTimeDraft(value, zone);
  return <fieldset className="planning-fieldset" disabled={disabled}>
    <legend>Zeitpunkt und Dauer</legend>
    <p className="planning-help" id={`${id}-zone`}>Ortszeit in <strong>{zone}</strong>. Gespeichert wird ein fester Zeitpunkt.</p>
    <div className="planning-two-columns">
      <label className="field"><span>Datum</span><input type="date" required value={value.date} aria-describedby={`${id}-zone`} onChange={(event) => onChange({ ...value, date: event.target.value, choice: '' })} /></label>
      <label className="field"><span>Startzeit</span><input type="time" step="60" required value={value.time} aria-describedby={`${id}-zone`} onChange={(event) => onChange({ ...value, time: event.target.value, choice: '' })} /></label>
    </div>
    <label className="field"><span>Dauer in Minuten</span><input type="number" inputMode="numeric" min="1" max="1440" step="1" required value={value.duration} onChange={(event) => onChange({ ...value, duration: event.target.value })} /></label>
    {resolution.ambiguous && <label className="field"><span>Uhrzeit bei der Zeitumstellung</span>
      <select required aria-label="Uhrzeit bei der Zeitumstellung" value={value.choice} onChange={(event) => onChange({ ...value, choice: event.target.value as TimeDraft['choice'] })}>
        <option value="">Vorkommen ausdrücklich auswählen</option>
        <option value="earlier">Erstes Vorkommen ({resolution.earlier ? formatTime(resolution.earlier, 'UTC') : ''} UTC)</option>
        <option value="later">Zweites Vorkommen ({resolution.later ? formatTime(resolution.later, 'UTC') : ''} UTC)</option>
      </select>
    </label>}
    {resolution.error && <p className="planning-warning" role="status">{resolution.error}</p>}
    {resolution.startAt && <p className="planning-help">Ende: {new Intl.DateTimeFormat('de-DE', { timeZone: zone, dateStyle: 'medium', timeStyle: 'short', hour12: false }).format(new Date(Date.parse(resolution.startAt) + Number(value.duration) * 60_000))} Uhr.</p>}
  </fieldset>;
}
