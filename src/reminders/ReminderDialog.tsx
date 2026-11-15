import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Bell, Save, Trash2 } from 'lucide-react';
import { dateInZone, isTimeZone, localTime, localToInstant } from '../planning/dates';
import type { Planner, Reminder } from '../planning/types';
import { DeleteConfirmation, errorMessage, PlanningDialog, SaveFailure } from '../planning/components/PlanningDialog';
import { frequencyLabels } from './presentation';
import './Reminders.css';

export interface ReminderDialogProps {
  planner: Planner;
  reminder?: Reminder;
  defaults?: Partial<Reminder>;
  onClose: () => void;
}

export function ReminderDialog({ planner, reminder, defaults, onClose }: ReminderDialogProps) {
  const source = reminder ?? defaults;
  const [id] = useState(() => reminder?.id ?? crypto.randomUUID());
  const [createdAt] = useState(() => reminder?.createdAt ?? new Date().toISOString());
  const [title, setTitle] = useState(source?.title ?? '');
  const [zone, setZone] = useState(source?.timeZone ?? planner.data.settings.timeZone);
  const [localStart, setLocalStart] = useState(() => {
    if (source?.localStart) return source.localStart;
    const next = new Date(Date.now() + 60 * 60_000);
    const initialZone = isTimeZone(source?.timeZone) ? source.timeZone : planner.data.settings.timeZone;
    return `${dateInZone(next, initialZone)}T${localTime(next, initialZone)}`;
  });
  const [frequency, setFrequency] = useState<Reminder['frequency']>(source?.frequency ?? 'once');
  const [enabled, setEnabled] = useState(source?.enabled ?? true);
  const [link, setLink] = useState(() => source?.taskId ? `task:${source.taskId}` : source?.appointmentId ? `appointment:${source.appointmentId}` : '');
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null);
  const [error, setError] = useState('');
  const [validation, setValidation] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const zoneList = useId();

  function changeLink(value: string) {
    setLink(value);
    if (!title.trim()) {
      const target = value.startsWith('task:')
        ? planner.data.tasks.find(task => task.id === value.slice(5))
        : planner.data.appointments.find(appointment => appointment.id === value.slice(12));
      if (target) setTitle(target.title);
    }
    setValidation('');
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!title.trim()) { setValidation('Gib der Erinnerung einen Titel.'); return; }
    const cleanZone = zone.trim();
    if (!isTimeZone(cleanZone)) { setValidation('Gib eine gültige IANA-Zeitzone ein, zum Beispiel Europe/Berlin.'); return; }
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(localStart)) { setValidation('Gib ein vollständiges Datum und eine Uhrzeit ein.'); return; }
    try { localToInstant(localStart.slice(0, 10), localStart.slice(11), cleanZone); }
    catch (cause) {
      const message = errorMessage(cause);
      setValidation(message.includes('zweimal') ? 'Diese Uhrzeit kommt bei der Zeitumstellung zweimal vor. Wähle eine eindeutige Uhrzeit für den Beginn der Erinnerung.' : message);
      return;
    }
    const taskId = link.startsWith('task:') ? link.slice(5) : null;
    const appointmentId = link.startsWith('appointment:') ? link.slice(12) : null;
    if ((taskId && !planner.data.tasks.some(task => task.id === taskId)) || (appointmentId && !planner.data.appointments.some(appointment => appointment.id === appointmentId))) {
      setValidation('Das verknüpfte Element wurde entfernt. Wähle ein anderes Element oder „Eigenständig“.'); return;
    }
    setBusy('save'); setValidation(''); setError('');
    try {
      await planner.saveReminder({ id, title: title.trim(), localStart, timeZone: cleanZone, frequency, enabled, taskId, appointmentId, createdAt, updatedAt: new Date().toISOString() });
      onClose();
    } catch (cause) { setError(errorMessage(cause)); setBusy(null); }
  }

  async function remove() {
    if (!reminder || busy) return;
    setBusy('delete'); setError('');
    try { await planner.deleteReminder(reminder.id); onClose(); }
    catch (cause) { setError(errorMessage(cause)); setBusy(null); }
  }

  const linkedExists = !link || (link.startsWith('task:') ? planner.data.tasks.some(task => `task:${task.id}` === link) : planner.data.appointments.some(appointment => `appointment:${appointment.id}` === link));
  const draft = `NEXUS – Erinnerungsentwurf\nNoch nicht bestätigt gespeichert.\n\n${JSON.stringify({ id, title, localStart, timeZone: zone, frequency, enabled, link, createdAt }, null, 2)}`;
  return <PlanningDialog title={reminder ? 'Erinnerung bearbeiten' : 'Neue Erinnerung'} eyebrow="ERINNERUNGEN" busy={Boolean(busy)} onClose={onClose} onSubmit={event => void save(event)} footer={<>
    {reminder && <button type="button" className="danger-button planning-delete-trigger" disabled={Boolean(busy)} onClick={() => setConfirmDelete(true)}><Trash2 size={16} aria-hidden="true" /> Erinnerung löschen</button>}
    <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={onClose}>Abbrechen</button>
    <button type="submit" className="primary-button" disabled={Boolean(busy) || planner.loading || Boolean(planner.loadError)}><Save size={16} aria-hidden="true" /> {busy === 'save' ? 'Wird gespeichert …' : error ? 'Erneut speichern' : 'Erinnerung speichern'}</button>
  </>}>
    <fieldset className="planning-inputs" disabled={Boolean(busy)}>
      <label className="field"><span>Titel</span><input autoFocus required maxLength={500} value={title} onChange={event => { setTitle(event.target.value); setValidation(''); }} placeholder="Woran möchtest du erinnert werden?" /></label>
      <label className="field"><span id={`${zoneList}-link`}>Verknüpfung</span><select aria-labelledby={`${zoneList}-link`} value={link} onChange={event => changeLink(event.target.value)}>
        <option value="">Eigenständig</option>
        {!linkedExists && <option value={link}>Verknüpftes Element nicht mehr vorhanden</option>}
        <optgroup label="Aufgaben">{planner.data.tasks.map(task => <option key={task.id} value={`task:${task.id}`}>{task.title}{task.status === 'done' ? ' · erledigt' : ''}</option>)}</optgroup>
        <optgroup label="Termine">{planner.data.appointments.map(appointment => <option key={appointment.id} value={`appointment:${appointment.id}`}>{appointment.title}</option>)}</optgroup>
      </select></label>
      <div className="reminder-form-grid">
        <label className="field"><span>Beginn · Datum</span><input required type="date" min="0001-01-01" max="9999-12-31" value={localStart.slice(0, 10)} onChange={event => { setLocalStart(`${event.target.value}T${localStart.slice(11) || '09:00'}`); setValidation(''); }} /></label>
        <label className="field"><span>Uhrzeit</span><input required type="time" step="60" value={localStart.slice(11)} onChange={event => { setLocalStart(`${localStart.slice(0, 10)}T${event.target.value}`); setValidation(''); }} /></label>
      </div>
      <label className="field"><span>Eigene Zeitzone</span><input required maxLength={100} list={zoneList} value={zone} spellCheck={false} autoComplete="off" onChange={event => { setZone(event.target.value); setValidation(''); }} placeholder="Europe/Berlin" />
        <datalist id={zoneList}>{Array.from(new Set([planner.data.settings.timeZone, 'Europe/Berlin', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'UTC'])).map(value => <option key={value} value={value} />)}</datalist>
      </label>
      <label className="field"><span id={`${zoneList}-frequency`}>Wiederholung</span><select aria-labelledby={`${zoneList}-frequency`} value={frequency} onChange={event => setFrequency(event.target.value as Reminder['frequency'])}>{Object.entries(frequencyLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="reminder-toggle-field"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /><span><strong>Erinnerung aktiv</strong><small>Pausierte Regeln erzeugen keine neuen Meldungen.</small></span></label>
      <p className="planning-help"><Bell size={14} aria-hidden="true" /> Nur das Erinnerungsvorkommen wird quittiert; verknüpfte Aufgaben bleiben unverändert.</p>
      <details className="reminder-form-help"><summary>Zeitzone &amp; Wiederholungen</summary><p className="planning-help">Der Beginn braucht eine eindeutige Uhrzeit. Spätere Wiederholungen bei Zeitumstellungen werden auf die spätere oder nächste gültige Minute gelegt und gekennzeichnet. Die eigene Zeitzone bleibt beim Wechsel der App-Zeitzone erhalten.</p>{reminder && <p className="planning-help">Quittierte und geschlummerte Vorkommen bleiben als Belege erhalten. Änderungen gelten für noch nicht quittierte Vorkommen.</p>}</details>
    </fieldset>
    {validation && <p className="planning-warning" role="alert">{validation}</p>}
    <SaveFailure error={error} draft={draft} filename="nexus-erinnerungsentwurf" />
    {confirmDelete && <DeleteConfirmation noun="Erinnerung" details="Die Regel und ihre sichtbaren Vorkommen werden entfernt. Verknüpfte Aufgaben oder Termine bleiben erhalten." busy={Boolean(busy)} onCancel={() => setConfirmDelete(false)} onConfirm={() => void remove()} />}
    <p className="planning-operation-status" role="status">{busy === 'save' ? 'Wird gespeichert …' : busy === 'delete' ? 'Wird gelöscht …' : ''}</p>
  </PlanningDialog>;
}

export default ReminderDialog;
