import { useEffect, useState } from 'react';
import { Download, X } from 'lucide-react';
import type { Planner } from '../planning/types';
import { backupIsDue } from './preferences';
import './BackupReminder.css';

/** A local reminder only. Exports always require an explicit user action. */
export function BackupReminder({ planner, onOpen }: { planner: Planner; onOpen: () => void }) {
  const [now, setNow] = useState(() => new Date());
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    const refresh = () => setNow(new Date());
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, []);
  if (dismissed || planner.loading || planner.loadError || !planner.data.settings.onboardingDone || !backupIsDue(planner.data.settings, now)) return null;
  return <aside className="settings-backup-reminder" aria-label="Sicherungserinnerung">
    <Download size={19} aria-hidden="true" />
    <p><strong>Zeit für eine Sicherung</strong><span>Bewahre deine Notizen und Planung auch als externe Datei auf.</span></p>
    <button type="button" className="secondary-button" onClick={onOpen}>Sicherung öffnen</button>
    <button type="button" className="icon-button" aria-label="Sicherungserinnerung für diese Sitzung ausblenden" onClick={() => setDismissed(true)}><X size={18} aria-hidden="true" /></button>
  </aside>;
}
