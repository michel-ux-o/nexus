import { isTimeZone } from '../planning/dates';
import { DEFAULT_CAPACITY, DEFAULT_SETTINGS, DEFAULT_MORNING_ROUTINE, type AppSettings, type CapacityWindow, type MorningRoutineSettings } from '../planning/types';

export const WEEKDAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
export interface SettingsDraft {
  morningRoutine: MorningRoutineSettings;
  timeZone: string;
  startView: AppSettings['startView'];
  voiceReview: boolean;
  aiConsent: boolean;
  availableMinutes: string;
  theme: NonNullable<AppSettings['theme']>;
  artifactIntensity: NonNullable<AppSettings['artifactIntensity']>;
  particleColor: string;
  menuMotion: NonNullable<AppSettings['menuMotion']>;
  matrixBackground: boolean;
  powerSaving: boolean;
  capacityEnabled: boolean;
  windows: CapacityWindow[];
  bufferMinutes: string;
  notifications: boolean;
  backupIntervalDays: string;
}

export function draftFrom(settings: AppSettings): SettingsDraft {
  const capacity = settings.capacity ?? DEFAULT_CAPACITY;
  return {
    morningRoutine: structuredClone(settings.morningRoutine ?? DEFAULT_MORNING_ROUTINE),
    timeZone: settings.timeZone, startView: settings.startView, voiceReview: settings.voiceReview,
    aiConsent: settings.aiConsent, availableMinutes: String(settings.defaultAvailableMinutes),
    theme: settings.theme ?? DEFAULT_SETTINGS.theme!, artifactIntensity: settings.artifactIntensity ?? DEFAULT_SETTINGS.artifactIntensity!,
    particleColor: settings.particleColor ?? DEFAULT_SETTINGS.particleColor!,
    menuMotion: settings.menuMotion ?? DEFAULT_SETTINGS.menuMotion!,
    matrixBackground: settings.matrixBackground ?? true, powerSaving: settings.powerSaving ?? false,
    capacityEnabled: capacity.enabled,
    windows: DEFAULT_CAPACITY.windows.map((window) => ({ ...window, ...capacity.windows.find((item) => item.weekday === window.weekday) })),
    bufferMinutes: String(capacity.bufferMinutes), notifications: settings.notifications ?? false,
    backupIntervalDays: String(settings.backupIntervalDays ?? 7),
  };
}

export function sameSettings(draft: SettingsDraft, settings: AppSettings): boolean {
  return JSON.stringify(draft) === JSON.stringify(draftFrom(settings));
}

function minutes(value: string, label: string, max = 1440): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isInteger(parsed) || parsed < 0 || parsed > max) throw new Error(`${label} muss eine ganze Zahl zwischen 0 und ${max} sein.`);
  return parsed;
}

export function settingsPatch(draft: SettingsDraft): Partial<AppSettings> {
  const timeZone = draft.timeZone.trim();
  const particleColor = draft.particleColor.trim();
  if (!isTimeZone(timeZone)) throw new Error('Diese Zeitzone wird nicht erkannt. Verwende eine gültige IANA-Zeitzone, zum Beispiel Europe/Berlin.');
  if (!/^#[0-9a-f]{6}$/i.test(particleColor)) throw new Error('Die Punktfarbe muss ein sechsstelliger Hex-Farbwert sein, zum Beispiel #8ebed4.');
  if (draft.windows.length !== 7 || new Set(draft.windows.map((window) => window.weekday)).size !== 7) throw new Error('Für jeden Wochentag ist genau ein Zeitfenster erforderlich.');
  for (const window of draft.windows) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(window.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(window.end) || window.start >= window.end) throw new Error(`${WEEKDAYS[window.weekday - 1]}: Das Zeitfenster muss am selben Tag vor seinem Ende beginnen.`);
  }
  return {
    morningRoutine: structuredClone(draft.morningRoutine),
    timeZone, startView: draft.startView, voiceReview: draft.voiceReview, aiConsent: draft.aiConsent,
    defaultAvailableMinutes: minutes(draft.availableMinutes, 'Die Tagesverfügbarkeit'),
    theme: draft.theme, artifactIntensity: draft.artifactIntensity,
    particleColor,
    menuMotion: draft.menuMotion, matrixBackground: draft.matrixBackground, powerSaving: draft.powerSaving,
    capacity: { enabled: draft.capacityEnabled, windows: structuredClone(draft.windows), bufferMinutes: minutes(draft.bufferMinutes, 'Der tägliche Puffer') },
    notifications: draft.notifications, backupIntervalDays: minutes(draft.backupIntervalDays, 'Das Sicherungsintervall', 365),
  };
}

/** A download handoff is recorded; it does not prove that a file was saved. */
export function appendExportHistory(history: readonly string[] = [], at = new Date().toISOString()): string[] {
  return [...history, at].slice(-100);
}

export function backupIsDue(settings: AppSettings, now = new Date()): boolean {
  const interval = settings.backupIntervalDays ?? 7;
  if (interval <= 0) return false;
  const latest = (settings.exportHistory ?? []).reduce((last, value) => Math.max(last, Date.parse(value) || 0), 0);
  return latest === 0 || now.getTime() - latest >= interval * 86_400_000;
}
