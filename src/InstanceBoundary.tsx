import { useEffect, useState, type ReactNode } from 'react';

// Serialize mount/unmount requests in this document, including StrictMode replays.
let previousRequest: Promise<unknown> = Promise.resolve();

/** One writer per origin. Storage adapters remain independent of browser locking. */
export function InstanceBoundary({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'waiting' | 'ready' | 'locked' | 'unsupported'>('waiting');
  useEffect(() => {
    if (!navigator.locks) { setState('unsupported'); return; }
    let cancelled = false;
    let release: (() => void) | undefined;
    const request = previousRequest.catch(() => undefined).then(() => {
      if (cancelled) return;
      return navigator.locks.request('nexus-notes-writer', { ifAvailable: true }, async lock => {
        if (cancelled) return;
        if (!lock) { setState('locked'); return; }
        setState('ready');
        await new Promise<void>(resolve => { release = resolve; if (cancelled) resolve(); });
      });
    }).catch(() => { if (!cancelled) setState('unsupported'); });
    previousRequest = request;
    return () => { cancelled = true; release?.(); };
  }, []);
  if (state === 'ready') return children;
  return <main className="startup-state"><div className="eyebrow">NEXUS</div><h1>{state === 'locked' ? 'Dein Raum ist bereits geöffnet.' : state === 'unsupported' ? 'Dieser Browser benötigt ein Update.' : 'Dein Raum wird geöffnet …'}</h1>{state === 'locked' && <><p>NEXUS ist bereits in einem anderen Tab geöffnet. Schließe diesen zuerst, damit sich Änderungen nicht gegenseitig überschreiben.</p><button className="primary-button" onClick={() => location.reload()}>Erneut öffnen</button></>}{state === 'unsupported' && <p>Bitte öffne NEXUS in einem aktuellen Browser über localhost oder HTTPS. Für sicheren lokalen Datenzugriff wird die Web-Locks-Unterstützung benötigt.</p>}</main>;
}
