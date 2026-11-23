import { useEffect, useState } from 'react';
import { Bell, BellOff, Settings2 } from 'lucide-react';
import { errorMessage } from '../planning/components/PlanningDialog';
import type { Planner } from '../planning/types';

type Permission = NotificationPermission | 'unsupported';

function browserPermission(): Permission {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

export function BrowserNotificationStatus({ planner, onOpenSettings }: { planner: Planner; onOpenSettings: () => void }) {
  const [enabling, setEnabling] = useState(false);
  const [error, setError] = useState('');
  const [permissionDismissed, setPermissionDismissed] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const permission = browserPermission();
  const enabled = planner.data.settings.notifications === true;
  const active = enabled && permission === 'granted' && !unconfirmed && !enabling;
  const canActivate = permission === 'default' || (permission === 'granted' && (!enabled || unconfirmed || enabling));
  const label = permission === 'unsupported' ? 'Dieser Browser unterstützt keine Browsermeldungen.'
    : permission === 'denied' ? 'Browsermeldungen sind im Browser blockiert.'
    : enabling ? 'Browsermeldungen werden aktiviert …'
    : unconfirmed ? 'Die Aktivierung der Browsermeldungen ist noch nicht gespeichert.'
    : !enabled ? 'Browsermeldungen sind ausgeschaltet.'
    : permission === 'default' ? 'Browsermeldungen sind noch nicht ausdrücklich erlaubt.'
    : 'Browsermeldungen sind eingeschaltet und erlaubt.';

  useEffect(() => {
    if (planner.status === 'saved') setUnconfirmed(false);
  }, [planner.status]);

  async function activate() {
    if (enabling) return;
    setEnabling(true);
    setError('');
    setPermissionDismissed(false);
    try {
      const current = browserPermission();
      const granted = current === 'default' ? await Notification.requestPermission() : current;
      if (granted !== 'granted') {
        setPermissionDismissed(granted === 'default');
        return;
      }
      if (!enabled) planner.updateSettings({ notifications: true });
      if ((!enabled || unconfirmed) && !await planner.flush()) {
        setUnconfirmed(true);
        return;
      }
      setUnconfirmed(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setEnabling(false);
    }
  }

  const StatusIcon = active ? Bell : BellOff;
  return <div className="reminders-notification-info">
    <StatusIcon size={18} aria-hidden="true" />
    <div className="reminders-notification-copy" role="status">
      <strong>{label}</strong>
      <p>{permission === 'denied' ? 'Erlaube Meldungen für Nexus in den Website-Einstellungen deines Browsers.' : 'Auf diesem Gerät sind Meldungen nur bei geöffneter App möglich.'}</p>
      {permission === 'default' && permissionDismissed && <p>Die Berechtigung wurde nicht erteilt.</p>}
    </div>
    {canActivate
      ? <button type="button" className="reminders-button" aria-label={unconfirmed ? 'Aktivierung erneut speichern' : 'Browsermeldungen aktivieren'} disabled={enabling} onClick={() => void activate()}>{unconfirmed ? 'Erneut speichern' : 'Aktivieren'}</button>
      : active && <button type="button" className="reminders-link" onClick={onOpenSettings}><Settings2 size={14} aria-hidden="true" /> Einstellungen</button>}
    {error && <p className="reminders-notification-error" role="alert">Aktivierung fehlgeschlagen. {error}</p>}
  </div>;
}
