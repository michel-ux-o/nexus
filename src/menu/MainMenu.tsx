import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ArrowUpRight, Bell, CalendarDays, CalendarRange, Clock3, LayoutDashboard, Leaf, ListTodo, Mic, NotebookPen, Pause, Play, Plus, Search, Settings2, Sparkles } from 'lucide-react';
import { dateInZone, startOfWeek } from '../planning/dates';
import { tasksForDay, tasksForWeek } from '../planning/selectors';
import type { View, WorkspaceViewProps } from '../planning/types';
import { ArtifactStage } from './artifacts/ArtifactStage';
import { createNexusScene } from './artifacts/nexus';
import { createDaylightScene } from './artifacts/daylight';
import { createSandScene } from './artifacts/sand';
import { createAuroraScene } from './artifacts/aurora';
import type { ThemeId } from '../themes/catalog';
import './MainMenu.css';

export interface MainMenuProps extends WorkspaceViewProps { onSearch?: () => void; theme?: ThemeId }
type Motion = 'still' | 'float' | 'orbit';

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return reduced;
}

export function MainMenu({ planner, notes, onNavigate, onQuickCapture, onSearch, onAI, onDictate, theme = 'nexus' }: MainMenuProps) {
  const settings = planner.data.settings;
  const [now, setNow] = useState(() => new Date());
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(() => document.hidden);
  const [compact, setCompact] = useState(false);
  const [reaction, setReaction] = useState(0);
  const reducedMotion = useReducedMotion();
  const motionId = useId();
  const menuRoot = useRef<HTMLElement>(null);
  const mode: Motion = settings.menuMotion ?? 'float';
  const stopped = paused || reducedMotion || Boolean(settings.powerSaving) || hidden || hovered || focused || mode === 'still';
  const intensity = settings.artifactIntensity ?? 'atmospheric';
  const artifactStopped = paused || reducedMotion || Boolean(settings.powerSaving) || hidden || mode === 'still' || intensity === 'still';
  const scene = useMemo(() => {
    const detail = settings.powerSaving || compact || (navigator.hardwareConcurrency > 0 && navigator.hardwareConcurrency <= 4) ? 'low' : 'high';
    return ({ nexus: createNexusScene, daylight: createDaylightScene, sand: createSandScene, aurora: createAuroraScene })[theme](detail);
  }, [theme, settings.powerSaving, compact]);

  useEffect(() => {
    const update = () => { setNow(new Date()); setHidden(document.hidden); };
    const timer = window.setInterval(update, 30_000);
    document.addEventListener('visibilitychange', update);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', update); };
  }, []);

  useEffect(() => {
    const element = menuRoot.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => {
      if (entries[0]) setCompact(entries[0].contentRect.width <= 880);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const today = dateInZone(now, settings.timeZone);
  const stats = useMemo(() => {
    const data = planner.data;
    const open = data.tasks.filter(task => task.status !== 'done');
    const day = tasksForDay(data, today);
    return {
      open: open.length,
      today: day.filter(task => task.status !== 'done').length,
      week: tasksForWeek(data, startOfWeek(today)).filter(task => task.status !== 'done').length,
      notes: notes.filter(note => note.deletedAt === null).length,
      reminders: (data.reminders ?? []).filter(reminder => reminder.enabled).length,
      appointments: data.appointments.filter(item => item.allDay ? item.allDay.endDate > today : Date.parse(item.startAt) + item.durationMinutes * 60_000 > now.getTime()).length,
    };
  }, [planner.data, notes, today, now]);

  const modules: { view: View; title: string; icon: typeof LayoutDashboard; metric: number; unit: string }[] = [
    { view: 'home', title: 'Dashboard', icon: LayoutDashboard, metric: stats.today, unit: 'heute offen' },
    { view: 'tasks', title: 'Aufgaben', icon: ListTodo, metric: stats.open, unit: 'offen' },
    { view: 'today', title: 'Tagesplanung', icon: Clock3, metric: stats.today, unit: 'heute offen' },
    { view: 'week', title: 'Wochenplanung', icon: CalendarRange, metric: stats.week, unit: 'diese Woche offen' },
    { view: 'calendar', title: 'Kalender', icon: CalendarDays, metric: stats.appointments, unit: 'kommend' },
    { view: 'notes', title: 'Notizen', icon: NotebookPen, metric: stats.notes, unit: 'Notizen' },
    { view: 'reminders', title: 'Erinnerungszentrale', icon: Bell, metric: stats.reminders, unit: 'aktiv' },
  ];

  function search() {
    if (onSearch) onSearch();
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  }

  const fullDate = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: settings.timeZone }).format(now);
  const clock = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: settings.timeZone }).format(now);

  return <section ref={menuRoot} className={`main-menu${stopped ? ' is-still' : ''}${settings.matrixBackground && !settings.powerSaving ? ' has-matrix' : ''}`} aria-labelledby="main-menu-title" data-motion={mode} data-world={theme}>
    <header className="menu-header">
      <div className="menu-heading"><svg className="menu-brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M5 4 26 6 25 25 8 28 5 4ZM10 9l12 1-1 11-10 3-1-15ZM5 4l5 5m16-3-4 4m3 15-4-4M8 28l3-4M5 4l20 21M8 28 26 6" stroke="currentColor" strokeWidth=".75" /></svg><h1 id="main-menu-title">NEXUS</h1></div>
      <div className="menu-date"><time dateTime={today}>{fullDate}</time><time className="menu-clock" dateTime={now.toISOString()} title={settings.timeZone}>{clock}</time><button type="button" className="menu-settings" aria-label="Einstellungen" title="Einstellungen" onClick={() => onNavigate('settings')}><Settings2 size={17} aria-hidden="true" /></button></div>
    </header>

    <div className="menu-universe" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
      <div className="menu-world-architecture" aria-hidden="true"><span /><span /><span /></div>
      <div className="menu-center"><ArtifactStage scene={scene} animated={!artifactStopped} intensity={intensity} powerSaving={settings.powerSaving} reaction={reaction} offset={compact ? [0, 0] : [0.38, 0.22]} /><div className="menu-world-caption"><span className="menu-center-caption">{scene.label}</span><small>Ziehen oder Pfeiltasten zum Drehen</small></div></div>
      <div className="menu-world-copy"><h2>Dein<br /><em>Arbeitsraum.</em></h2></div>
      <nav className="menu-modules" aria-label="Arbeitsbereiche" onMouseOver={() => setReaction(1)} onMouseLeave={() => setReaction(0)} onFocusCapture={() => setReaction(1)} onBlurCapture={() => setReaction(0)}><ul>{modules.map(({ view, title, icon: Icon, metric, unit }, index) => <li key={view} style={{ '--module-index': index } as CSSProperties}>
        <div className="menu-module-orientation"><button type="button" className={`menu-module menu-module-${view}`} onClick={() => onNavigate(view)}><span className="menu-module-number" aria-hidden="true">0{index + 1}</span><span className="menu-module-top"><Icon size={17} strokeWidth={1.5} aria-hidden="true" /></span><strong>{title}</strong><span className="menu-module-metric"><b>{metric}</b> {unit}</span><ArrowUpRight className="menu-module-arrow" size={17} aria-hidden="true" /></button></div>
      </li>)}</ul></nav>
    </div>

    <footer className="menu-footer">
      <div className="menu-header-actions"><button type="button" className="menu-search" aria-label="Arbeitsraum durchsuchen (Strg oder Cmd K)" title="Suchen (Strg/⌘ K)" onClick={search}><Search size={16} aria-hidden="true" /></button><button type="button" aria-label="Diktieren" title="Diktieren" onClick={onDictate}><Mic size={16} aria-hidden="true" /></button><button type="button" className="menu-ai" aria-label="KI-Assistent" title="KI-Assistent" onClick={onAI}><Sparkles size={16} aria-hidden="true" /></button><button type="button" className="menu-create" onClick={onQuickCapture}><Plus size={16} aria-hidden="true" /><span>Neu erstellen</span></button></div>
      <div className="menu-motion-controls"><label htmlFor={motionId}>Bewegung</label><select id={motionId} value={mode} onChange={event => planner.updateSettings({ menuMotion: event.target.value as Motion })}><option value="float">Schweben</option><option value="orbit">Orbit</option><option value="still">Still</option></select><button type="button" className="menu-pause" aria-label={paused ? 'Animation fortsetzen' : 'Animation pausieren'} aria-pressed={paused} disabled={mode === 'still' || reducedMotion || Boolean(settings.powerSaving)} onClick={() => setPaused(value => !value)}>{paused ? <Play size={15} aria-hidden="true" /> : <Pause size={15} aria-hidden="true" />}<span>{paused ? 'Fortsetzen' : 'Pause'}</span></button>{(reducedMotion || settings.powerSaving) && <span className="menu-motion-note"><Leaf size={13} aria-hidden="true" />{settings.powerSaving ? 'Stromsparmodus' : 'Reduzierte Bewegung'}</span>}</div>
    </footer>
    <span className="sr-only">Alle Kennzahlen stammen aus deinem Arbeitsraum.</span>
  </section>;
}

export default MainMenu;
