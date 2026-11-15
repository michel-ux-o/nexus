export type SceneRegion = 'tasks' | 'calendar' | 'focus' | 'notes' | 'reminders' | 'home';

export interface SceneEvent {
  kind: 'hover' | 'select' | 'day' | 'commit' | 'typing';
  region: SceneRegion;
  action?: 'add' | 'complete' | 'restore' | 'update';
  direction?: number;
  active?: boolean;
  item?: string;
}

const eventName = 'nexus:horizon-scene';
const regions: readonly string[] = ['tasks', 'calendar', 'focus', 'notes', 'reminders', 'home'];
const kinds: readonly string[] = ['hover', 'select', 'day', 'commit', 'typing'];
const actions: readonly string[] = ['add', 'complete', 'restore', 'update'];

function isSceneEvent(value: unknown): value is SceneEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return typeof event.kind === 'string' && kinds.includes(event.kind)
    && typeof event.region === 'string' && regions.includes(event.region)
    && (event.action === undefined || typeof event.action === 'string' && actions.includes(event.action))
    && (event.direction === undefined || typeof event.direction === 'number' && Number.isFinite(event.direction))
    && (event.active === undefined || typeof event.active === 'boolean')
    && (event.item === undefined || typeof event.item === 'string');
}

/** Publish an explicit UI action after it succeeds. This does not persist state. */
export function emitHorizonScene(event: SceneEvent): void {
  if (typeof window === 'undefined' || typeof window.CustomEvent !== 'function' || !isSceneEvent(event)) return;
  window.dispatchEvent(new window.CustomEvent<SceneEvent>(eventName, { detail: event }));
}

/** Listen only to explicit CustomEvents, not delegated DOM interactions. */
export function listenHorizonScene(callback: (event: SceneEvent) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const target = window;
  const listener = (event: Event) => {
    const detail: unknown = (event as CustomEvent<unknown>).detail;
    if (isSceneEvent(detail)) callback(detail);
  };
  target.addEventListener(eventName, listener);
  return () => target.removeEventListener(eventName, listener);
}

interface SceneTarget {
  region: SceneRegion;
  item?: string;
}

function elementFor(target: EventTarget | null): Element | null {
  return target instanceof Element ? target : null;
}

function sceneTarget(target: EventTarget | null): SceneTarget | null {
  const element = elementFor(target);
  const regionElement = element?.closest('[data-scene-region]');
  const region = regionElement?.getAttribute('data-scene-region');
  if (!regionElement || !region || !regions.includes(region)) return null;
  const itemElement = element?.closest('[data-scene-item]');
  const item = itemElement && regionElement.contains(itemElement) ? itemElement.getAttribute('data-scene-item') : null;
  return item ? { region: region as SceneRegion, item } : { region: region as SceneRegion };
}

function typingTarget(target: EventTarget | null): SceneTarget | null {
  const element = elementFor(target);
  if (!element) return null;
  let editable = false;
  if (element.tagName === 'TEXTAREA') {
    const textarea = element as HTMLTextAreaElement;
    editable = !textarea.disabled && !textarea.readOnly;
  } else if (element.tagName === 'INPUT') {
    const input = element as HTMLInputElement;
    editable = !input.disabled && !input.readOnly && ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(input.type);
  } else {
    const contentEditable = element.closest('[contenteditable]')?.getAttribute('contenteditable')?.toLowerCase();
    editable = contentEditable === '' || contentEditable === 'true' || contentEditable === 'plaintext-only';
  }
  return editable ? sceneTarget(target) ?? { region: 'home' } : null;
}

function sameTarget(a: SceneTarget | null, b: SceneTarget | null): boolean {
  return a === b || !!a && !!b && a.region === b.region && a.item === b.item;
}

/**
 * Observe only DOM hover/focus and editing activity. Subscribe to
 * listenHorizonScene separately for select/day/commit actions. Mark regions with
 * data-scene-region and optional item IDs with data-scene-item; text is never read.
 */
export function observeHorizonInteraction(callback: (event: SceneEvent) => void): () => void {
  if (typeof document === 'undefined' || typeof Element === 'undefined') return () => {};
  const target = document;
  let pointer: SceneTarget | null = null;
  let focused = sceneTarget(target.activeElement);
  let hovered: SceneTarget | null = null;
  let typing: SceneTarget | null = null;

  const update = (kind: 'hover' | 'typing', previous: SceneTarget | null, next: SceneTarget | null) => {
    if (sameTarget(previous, next)) return;
    if (previous) callback({ kind, ...previous, active: false });
    if (next) callback({ kind, ...next, active: true });
  };
  const updateHover = () => {
    const next = pointer ?? focused;
    update('hover', hovered, next);
    hovered = next;
  };
  const updateTyping = (next: SceneTarget | null) => {
    update('typing', typing, next);
    typing = next;
  };
  const pointerOver = (event: PointerEvent) => {
    pointer = sceneTarget(event.target);
    updateHover();
  };
  const pointerOut = (event: PointerEvent) => {
    pointer = sceneTarget(event.relatedTarget);
    updateHover();
  };
  const pointerDown = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') return;
    pointer = sceneTarget(event.target);
    updateHover();
  };
  const pointerEnd = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') return;
    pointer = null;
    updateHover();
  };
  const focusIn = (event: FocusEvent) => {
    focused = sceneTarget(event.target);
    updateHover();
    updateTyping(typingTarget(event.target));
  };
  const focusOut = (event: FocusEvent) => {
    focused = sceneTarget(event.relatedTarget);
    updateHover();
    updateTyping(typingTarget(event.relatedTarget));
  };
  const pointerOptions = { passive: true, capture: false };
  target.addEventListener('pointerover', pointerOver, pointerOptions);
  target.addEventListener('pointerout', pointerOut, pointerOptions);
  target.addEventListener('pointerdown', pointerDown, pointerOptions);
  target.addEventListener('pointerup', pointerEnd, pointerOptions);
  target.addEventListener('pointercancel', pointerEnd, pointerOptions);
  target.addEventListener('focusin', focusIn);
  target.addEventListener('focusout', focusOut);
  updateHover();
  updateTyping(typingTarget(target.activeElement));

  return () => {
    target.removeEventListener('pointerover', pointerOver, pointerOptions);
    target.removeEventListener('pointerout', pointerOut, pointerOptions);
    target.removeEventListener('pointerdown', pointerDown, pointerOptions);
    target.removeEventListener('pointerup', pointerEnd, pointerOptions);
    target.removeEventListener('pointercancel', pointerEnd, pointerOptions);
    target.removeEventListener('focusin', focusIn);
    target.removeEventListener('focusout', focusOut);
  };
}
