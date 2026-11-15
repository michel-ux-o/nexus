import { useId, useState, useSyncExternalStore } from 'react';
import { AlarmClock, ExternalLink } from 'lucide-react';
import { getAndroidAlarmClient, type AndroidAlarmClient } from './androidAlarmClient';
import './AndroidAlarmSettings.css';

export function AndroidAlarmSettings({ disabled = false, client = getAndroidAlarmClient() }: { disabled?: boolean; client?: AndroidAlarmClient }) {
  const id = useId();
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const available = snapshot.status === 'ready';

  async function open() {
    if (opening) return;
    setOpening(true); setError('');
    try { await client.openAlarmSettings(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Die Weckereinstellungen konnten nicht geöffnet werden.'); }
    finally { setOpening(false); }
  }

  return <section className="android-alarm-settings" aria-labelledby={`${id}-title`}>
    <div className="android-alarm-heading"><AlarmClock size={19} aria-hidden="true" /><h3 id={`${id}-title`}>Wecker auf diesem Gerät</h3></div>
    {available ? <>
      <p>Lege Weckzeit, Wochentage, Schlummerdauer und eine lokale MP3-Datei in den Android-Weckereinstellungen fest.</p>
      <button type="button" className="secondary-button" disabled={disabled || opening} onClick={() => { void open(); }}>
        {opening ? 'Weckereinstellungen öffnen …' : 'Wecker einstellen'}<ExternalLink size={16} aria-hidden="true" />
      </button>
      <p className="settings-muted">Der Wecker wird direkt auf diesem Gerät gespeichert. Android zeigt dort auch die benötigten Berechtigungen. Mit „Morgenroutine starten“ gelangst du vom Weckbildschirm in deine bestehende Tagesroutine.</p>
    </> : snapshot.status === 'connecting' ? <p role="status">Android-Wecker wird verbunden …</p> : <>
      <p>Der Hintergrundwecker mit lokaler MP3-Datei ist in der Android-Version von Nexus verfügbar. Die im Browser installierte Webapp kann diesen Gerätewecker nicht ausführen.</p>
      <p className="settings-muted">Deine Morgenroutine kannst du auch in der Webapp bearbeiten und täglich abhaken.</p>
    </>}
    {(error || snapshot.error) && <p className="android-alarm-error" role="alert">{error || snapshot.error}</p>}
  </section>;
}
