import { useId, useState } from 'react';
import { Copy } from 'lucide-react';
import type { MorningRoutineSettings as RoutineSettings, Subtask } from '../planning/types';
import { SubtaskEditor } from '../planning/components/SubtaskEditor';
import { WEEKDAYS } from './preferences';
import './MorningRoutineSettings.css';

interface MorningRoutineSettingsProps {
  value: RoutineSettings | undefined;
  onChange: (value: RoutineSettings) => void;
  disabled?: boolean;
}

function templateSteps(items: Subtask[], freshIds = false): Subtask[] {
  return items.map((item) => ({
    ...item,
    id: freshIds ? crypto.randomUUID() : item.id,
    done: false,
    ...(item.children ? { children: item.children.map((child) => ({ ...child, id: freshIds ? crypto.randomUUID() : child.id, done: false })) } : {}),
  }));
}

function stepCount(items: Subtask[]): number {
  return items.reduce((count, item) => count + (item.children?.length || 1), 0);
}

export function MorningRoutineSettings({ value, onChange, disabled = false }: MorningRoutineSettingsProps) {
  const id = useId();
  const [weekday, setWeekday] = useState(1);
  const [copyDays, setCopyDays] = useState<number[]>([]);
  const [message, setMessage] = useState('');
  const days = WEEKDAYS.map((_, index) => value?.days.find((day) => day.weekday === index + 1) ?? { weekday: index + 1, enabled: false, subtasks: [] });
  const selected = days[weekday - 1];

  function updateDay(patch: Partial<RoutineSettings['days'][number]>) {
    onChange({ ...value, days: days.map((day) => day.weekday === weekday ? { ...day, ...patch } : day) });
    setMessage('');
  }

  function copyTemplate() {
    if (disabled || copyDays.length === 0) return;
    onChange({
      ...value,
      days: days.map((day) => copyDays.includes(day.weekday)
        ? { ...day, enabled: selected.enabled, subtasks: templateSteps(selected.subtasks, true) }
        : day),
    });
    setMessage(`Vorlage für ${copyDays.map((day) => WEEKDAYS[day - 1]).join(', ')} im Entwurf übernommen. Mit den Einstellungen speichern.`);
    setCopyDays([]);
  }

  return <div className="morning-routine-settings">
    <p className="settings-muted" id={`${id}-help`}>Jeder Wochentag hat eine eigene Vorlage. Deine Routine erscheint täglich, bis sie erledigt oder für heute übersprungen ist.</p>
    <div className="routine-weekdays" role="group" aria-label="Wochentag der Morgenroutine">
      {days.map((day) => <button
        key={day.weekday}
        type="button"
        className="routine-weekday"
        aria-pressed={weekday === day.weekday}
        aria-controls={`${id}-day`}
        disabled={disabled}
        onClick={() => { setWeekday(day.weekday); setCopyDays([]); setMessage(''); }}
      >
        <span>{WEEKDAYS[day.weekday - 1]}</span>
        <small>{day.enabled ? 'An' : 'Aus'} · {stepCount(day.subtasks)} {stepCount(day.subtasks) === 1 ? 'Schritt' : 'Schritte'}</small>
      </button>)}
    </div>
    <fieldset id={`${id}-day`} className="routine-day" disabled={disabled} aria-describedby={`${id}-help ${id}-future`}>
      <legend>{WEEKDAYS[weekday - 1]}</legend>
      <label className="routine-enabled">
        <input type="checkbox" checked={selected.enabled} onChange={(event) => updateDay({ enabled: event.target.checked })} />
        <span>Morgenroutine am {WEEKDAYS[weekday - 1]} aktivieren</span>
      </label>
      {selected.subtasks.length === 0 && <p className="settings-muted routine-empty">Noch keine Schritte. Ergänze deine eigene Routine; Gruppen können weitere Schritte enthalten.</p>}
      <SubtaskEditor value={selected.subtasks} onChange={(subtasks) => updateDay({ subtasks: templateSteps(subtasks) })} disabled={disabled} templateMode />
      <p className="settings-muted routine-future" id={`${id}-future`}>Änderungen gelten für kommende Routinen. Ein bereits angelegter Tagesablauf behält seine Schritte und Häkchen.</p>
    </fieldset>
    <details className="routine-copy">
      <summary>Vorlage auf andere Tage kopieren</summary>
      <fieldset disabled={disabled} className="routine-copy-days">
        <legend>{WEEKDAYS[weekday - 1]} übernehmen für</legend>
        {days.filter((day) => day.weekday !== weekday).map((day) => <label key={day.weekday}>
          <input type="checkbox" checked={copyDays.includes(day.weekday)} onChange={(event) => setCopyDays((current) => event.target.checked ? [...current, day.weekday].sort((a, b) => a - b) : current.filter((item) => item !== day.weekday))} />
          <span>{WEEKDAYS[day.weekday - 1]}</span>
        </label>)}
      </fieldset>
      <p className="settings-muted">Schritte und Aktivierung ersetzen die Vorlagen der gewählten Tage. Tagesfortschritte bleiben erhalten.</p>
      <button type="button" className="secondary-button" disabled={disabled || copyDays.length === 0} onClick={copyTemplate}>
        <Copy size={16} aria-hidden="true" /> {copyDays.length ? `${copyDays.length} ${copyDays.length === 1 ? 'Vorlage' : 'Vorlagen'} ersetzen` : 'Vorlagen ersetzen'}
      </button>
    </details>
    <p className="routine-copy-status settings-muted" role="status">{message}</p>
  </div>;
}
