import { DEFAULT_SETTINGS } from '../planning/types';
import './ParticleColorSettings.css';

interface ParticleColorSettingsProps {
  id: string;
  color: string;
  onChange: (color: string) => void;
}

const DEFAULT_PARTICLE_COLOR = DEFAULT_SETTINGS.particleColor!;
const PARTICLE_COLORS = [
  { name: 'Eisblau', value: DEFAULT_PARTICLE_COLOR },
  { name: 'Violett', value: '#a59be0' },
  { name: 'Mint', value: '#8bcbb7' },
  { name: 'Bernstein', value: '#d5b27c' },
];

export function ParticleColorSettings({ id, color, onChange }: ParticleColorSettingsProps) {
  return (
    <fieldset className="particle-color-settings" aria-describedby={`${id}-particle-color-help`}>
      <legend>Partikelfarbe <span>· Nexus</span></legend>
      <p id={`${id}-particle-color-help`} className="settings-muted">Gilt für die Nexus-Punktwolke. Die Farbe wird nach dem Speichern angewendet.</p>
      <div className="particle-color-options" role="group" aria-label="Vorgegebene Partikelfarben">
        {PARTICLE_COLORS.map((option) => <button
          key={option.value}
          type="button"
          aria-pressed={color.toLowerCase() === option.value}
          onClick={() => onChange(option.value)}
        >
          <i style={{ backgroundColor: option.value }} aria-hidden="true" />
          <span>{option.name}</span>
        </button>)}
      </div>
      <div className="particle-color-custom">
        <label htmlFor={`${id}-particle-color`}>Eigene Farbe</label>
        <input id={`${id}-particle-color`} type="color" value={color} onChange={(event) => onChange(event.currentTarget.value.toLowerCase())} />
        <output htmlFor={`${id}-particle-color`}>{color.toUpperCase()}</output>
        <span className="particle-color-preview" style={{ color }} aria-hidden="true">
          {Array.from({ length: 15 }, (_, index) => <i key={index} />)}
        </span>
      </div>
      <button type="button" className="particle-color-reset" disabled={color.toLowerCase() === DEFAULT_PARTICLE_COLOR} onClick={() => onChange(DEFAULT_PARTICLE_COLOR)}>Standardfarbe wiederherstellen</button>
    </fieldset>
  );
}
