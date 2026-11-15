import { useState } from 'react';
import type { FormEvent } from 'react';
import { Save, Trash2 } from 'lucide-react';
import type { Appointment, Planner } from '../types';
import { addDays, todayInZone } from '../dates';
import { DateTimeFields, initialTimeDraft, resolveTimeDraft } from './DateTimeFields';
import { allDayRange } from './formValues';
import { DeleteConfirmation, errorMessage, PlanningDialog, SaveFailure } from './PlanningDialog';

export interface AppointmentDialogProps { planner: Planner; appointment?: Appointment; date?: string; defaults?: Partial<Appointment>; onClose: () => void }

export function AppointmentDialog({ planner, appointment, date, defaults, onClose }: AppointmentDialogProps) {
  const zone = planner.data.settings.timeZone;
  const source = appointment ?? defaults;
  const [id] = useState(() => appointment?.id ?? crypto.randomUUID());
  const [createdAt] = useState(() => appointment?.createdAt ?? new Date().toISOString());
  const [title, setTitle] = useState(source?.title ?? '');
  const [description, setDescription] = useState(source?.description ?? '');
  const [time, setTime] = useState(() => initialTimeDraft(zone, source?.allDay ? { durationMinutes: source.durationMinutes } : source, source?.allDay?.startDate ?? date));
  const [allDay, setAllDay] = useState(Boolean(source?.allDay));
  const [firstDay, setFirstDay] = useState(source?.allDay?.startDate ?? date ?? time.date ?? todayInZone(zone));
  const [lastDay, setLastDay] = useState(() => source?.allDay ? addDays(source.allDay.endDate, -1) : date ?? time.date);
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null);
  const [error, setError] = useState('');
  const [validation, setValidation] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!title.trim()) { setValidation('Gib dem Termin einen Titel.'); return; }
    let range: Appointment['allDay'];
    if (allDay) {
      try { range = allDayRange(firstDay, lastDay); }
      catch (cause) { setValidation(errorMessage(cause)); return; }
    }
    const resolved = allDay ? null : resolveTimeDraft(time, zone);
    if (resolved && !resolved.startAt) { setValidation(resolved.error); return; }
    setBusy('save'); setError(''); setValidation('');
    try {
      await planner.saveAppointment({ id, title: title.trim(), description,
        startAt: resolved?.startAt ?? source?.startAt ?? `${firstDay}T12:00:00.000Z`,
        durationMinutes: allDay ? source?.durationMinutes ?? 30 : Number(time.duration),
        ...(range ? { allDay: range } : {}), createdAt, updatedAt: new Date().toISOString() });
      onClose();
    } catch (cause) { setError(errorMessage(cause)); setBusy(null); }
  }

  async function remove() {
    if (!appointment || busy) return;
    setBusy('delete'); setError('');
    try { await planner.deleteAppointment(appointment.id); onClose(); }
    catch (cause) { setError(errorMessage(cause)); setBusy(null); }
  }

  const draftText = `NEXUS – Terminentwurf\nNoch nicht bestätigt gespeichert.\n\n${JSON.stringify({ id, title, description, timeZone: zone, ...time, allDay, firstDay, lastDay, createdAt }, null, 2)}`;
  return <PlanningDialog title={appointment ? 'Termin bearbeiten' : 'Neuer Termin'} eyebrow="FESTER TERMIN" busy={Boolean(busy)} onClose={onClose} onSubmit={(event) => void save(event)}
    footer={<>
      {appointment && <button type="button" className="danger-button planning-delete-trigger" disabled={Boolean(busy)} onClick={() => setConfirmDelete(true)}><Trash2 size={16} aria-hidden="true" /> Termin löschen</button>}
      <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={onClose}>Abbrechen</button>
      <button type="submit" className="primary-button" disabled={Boolean(busy) || planner.loading || Boolean(planner.loadError)}><Save size={16} aria-hidden="true" /> {busy === 'save' ? 'Wird gespeichert …' : error ? 'Erneut speichern' : 'Termin speichern'}</button>
    </>}>
    <fieldset className="planning-inputs" disabled={Boolean(busy)}>
      <label className="field"><span>Titel</span><input required maxLength={500} autoFocus value={title} onChange={(event) => { setTitle(event.target.value); setValidation(''); }} placeholder="Worum geht es?" /></label>
      <label className="field"><span>Beschreibung · optional</span><textarea rows={4} maxLength={100000} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
      <label className="planning-check"><input type="checkbox" checked={allDay} onChange={(event) => { setAllDay(event.target.checked); setValidation(''); }} /><span>Ganztägig</span></label>
      {allDay ? <fieldset className="planning-fieldset"><legend>Ganztägiger Zeitraum</legend>
        <div className="planning-two-columns">
          <label className="field"><span>Erster Tag</span><input type="date" required value={firstDay} onChange={(event) => { const next = event.target.value; setFirstDay(next); if (lastDay < next) setLastDay(next); setValidation(''); }} /></label>
          <label className="field"><span>Letzter Tag · einschließlich</span><input type="date" required min={firstDay || undefined} value={lastDay} onChange={(event) => { setLastDay(event.target.value); setValidation(''); }} /></label>
        </div>
        <p className="planning-help">Dieser Eintrag erscheint an allen gewählten Tagen. Er belegt keine Arbeitsminuten.</p>
      </fieldset> : <DateTimeFields value={time} onChange={(value) => { setTime(value); setValidation(''); }} zone={zone} disabled={Boolean(busy)} />}
    </fieldset>
    {validation && <p className="planning-warning" role="alert">{validation}</p>}
    <SaveFailure error={error} draft={draftText} filename="nexus-terminentwurf" />
    {confirmDelete && <DeleteConfirmation noun="Termin" details="Dieser Termin wird dauerhaft aus deiner Planung entfernt." busy={Boolean(busy)} onCancel={() => setConfirmDelete(false)} onConfirm={() => void remove()} />}
    <p className="planning-operation-status" role="status">{busy === 'save' ? 'Wird gespeichert. Bitte warte auf den Abschluss.' : busy === 'delete' ? 'Wird gelöscht. Bitte warte auf den Abschluss.' : 'Änderungen werden erst mit „Termin speichern“ übernommen.'}</p>
  </PlanningDialog>;
}
