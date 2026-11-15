import { useEffect, useId, useRef, useState } from 'react';
import type { InputHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import type { Subtask } from '../types';
import { setSubtaskDone, subtaskProgress, subtaskState } from '../subtasks';
import './SubtaskChecklist.css';

export interface SubtaskChecklistProps {
  value: Subtask[];
  onChange: (value: Subtask[], changedId?: string) => void;
  disabled?: boolean;
}

/** A native checkbox retains keyboard, touch and screen reader behavior when mixed. */
export function SubtaskCheckbox({ mixed = false, ...props }: InputHTMLAttributes<HTMLInputElement> & { mixed?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (input.current) input.current.indeterminate = mixed; }, [mixed]);
  return <input {...props} ref={input} type="checkbox" aria-checked={mixed ? 'mixed' : props.checked} />;
}

export function SubtaskChecklist({ value, onChange, disabled = false }: SubtaskChecklistProps) {
  const prefix = useId();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  function toggleGroup(id: string, done: boolean) {
    onChange(setSubtaskDone(value, id, done), id);
  }

  function toggleChild(id: string, childId: string, done: boolean) {
    if (!value.some(item => item.id === id && item.children?.some(child => child.id === childId))) return;
    onChange(setSubtaskDone(value, childId, done), childId);
  }

  return <ul className="subtask-checklist" aria-label="Unteraufgaben">
    {value.map((item, index) => {
      const children = item.children ?? [];
      const doneCount = subtaskProgress([item]).done;
      const state = subtaskState(item);
      const checked = state === 'checked';
      const mixed = state === 'mixed';
      const expanded = !collapsed[item.id];
      const childrenId = `${prefix}-children-${index}`;
      return <li key={item.id} className="subtask-checklist-item">
        <div className="subtask-checklist-row">
          <label className={`subtask-checklist-label${checked ? ' is-done' : ''}`}>
            <SubtaskCheckbox checked={checked} mixed={mixed} disabled={disabled} onChange={event => toggleGroup(item.id, event.target.checked)} />
            <span className="subtask-checklist-copy"><span>{item.title}</span>{item.suggestion && <small>Vorschlag</small>}{children.length > 0 && <small>{doneCount} von {children.length} Schritten erledigt</small>}</span>
          </label>
          {children.length > 0 && <button type="button" className="subtask-checklist-expand icon-button" aria-label={`${expanded ? 'Schritte einklappen' : 'Schritte aufklappen'}: ${item.title}`} aria-expanded={expanded} aria-controls={childrenId} onClick={() => setCollapsed(current => ({ ...current, [item.id]: expanded }))}>
            <ChevronDown size={17} aria-hidden="true" />
          </button>}
        </div>
        {children.length > 0 && <ul className="subtask-checklist-children" id={childrenId} hidden={!expanded}>
          {children.map(child => <li key={child.id}><label className={`subtask-checklist-label${child.done ? ' is-done' : ''}`}>
            <SubtaskCheckbox checked={child.done} disabled={disabled} onChange={event => toggleChild(item.id, child.id, event.target.checked)} />
            <span className="subtask-checklist-copy"><span>{child.title}</span>{child.suggestion && <small>Vorschlag</small>}</span>
          </label></li>)}
        </ul>}
      </li>;
    })}
  </ul>;
}
