import { useId, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, Plus, Trash2 } from 'lucide-react';
import type { Subtask } from '../types';
import { SubtaskCheckbox } from './SubtaskChecklist';
import './SubtaskEditor.css';

export interface SubtaskEditorProps {
  value: Subtask[];
  onChange: (value: Subtask[]) => void;
  disabled?: boolean;
  templateMode?: boolean;
}

function move<T>(items: T[], from: number, offset: number): T[] {
  const target = from + offset;
  if (target < 0 || target >= items.length) return items;
  const result = [...items];
  [result[from], result[target]] = [result[target], result[from]];
  return result;
}

export function SubtaskEditor({ value, onChange, disabled = false, templateMode = false }: SubtaskEditorProps) {
  const prefix = useId();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  function patch(id: string, values: Partial<Subtask>) {
    onChange(value.map(item => item.id === id ? { ...item, ...values } : item));
  }

  function changeChildren(item: Subtask, children: NonNullable<Subtask['children']>) {
    patch(item.id, { children, done: children.length ? children.every(child => child.done) : item.done });
  }

  function addChild(item: Subtask) {
    changeChildren(item, [...(item.children ?? []), { id: crypto.randomUUID(), title: '', done: false, suggestion: false }]);
    setCollapsed(current => ({ ...current, [item.id]: false }));
  }

  return <fieldset className="subtask-editor" disabled={disabled} onInvalidCapture={event => {
    setCollapsed({});
    // Reveal before the browser focuses an invalid child field.
    const hiddenList = (event.target as HTMLElement).closest<HTMLOListElement>('ol[hidden]');
    if (hiddenList) hiddenList.hidden = false;
  }}>
    <legend>Unteraufgaben</legend>
    {!value.length && <p className="planning-help">Einzelne Schritte oder Gruppen mit eigenen Schritten.</p>}
    <ol className="subtask-editor-list">{value.map((item, index) => {
      const children = item.children ?? [];
      const doneCount = children.filter(child => child.done).length;
      const checked = children.length ? doneCount === children.length : item.done;
      const mixed = children.length > 0 && doneCount > 0 && !checked;
      const expanded = !collapsed[item.id];
      const childrenId = `${prefix}-children-${index}`;
      return <li key={item.id} className="subtask-editor-item">
        <div className="subtask-editor-heading"><span>{children.length ? 'Gruppe' : 'Unteraufgabe'} {index + 1}</span><div className="subtask-editor-actions">
          <button type="button" className="icon-button" aria-label={`Unteraufgabe ${index + 1} nach oben`} disabled={disabled || index === 0} onClick={() => onChange(move(value, index, -1))}><ArrowUp size={16} aria-hidden="true" /></button>
          <button type="button" className="icon-button" aria-label={`Unteraufgabe ${index + 1} nach unten`} disabled={disabled || index === value.length - 1} onClick={() => onChange(move(value, index, 1))}><ArrowDown size={16} aria-hidden="true" /></button>
          <button type="button" className="icon-button" aria-label={`Unteraufgabe ${index + 1} entfernen`} onClick={() => onChange(value.filter(current => current.id !== item.id))}><Trash2 size={16} aria-hidden="true" /></button>
        </div></div>
        <div className="subtask-editor-main">{!templateMode && <label className="planning-check subtask-editor-done"><SubtaskCheckbox checked={checked} mixed={mixed} aria-label={`${children.length ? 'Alle Schritte von Gruppe' : 'Unteraufgabe'} ${index + 1} erledigt`} onChange={event => {
          const done = event.target.checked;
          patch(item.id, { done, ...(children.length ? { children: children.map(child => ({ ...child, done })) } : {}) });
        }} /><span className="sr-only">Erledigt</span></label>}
          <label className="field"><span>{children.length ? `Titel von Gruppe ${index + 1}` : `Titel von Schritt ${index + 1}`}</span><input required maxLength={500} value={item.title} onChange={event => patch(item.id, { title: event.target.value })} /></label>
        </div>
        <div className="subtask-editor-options"><label className="planning-check"><input type="checkbox" checked={item.suggestion} onChange={event => patch(item.id, { suggestion: event.target.checked })} /><span>Vorschlag</span></label>
          {children.length > 0 && <button type="button" className="subtask-editor-collapse secondary-button" aria-expanded={expanded} aria-controls={childrenId} onClick={() => setCollapsed(current => ({ ...current, [item.id]: expanded }))}><ChevronDown size={16} aria-hidden="true" />{children.length} {children.length === 1 ? 'Schritt' : 'Schritte'} · {doneCount} erledigt</button>}
        </div>
        {children.length > 0 && <ol id={childrenId} className="subtask-editor-children" hidden={!expanded}>{children.map((child, childIndex) => <li key={child.id}>
          <div className="subtask-editor-heading"><span>Schritt {index + 1}.{childIndex + 1}</span><div className="subtask-editor-actions">
            <button type="button" className="icon-button" aria-label={`Schritt ${index + 1}.${childIndex + 1} nach oben`} disabled={disabled || childIndex === 0} onClick={() => changeChildren(item, move(children, childIndex, -1))}><ArrowUp size={16} aria-hidden="true" /></button>
            <button type="button" className="icon-button" aria-label={`Schritt ${index + 1}.${childIndex + 1} nach unten`} disabled={disabled || childIndex === children.length - 1} onClick={() => changeChildren(item, move(children, childIndex, 1))}><ArrowDown size={16} aria-hidden="true" /></button>
            <button type="button" className="icon-button" aria-label={`Schritt ${index + 1}.${childIndex + 1} entfernen`} onClick={() => changeChildren(item, children.filter(current => current.id !== child.id))}><Trash2 size={16} aria-hidden="true" /></button>
          </div></div>
          <div className="subtask-editor-main">{!templateMode && <label className="planning-check subtask-editor-done"><input type="checkbox" checked={child.done} aria-label={`Schritt ${index + 1}.${childIndex + 1} erledigt`} onChange={event => changeChildren(item, children.map(current => current.id === child.id ? { ...current, done: event.target.checked } : current))} /><span className="sr-only">Erledigt</span></label>}
            <label className="field"><span>Titel von Schritt {index + 1}.{childIndex + 1}</span><input required maxLength={500} value={child.title} onChange={event => changeChildren(item, children.map(current => current.id === child.id ? { ...current, title: event.target.value } : current))} /></label>
          </div>
          <label className="planning-check"><input type="checkbox" checked={child.suggestion} onChange={event => changeChildren(item, children.map(current => current.id === child.id ? { ...current, suggestion: event.target.checked } : current))} /><span>Vorschlag</span></label>
        </li>)}</ol>}
        <button type="button" className="secondary-button subtask-editor-add-child" onClick={() => addChild(item)}><Plus size={15} aria-hidden="true" />{children.length ? 'Schritt ergänzen' : 'In einzelne Schritte aufteilen'}</button>
      </li>;
    })}</ol>
    <button type="button" className="secondary-button" onClick={() => onChange([...value, { id: crypto.randomUUID(), title: '', done: false, suggestion: false }])}><Plus size={16} aria-hidden="true" />Unteraufgabe hinzufügen</button>
  </fieldset>;
}
