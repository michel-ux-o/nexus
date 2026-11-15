import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type TouchEvent } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { formatDate } from '../planning/dates';
import { horizonDateStrip, horizonShiftDate } from './homeModel';
import { emitHorizonScene } from './sceneEvents';
import './HorizonDayStrip.css';

export interface HorizonDayStripProps {
  date: string;
  today: string;
  onChange: (date: string) => void;
}

/** Native scrolling with explicit date selection through controls or a touch swipe. */
export function HorizonDayStrip({ date, today, onChange }: HorizonDayStripProps) {
  const dates = useMemo(() => horizonDateStrip(date), [date]);
  const selectedIndex = dates.indexOf(date);
  const strip = useRef<HTMLDivElement>(null);
  const previousDate = useRef(date);
  const pendingFocus = useRef<string | null>(null);
  const touchStart = useRef<{ id: number; x: number; y: number } | null>(null);
  const suppressClickUntil = useRef(0);
  const [movement, setMovement] = useState<{ date: string; direction: 'previous' | 'next' } | null>(null);

  useLayoutEffect(() => {
    const surface = strip.current;
    if (!surface) return;
    if (previousDate.current !== date) {
      setMovement({ date, direction: date > previousDate.current ? 'next' : 'previous' });
      previousDate.current = date;
    }
    const centerSelection = () => {
      const selected = surface.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
      if (!selected) return;
      // scrollIntoView can also move the page; only this surface should move.
      const left = selected.offsetLeft - (surface.clientWidth - selected.offsetWidth) / 2;
      surface.scrollLeft = Math.max(0, Math.min(left, surface.scrollWidth - surface.clientWidth));
      if (pendingFocus.current === date) {
        selected.focus({ preventScroll: true });
        pendingFocus.current = null;
      }
    };
    centerSelection();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(centerSelection);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [date]);

  useEffect(() => {
    const surface = strip.current;
    if (!surface) return;
    const scrollHorizontally = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || !event.cancelable) return;
      const delta = Math.abs(event.deltaX) >= Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      const unit = event.deltaMode === 1 ? 28 : event.deltaMode === 2 ? surface.clientWidth : 1;
      const left = Math.max(0, Math.min(surface.scrollLeft + delta * unit, surface.scrollWidth - surface.clientWidth));
      // Let the page receive vertical scrolling once the strip reaches an edge.
      if (Math.abs(left - surface.scrollLeft) < .5) return;
      event.preventDefault();
      surface.scrollLeft = left;
    };
    surface.addEventListener('wheel', scrollHorizontally, { passive: false });
    return () => surface.removeEventListener('wheel', scrollHorizontally);
  }, []);

  function selectDay(next: string, focus = false) {
    if (next === date) return;
    if (focus) pendingFocus.current = next;
    emitHorizonScene({ kind: 'day', region: 'calendar', direction: next > date ? 1 : -1, item: next });
    onChange(next);
  }

  function selectWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement) || !target.dataset.date) return;
    const current = target.dataset.date;
    let next: string;
    switch (event.key) {
      case 'ArrowLeft': next = horizonShiftDate(current, -1); break;
      case 'ArrowRight': next = horizonShiftDate(current, 1); break;
      case 'PageUp': next = horizonShiftDate(current, -7); break;
      case 'PageDown': next = horizonShiftDate(current, 7); break;
      case 'Home': next = dates[0]; break;
      case 'End': next = dates[dates.length - 1]; break;
      default: return;
    }
    event.preventDefault();
    selectDay(next, true);
  }

  function startSwipe(event: TouchEvent<HTMLDivElement>) {
    const touch = event.touches.length === 1 ? event.touches[0] : null;
    touchStart.current = touch ? { id: touch.identifier, x: touch.clientX, y: touch.clientY } : null;
  }

  function moveSwipe(event: TouchEvent<HTMLDivElement>) {
    const start = touchStart.current;
    const touch = event.touches.length === 1 ? event.touches[0] : null;
    if (!start || !touch || touch.identifier !== start.id) { touchStart.current = null; return; }
    const dx = Math.abs(touch.clientX - start.x), dy = Math.abs(touch.clientY - start.y);
    if (dy > 24 && dy > dx * 1.2) touchStart.current = null;
  }

  function endSwipe(event: TouchEvent<HTMLDivElement>) {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start || event.touches.length) return;
    const touch = Array.from(event.changedTouches).find(item => item.identifier === start.id);
    if (!touch) return;
    const dx = touch.clientX - start.x, dy = touch.clientY - start.y;
    if (Math.abs(dx) < 56 || Math.abs(dx) <= Math.abs(dy) * 1.5) return;
    // Some touch devices deliver a click after the same gesture has selected a day.
    suppressClickUntil.current = Date.now() + 400;
    selectDay(horizonShiftDate(date, dx < 0 ? 1 : -1));
  }

  return <div className="horizon-day-strip-navigation" data-direction={movement?.direction}>
    <svg className="horizon-day-strip-orbit" viewBox="0 0 600 120" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path className="horizon-day-strip-orbit-far" d="M 0 57 C 150 106 450 106 600 57" />
      <path className="horizon-day-strip-orbit-near" d="M 0 65 C 150 116 450 116 600 65" />
      <path className="horizon-day-strip-orbit-dust" d="M 0 72 C 150 124 450 124 600 72" />
    </svg>
    <button className="horizon-day-strip-arrow" type="button" aria-label="Vorheriger Tag" disabled={date === '0001-01-01'} onClick={() => selectDay(horizonShiftDate(date, -1))}><ChevronLeft size={19} aria-hidden="true" /></button>
    <div className="horizon-day-strip-scroll" ref={strip} role="group" aria-label="Tag auswählen" onKeyDown={selectWithKeyboard} onTouchStart={startSwipe} onTouchMove={moveSwipe} onTouchEnd={endSwipe} onTouchCancel={() => { touchStart.current = null; }} onClickCapture={event => {
      if (event.detail && Date.now() < suppressClickUntil.current) { event.preventDefault(); event.stopPropagation(); }
    }}>
      {dates.map((item, index) => {
        const offset = Math.max(-4, Math.min(4, index - selectedIndex));
        const distance = Math.abs(offset);
        const style = {
          '--day-angle': `${offset * -4}deg`,
          '--day-depth': `${distance ? -distance * 9 : 10}px`,
          '--day-lift': `${distance ? -(Math.min(distance, 3) ** 2) * 1.5 : 0}px`,
          '--day-edge-opacity': `${distance ? Math.max(.28, .68 - distance * .1) : 1}`,
          zIndex: 8 - distance,
        } as CSSProperties;
        return <button className="horizon-day-strip-day" type="button" key={item} data-date={item} style={style} tabIndex={item === date ? 0 : -1} aria-label={formatDate(item, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} aria-pressed={item === date} aria-current={item === today ? 'date' : undefined} onClick={() => selectDay(item)}>
          <span className="horizon-day-strip-face" data-movement={movement?.date === item && item === date ? movement.direction : undefined} aria-hidden="true"><span className="horizon-day-strip-weekday">{formatDate(item, { weekday: 'short' })}</span><strong>{formatDate(item, { day: 'numeric' })}</strong><span className="horizon-day-strip-marker">{item === today ? 'Heute' : '\u00a0'}</span></span>
        </button>;
      })}
    </div>
    <button className="horizon-day-strip-arrow" type="button" aria-label="Nächster Tag" disabled={date === '9999-12-31'} onClick={() => selectDay(horizonShiftDate(date, 1))}><ChevronRight size={19} aria-hidden="true" /></button>
  </div>;
}
