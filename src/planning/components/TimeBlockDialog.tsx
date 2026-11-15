import { useState } from 'react';
import type { FormEvent } from 'react';
import { Save, Trash2 } from 'lucide-react';
import type { BlockDefaults, Planner, TimeBlock } from '../types';
import { formatDate } from '../dates';
import { DateTimeFields, initialTimeDraft, resolveTimeDraft } from './DateTimeFields';
import { DeleteConfirmation, errorMessage, PlanningDialog, SaveFailure } from './PlanningDialog';

export interface TimeBlockDialogProps { planner: Planner; block?: TimeBlock; defaults?: BlockDefaults; onClose: () => void }

export function TimeBlockDialog({ planner, block, defaults, onClose }: TimeBlockDialogProps) {
  const zone = planner.data.settings.timeZone;
  const [id] = useState(() => block?.id ?? crypto.randomUUID());
  const [createdAt] = useState(() => block?.createdAt ?? new Date().toISOString());
  const [taskId, setTaskId] = useState(block?.taskId ?? defaults?.taskId ?? '');
  const [time, setTime] = useState(() => initialTimeDraft(zone, block ?? defaults, defaults?.date));
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null);
  const [error, setError] = useState('');
  const [validation, setValidation] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const task = planner.data.tasks.find((item) => item.id === taskId);
  const furtherBlocks = planner.data.timeBlocks.filter((item) => item.taskId === taskId && item.id !== block?.id);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!task) { setValidation('Wähle eine vorhandene Aufgabe für diesen Zeitblock.'); return; }
    const resolved = resolveTimeDraft(time, zone);
    if (!resolved.startAt) { setValidation(resolved.error); return; }
    setBusy('save'); setError(''); setValidation('');
    try {
      await planner.saveTimeBlock({ id, taskId, startAt: resolved.startAt, durationMinutes: Number(time.duration), createdAt, updatedAt: new Date().toISOString() });
      onClose();
    } catch (cause) { setError(errorMessage(cause)); setBusy(null); }
  }

  async function remove() {
    if (!block || busy) return;
    setBusy('delete'); setError('');
    try { await planner.deleteTimeBlock(block.id); onClose(); }
    catch (cause) { setError(errorMessage(cause)); setBusy(null); }
  }

  const draftText = `NEXUS – Zeitblockentwurf\nNoch nicht bestätigt gespeichert.\n\n${JSON.stringify({ id, taskId, taskTitle: task?.title ?? '', timeZone: zone, ...time, createdAt }, null, 2)}`;
  return <PlanningDialog title={block ? 'Zeitblock bearbeiten' : 'Neuer Zeitblock'} eyebrow="BEARBEITUNGSZEIT" busy={Boolean(busy)} onClose={onClose} onSubmit={(event) => void save(event)}
    footer={<>
      {block && <button type="button" className="danger-button planning-delete-trigger" disabled={Boolean(busy)} onClick={() => setConfirmDelete(true)}><Trash2 size={16} aria-hidden="true" /> Zeitblock löschen</button>}
      <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={onClose}>Abbrechen</button>
      <button type="submit" className="primary-button" disabled={Boolean(busy) || planner.data.tasks.length === 0 || planner.loading || Boolean(planner.loadError)}><Save size={16} aria-hidden="true" /> {busy === 'save' ? 'Wird gespeichert …' : error ? 'Erneut speichern' : 'Zeitblock speichern'}</button>
    </>}>
    <fieldset className="planning-inputs" disabled={Boolean(busy)}>
      <label className="field"><span>Aufgabe für diesen Zeitblock</span><select required autoFocus aria-label="Aufgabe für diesen Zeitblock" value={taskId} onChange={(event) => { setTaskId(event.target.value); setValidation(''); }}>
        <option value="">Aufgabe auswählen</option>
        {planner.data.tasks.map((item) => <option key={item.id} value={item.id}>{item.title}{item.status === 'done' ? ' · Erledigt' : item.status === 'progress' ? ' · In Bearbeitung' : ''}</option>)}
      </select></label>
      {planner.data.tasks.length === 0 && <p className="planning-warning">Erstelle zuerst eine Aufgabe. Jeder Zeitblock ist mit einer vorhandenen Aufgabe verknüpft.</p>}
      {taskId && !task && <p className="planning-warning" role="alert">Die bisher verknüpfte Aufgabe ist nicht mehr vorhanden. Wähle eine gültige Aufgabe.</p>}
      <DateTimeFields value={time} onChange={(value) => { setTime(value); setValidation(''); }} zone={zone} disabled={Boolean(busy)} />
      {task && <div className="planning-info">
        <p>Beim Speichern wird <strong>{task.title}</strong> für den frühesten Tag ihrer Zeitblöcke eingeplant. {task.dueDate ? `Die Fälligkeit am ${formatDate(task.dueDate)} bleibt erhalten.` : 'Ein Fälligkeitsdatum wird dadurch nicht gesetzt.'}</p>
        {furtherBlocks.length > 0 && <p>{furtherBlocks.length === 1 ? 'Ein weiterer Zeitblock dieser Aufgabe bleibt' : `${furtherBlocks.length} weitere Zeitblöcke dieser Aufgabe bleiben`} erhalten, auch an anderen Tagen.</p>}
      </div>}
    </fieldset>
    {validation && <p className="planning-warning" role="alert">{validation}</p>}
    <SaveFailure error={error} draft={draftText} filename="nexus-zeitblockentwurf" />
    {confirmDelete && <DeleteConfirmation noun="Zeitblock" details="Die verknüpfte Aufgabe bleibt mit ihrem Status und Fälligkeitsdatum erhalten." busy={Boolean(busy)} onCancel={() => setConfirmDelete(false)} onConfirm={() => void remove()} />}
    <p className="planning-operation-status" role="status">{busy === 'save' ? 'Wird gespeichert. Bitte warte auf den Abschluss.' : busy === 'delete' ? 'Wird gelöscht. Bitte warte auf den Abschluss.' : 'Änderungen werden erst mit „Zeitblock speichern“ übernommen.'}</p>
  </PlanningDialog>;
}
