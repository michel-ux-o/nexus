import { THEME_OPTIONS, type ThemeChoice, type ThemeId } from '../themes/catalog';
import './ThemeSettings.css';

interface ThemeSettingsProps {
  id: string;
  choice: ThemeChoice;
  previewing: boolean;
  onChange: (choice: ThemeChoice) => void;
}

const LABELS: Record<ThemeId, string> = { nexus: 'Nexus', daylight: 'Tageslicht', sand: 'Sand', aurora: 'Nordlicht' };

export function ThemeSettings({ id, choice, previewing, onChange }: ThemeSettingsProps) {
  return (
    <fieldset className="theme-settings" aria-describedby={`${id}-theme-help`}>
      <legend className="settings-display-label">Farbschema</legend>
      <p id={`${id}-theme-help`} className="settings-muted">Die App zeigt deine Auswahl sofort als Vorschau. Mit „Einstellungen speichern“ übernimmst du sie.</p>
      <div className="theme-options">
        {THEME_OPTIONS.map((option) => <label className="theme-option" key={option.id}>
          <input type="radio" name={`${id}-theme`} value={option.id} checked={choice === option.id} onChange={() => onChange(option.id)} />
          <span className={`theme-option-card theme-sample-${option.id}`}>
            <span className="theme-swatches" aria-hidden="true"><i /><i /><i /><i /></span>
            <strong>{LABELS[option.id]}</strong><small>{option.description}</small>
          </span>
        </label>)}
        <label className="theme-option">
          <input type="radio" name={`${id}-theme`} value="system" checked={choice === 'system'} onChange={() => onChange('system')} />
          <span className="theme-option-card theme-sample-system">
            <span className="theme-swatches" aria-hidden="true"><i /><i /><i /><i /></span>
            <strong>System</strong><small>Folgt der hellen oder dunklen Darstellung deines Systems.</small>
          </span>
        </label>
      </div>
      <p className="theme-preview-state" role="status">{previewing ? 'Vorschau aktiv – mit den Einstellungen speichern' : 'Gespeicherte Auswahl'}</p>
    </fieldset>
  );
}

