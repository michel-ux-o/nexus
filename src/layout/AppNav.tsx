import { useEffect, useId, useRef, useState } from 'react';
import { Bell, CalendarDays, CalendarRange, CheckSquare, ChevronDown, Home, ListTodo, NotebookPen, Plus } from 'lucide-react';
import type { View } from '../planning/types';
import './AppNav.css';

export interface AppNavProps {
  view: View;
  onNavigate: (view: View) => void;
  onCreateNote: () => void;
  onCreateTask: () => void;
  onDictate: () => void;
  onAI: () => void;
  onSettings: () => void;
  onSearch?: () => void;
  onQuickCapture?: () => void;
}

const destinations = [
  { view: 'home', label: 'Dashboard', icon: Home },
  { view: 'tasks', label: 'Aufgaben', icon: ListTodo },
  { view: 'today', label: 'Tagesplanung', icon: CalendarDays },
  { view: 'week', label: 'Wochenplanung', icon: CalendarRange },
  { view: 'calendar', label: 'Kalender', icon: CalendarDays },
  { view: 'notes', label: 'Notizen', icon: NotebookPen },
  { view: 'reminders', label: 'Erinnerungen', icon: Bell },
] as const;

export function AppNav({ view, onNavigate, onCreateNote, onCreateTask }: AppNavProps) {
  const atelier = view !== 'menu';
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigation = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const bodyId = useId();
  useEffect(() => {
    if (!mobileOpen) return;
    // Close after the destination receives its click, so collapsing the mobile
    // rail cannot move a header action between pointerdown and pointerup.
    const outside = (event: MouseEvent) => { if (event.target instanceof Node && !navigation.current?.contains(event.target)) setMobileOpen(false); };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { setMobileOpen(false); toggle.current?.focus(); } };
    document.addEventListener('click', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('click', outside); document.removeEventListener('keydown', escape); };
  }, [mobileOpen]);
  const closeMobile = () => {
    if (atelier && window.matchMedia('(max-width: 760px)').matches && mobileOpen) toggle.current?.focus();
    setMobileOpen(false);
  };
  const navigate = (destination: View) => { closeMobile(); onNavigate(destination); };
  const capture = (action: () => void) => { closeMobile(); action(); };
  return <aside ref={navigation} className={`app-nav${atelier ? ' app-nav--atelier' : ''}${mobileOpen ? ' is-mobile-open' : ''}`} aria-label="NEXUS Navigation">
    <div className="app-nav-brand-row">
      <button className="app-nav-brand" type="button" onClick={() => navigate('menu')} aria-label="NEXUS – zum Hauptmenü" aria-current={view === 'menu' ? 'page' : undefined}>
        <svg viewBox="0 0 40 40" fill="none" aria-hidden="true">
          {atelier ? <><path d="M7 11h21v21H7zM13 5h21v21H13zM7 11l6-6m15 6 6-6M7 32l6-6m15 6 6-6" stroke="currentColor" strokeWidth="1.2" /><path d="m13 26 15-15M7 11l27 15" stroke="currentColor" strokeWidth=".8" opacity=".5" /><path d="M25 29h6m-3-3v6" stroke="currentColor" strokeWidth="1.5" /></> : <><path d="M20 3 35 11.5v17L20 37 5 28.5v-17L20 3Z M20 11.5l7.5 4.25v8.5L20 28.5l-7.5-4.25v-8.5L20 11.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><path d="M20 3v8.5m15 0-7.5 4.25M35 28.5l-7.5-4.25M20 37v-8.5M5 28.5l7.5-4.25M5 11.5l7.5 4.25L20 20l7.5-4.25M20 20v8.5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></>}
        </svg>
        <span><strong>NEXUS</strong><span>{atelier ? 'Dein Arbeitsraum' : 'Zum Hauptmenü'}</span></span>
      </button>
      {atelier && <button ref={toggle} className="app-nav-mobile-toggle" type="button" aria-expanded={mobileOpen} aria-controls={bodyId} onClick={() => setMobileOpen(!mobileOpen)}><span>Bereiche</span><ChevronDown size={16} aria-hidden="true" /></button>}
    </div>

    <div className="app-nav-body" id={bodyId}>
    {atelier && <span className="app-nav-atelier-label" aria-hidden="true">DEIN RAUM FÜR</span>}
    <nav className="app-nav-destinations" aria-label="Hauptbereiche">
      {destinations.map(({ view: destination, label, icon: Icon }, index) => <button
        key={destination}
        type="button"
        className={`app-nav-destination${view === destination ? ' is-current' : ''}`}
        aria-current={view === destination ? 'page' : undefined}
        onClick={() => navigate(destination)}
      >{atelier && <span className="app-nav-coordinate" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>}<Icon size={19} strokeWidth={1.7} aria-hidden="true" /><span>{label}</span><span className="app-nav-current-dot" aria-hidden="true" /></button>)}
    </nav>

    <div className="app-nav-capture" role="group" aria-label="Schnell erfassen">
      <span className="app-nav-section-label">SCHNELL ERFASSEN</span>
      <button className="app-nav-new-note" type="button" onClick={() => capture(onCreateNote)}><Plus size={18} aria-hidden="true" /><span>Neue Notiz</span></button>
      <button className="app-nav-new-task" type="button" onClick={() => capture(onCreateTask)}><CheckSquare size={18} aria-hidden="true" /><span>Neue Aufgabe</span></button>
    </div>
    </div>
  </aside>;
}
