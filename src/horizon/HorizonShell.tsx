import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Bell, CalendarDays, CalendarRange, Compass, Home, ListTodo, Mic, NotebookPen, Plus, Search, Settings, Sparkles, X } from 'lucide-react';
import type { View } from '../planning/types';
import './shell.css';

interface HorizonHeaderProps {
  view: View;
  onNavigate: (view: View) => void;
  onDictate: () => void;
}

interface HorizonDockProps {
  view: View;
  onNavigate: (view: View) => void;
  onSearch: () => void;
  onQuickCapture: () => void;
}

const destinations = [
  { view: 'home', region: 'home', label: 'Dashboard', icon: Home },
  { view: 'tasks', region: 'tasks', label: 'Aufgaben', icon: ListTodo },
  { view: 'today', region: 'calendar', label: 'Tagesplanung', icon: CalendarDays },
  { view: 'week', region: 'calendar', label: 'Wochenplanung', icon: CalendarRange },
  { view: 'calendar', region: 'calendar', label: 'Kalender', icon: CalendarDays },
  { view: 'notes', region: 'notes', label: 'Notizen', icon: NotebookPen },
  { view: 'reminders', region: 'reminders', label: 'Erinnerungen', icon: Bell },
] as const;

/** The working world has one navigation origin: the dock below. */
export function HorizonHeader({ view, onNavigate, onDictate }: HorizonHeaderProps) {
  return <header className="horizon-header app-nav" aria-label="NEXUS">
    <button type="button" className="horizon-brand" data-scene-region="home" aria-label="NEXUS – zum Hauptmenü" aria-current={view === 'menu' ? 'page' : undefined} onClick={() => onNavigate('menu')}>
      <strong>NEXUS</strong><span>HORIZONT</span>
    </button>
    <button type="button" className="horizon-dictate" data-scene-region="home" aria-label="Spracheingabe öffnen" title="Spracheingabe öffnen" onClick={onDictate}><Mic size={19} strokeWidth={1.5} aria-hidden="true" /></button>
  </header>;
}

/** A disclosure keeps native Tab order; arrows are an additional shortcut. */
function HorizonAreas({ view, onNavigate }: Pick<HorizonDockProps, 'view' | 'onNavigate'>) {
  const [open, setOpen] = useState(false);
  const navigationId = useId();
  const titleId = useId();
  const root = useRef<HTMLDivElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const focusOnOpen = useRef(false);
  const current = destinations.find(destination => destination.view === view);

  useEffect(() => { setOpen(false); }, [view]);

  useEffect(() => {
    if (!open) return;
    const panel = root.current?.querySelector<HTMLElement>('.horizon-areas-panel');
    const title = document.querySelector<HTMLElement>('.horizon-home-focus .horizon-focus-title, .horizon-home-focus .horizon-focus-empty h2');
    const dock = root.current?.closest<HTMLElement>('.horizon-dock');
    if (!panel || !dock) return;
    const fit = () => {
      const viewport = window.visualViewport;
      const viewportTop = (viewport?.offsetTop ?? 0) + 8;
      const viewportBottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - 8;
      const dockBounds = dock.getBoundingClientRect();
      const bottom = Math.max(viewportTop, Math.min(dockBounds.top - 6, viewportBottom));
      const heading = title?.getBoundingClientRect();
      const panelHeading = panel.querySelector<HTMLElement>('.horizon-areas-heading');
      const row = navigation.current?.querySelector<HTMLElement>('.horizon-destination');
      const panelStyle = getComputedStyle(panel);
      const navStyle = navigation.current ? getComputedStyle(navigation.current) : null;
      const panelPadding = parseFloat(panelStyle.paddingTop) + parseFloat(panelStyle.paddingBottom) + 2;
      const navPadding = navStyle ? parseFloat(navStyle.paddingTop) + parseFloat(navStyle.paddingBottom) : 0;
      const rowHeight = Math.max(44, row?.getBoundingClientRect().height ?? 60);
      const headingHeight = panelHeading?.getBoundingClientRect().height ?? 54;
      const minimum = panelPadding + headingHeight + navPadding + rowHeight * 2 + 4;
      const titleBottom = heading && heading.bottom > viewportTop && heading.top < bottom ? heading.bottom + 20 : viewportTop;
      // Preserve the focus title only while at least two navigation rows fit.
      // A long title must never reduce the actual links to a few pixels.
      const top = bottom - titleBottom >= minimum ? Math.max(viewportTop, titleBottom) : viewportTop;
      const available = Math.max(0, bottom - top);
      panel.style.bottom = `${dockBounds.bottom - bottom}px`;
      panel.style.maxHeight = `${Math.min(560, available)}px`;
      panel.dataset.compact = String(available < panelPadding + headingHeight + navPadding + rowHeight);
    };
    fit();
    const observer = new ResizeObserver(fit);
    if (title) observer.observe(title);
    observer.observe(dock);
    window.addEventListener('resize', fit);
    document.addEventListener('scroll', fit, true);
    window.visualViewport?.addEventListener('resize', fit);
    window.visualViewport?.addEventListener('scroll', fit);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', fit);
      document.removeEventListener('scroll', fit, true);
      window.visualViewport?.removeEventListener('resize', fit);
      window.visualViewport?.removeEventListener('scroll', fit);
    };
  }, [open, view]);

  useEffect(() => {
    if (!open) return;
    if (focusOnOpen.current) {
      const buttons = navigation.current?.querySelectorAll<HTMLButtonElement>('.horizon-destination');
      const selected = navigation.current?.querySelector<HTMLButtonElement>('[aria-current="page"]');
      (selected ?? buttons?.[0])?.focus();
      focusOnOpen.current = false;
    }
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  function close() {
    setOpen(false);
    toggle.current?.focus();
  }

  function navigate(destination: View) {
    close();
    onNavigate(destination);
  }

  function moveFocus(event: KeyboardEvent<HTMLElement>) {
    const direction = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0;
    if (!direction && event.key !== 'Home' && event.key !== 'End') return;
    const buttons = Array.from(navigation.current?.querySelectorAll<HTMLButtonElement>('.horizon-destination') ?? []);
    if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + direction + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }

  return <div ref={root} className="horizon-dock-areas" onBlur={event => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button ref={toggle} type="button" className={`horizon-areas-toggle${current && view !== 'home' ? ' is-active-area' : ''}`} data-scene-region={current?.region ?? 'home'} aria-expanded={open} aria-controls={navigationId} onClick={() => setOpen(value => !value)} onKeyDown={event => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      if (open) navigation.current?.querySelector<HTMLButtonElement>('.horizon-destination')?.focus();
      else { focusOnOpen.current = true; setOpen(true); }
    }}>
      <Compass size={21} strokeWidth={1.4} aria-hidden="true" /><span>Bereiche</span>
    </button>
    {open && <div className="horizon-areas-panel" id={navigationId}>
      <div className="horizon-areas-heading">
        <h2 id={titleId}>Bereiche</h2>
        <button type="button" className="horizon-areas-close" aria-label="Bereiche schließen" onClick={close}><X size={18} aria-hidden="true" /></button>
      </div>
      <nav ref={navigation} className="horizon-destinations" aria-labelledby={titleId} onKeyDown={moveFocus}>
        {destinations.map(({ view: destination, region, label, icon: Icon }, index) => <button key={destination} type="button" data-scene-region={region} className={`horizon-destination${view === destination ? ' is-current' : ''}`} aria-current={view === destination ? 'page' : undefined} onClick={() => navigate(destination)}>
          <Icon size={19} strokeWidth={1.4} aria-hidden="true" /><span>{label}</span><small aria-hidden="true">{String(index + 1).padStart(2, '0')}</small>
        </button>)}
      </nav>
    </div>}
  </div>;
}

/** Quiet, persistent tools; icon-only controls still have explicit accessible names. */
export function HorizonDock({ view, onNavigate, onSearch, onQuickCapture }: HorizonDockProps) {
  const start = view === 'menu' || view === 'home';
  return <nav className="horizon-dock" aria-label="Werkzeuge">
    <button type="button" data-scene-region="home" aria-label="Zur Startansicht" title="Zur Startansicht" aria-current={start ? 'page' : undefined} onClick={() => onNavigate('menu')}><Home size={21} strokeWidth={1.4} aria-hidden="true" /><span>Start</span></button>
    <HorizonAreas view={view} onNavigate={onNavigate} />
    <button type="button" data-scene-region="home" aria-label="Suche öffnen" title="Suche öffnen (Strg+K)" aria-keyshortcuts="Control+k Meta+k" onClick={onSearch}><Search size={21} strokeWidth={1.4} aria-hidden="true" /><span>Suche</span></button>
    <button type="button" data-scene-region="home" aria-label="KI-Assistent öffnen" title="KI-Assistent öffnen" aria-current={view === 'ai' ? 'page' : undefined} onClick={() => onNavigate('ai')}><Sparkles size={21} strokeWidth={1.4} aria-hidden="true" /><span>KI</span></button>
    <button type="button" data-scene-region="home" aria-label="Einstellungen öffnen" title="Einstellungen öffnen" aria-current={view === 'settings' ? 'page' : undefined} onClick={() => onNavigate('settings')}><Settings size={21} strokeWidth={1.4} aria-hidden="true" /><span>Einstellungen</span></button>
    <button type="button" data-scene-region="home" aria-label="Schnellerfassung öffnen" title="Schnellerfassung öffnen (Strg+Umschalt+K)" aria-keyshortcuts="Control+Shift+k Meta+Shift+k" onClick={onQuickCapture}><Plus size={23} strokeWidth={1.4} aria-hidden="true" /><span>Erfassen</span></button>
  </nav>;
}
