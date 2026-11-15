import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Bold, CheckSquare, Eye, Heading2, History, Italic, List, PencilLine, Sparkles, Tag, Undo2, X } from 'lucide-react';
import type { Note, NotePatch, Selection } from '../types';
import { MarkdownPreview } from './MarkdownPreview';
import '../horizon/notes.css';

interface NoteEditorProps {
  note: Note;
  onChange: (patch: NotePatch) => void;
  onSelectionChange: (selection: Selection | null) => void;
  onAI: () => void;
  onRestoreRevision: (id: string) => void;
  timeZone?: string;
}

type Format = 'heading' | 'bold' | 'italic' | 'list' | 'checkbox';
const MAX_TAGS = 8;
const MAX_TAG_LENGTH = 40;
const MAX_CONTENT_LENGTH = 2_097_152;

function formattedDate(value: string, timeZone: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unbekanntes Datum' : date.toLocaleString('de-DE', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone });
}

export function NoteEditor({ note, onChange, onSelectionChange, onAI, onRestoreRevision, timeZone = 'Europe/Berlin' }: NoteEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const selectionCallback = useRef(onSelectionChange);
  selectionCallback.current = onSelectionChange;
  const noteRef = useRef(note);
  noteRef.current = note;
  const [preview, setPreview] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const [tagError, setTagError] = useState('');
  const [editorError, setEditorError] = useState('');
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const readOnly = note.deletedAt !== null;

  useEffect(() => {
    setPreview(false);
    setTagDraft('');
    setTagError('');
    setEditorError('');
    setRevisionId(null);
    selectionCallback.current(null);
    const selectedNote = noteRef.current;
    if (!selectedNote.deletedAt && !selectedNote.title && !selectedNote.content) {
      const frame = requestAnimationFrame(() => textareaRef.current?.focus());
      return () => cancelAnimationFrame(frame);
    }
  }, [note.id]);

  const reportSelection = (element: HTMLTextAreaElement, content = element.value) => {
    const { selectionStart: start, selectionEnd: end } = element;
    onSelectionChange(end > start ? { start, end, text: content.slice(start, end) } : null);
  };

  const replaceContent = (content: string, start: number, end = start) => {
    if (content.length > MAX_CONTENT_LENGTH) {
      setEditorError('Diese Änderung würde die Grenze von 2.097.152 Zeichen überschreiten. Dein bisheriger Text bleibt erhalten. Kürze ihn zuerst oder nutze eine weitere Notiz.');
      return;
    }
    setEditorError('');
    onChange({ content });
    onSelectionChange(end > start ? { start, end, text: content.slice(start, end) } : null);
    const currentId = note.id;
    requestAnimationFrame(() => {
      if (noteRef.current.id !== currentId) return;
      const textarea = textareaRef.current;
      textarea?.focus();
      textarea?.setSelectionRange(start, end);
    });
  };

  const format = (kind: Format) => {
    const textarea = textareaRef.current;
    if (!textarea || readOnly || preview) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const source = textarea.value;
    if (kind === 'bold' || kind === 'italic') {
      const marker = kind === 'bold' ? '**' : '*';
      const selected = source.slice(start, end);
      if (start >= marker.length && source.slice(start - marker.length, start) === marker && source.slice(end, end + marker.length) === marker) {
        replaceContent(source.slice(0, start - marker.length) + selected + source.slice(end + marker.length), start - marker.length, end - marker.length);
      } else {
        const text = selected || (kind === 'bold' ? 'fetter Text' : 'kursiver Text');
        replaceContent(source.slice(0, start) + marker + text + marker + source.slice(end), start + marker.length, start + marker.length + text.length);
      }
      return;
    }
    const lineStart = start === 0 ? 0 : source.lastIndexOf('\n', start - 1) + 1;
    const selectionEnd = end > start && source[end - 1] === '\n' ? end - 1 : end;
    const nextNewline = source.indexOf('\n', selectionEnd);
    const lineEnd = nextNewline === -1 ? source.length : nextNewline;
    const lines = source.slice(lineStart, lineEnd).split('\n');
    const prefix = kind === 'heading' ? '## ' : kind === 'checkbox' ? '- [ ] ' : '- ';
    const ownPattern = kind === 'heading' ? /^(\s*)#{1,6}\s+/ : kind === 'checkbox' ? /^(\s*)[-*+]\s+\[[ xX]\]\s*/ : /^(\s*)[-*+]\s+(?!\[[ xX]\])/;
    const allFormatted = lines.every(line => ownPattern.test(line));
    const formatted = lines.map(line => {
      if (allFormatted) return line.replace(ownPattern, '$1');
      const indent = /^\s*/.exec(line)?.[0] || '';
      const plain = line.slice(indent.length).replace(/^(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)/, '');
      return indent + prefix + plain;
    }).join('\n');
    replaceContent(source.slice(0, lineStart) + formatted + source.slice(lineEnd), lineStart, lineStart + formatted.length);
  };

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (readOnly) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      if (event.key.toLowerCase() === 'b' || event.key.toLowerCase() === 'i') {
        event.preventDefault();
        format(event.key.toLowerCase() === 'b' ? 'bold' : 'italic');
      }
      return;
    }
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    const textarea = event.currentTarget;
    if (textarea.selectionStart !== textarea.selectionEnd) return;
    const position = textarea.selectionStart;
    const lineStart = textarea.value.lastIndexOf('\n', position - 1) + 1;
    const line = textarea.value.slice(lineStart, position);
    const list = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (!list) return;
    event.preventDefault();
    if (!list[4].trim()) {
      replaceContent(textarea.value.slice(0, lineStart) + textarea.value.slice(position), lineStart);
      return;
    }
    const marker = /^\d/.test(list[2]) ? `${Number.parseInt(list[2], 10) + 1}${list[2].slice(-1)}` : list[2];
    const next = `\n${list[1]}${marker} ${list[3] ? '[ ] ' : ''}`;
    replaceContent(textarea.value.slice(0, position) + next + textarea.value.slice(position), position + next.length);
  };

  const addTags = () => {
    if (readOnly || !tagDraft.trim()) return;
    const incoming = tagDraft.split(',').map(tag => tag.trim().replace(/^#+/, '')).filter(Boolean);
    const tags = [...note.tags];
    for (const tag of incoming) {
      if (tags.some(existing => existing.toLocaleLowerCase('de-DE') === tag.toLocaleLowerCase('de-DE'))) continue;
      if (tag.length > MAX_TAG_LENGTH) {
        setTagError(`Ein Tag darf höchstens ${MAX_TAG_LENGTH} Zeichen haben.`);
        return;
      }
      if (tags.length >= MAX_TAGS) {
        setTagError(`Du kannst bis zu ${MAX_TAGS} Tags vergeben.`);
        return;
      }
      tags.push(tag);
    }
    if (tags.length !== note.tags.length) onChange({ tags });
    setTagDraft('');
    setTagError('');
  };

  const toggleTask = (lineIndex: number, checked: boolean) => {
    if (readOnly) return;
    const lines = note.content.split('\n');
    const line = lines[lineIndex];
    if (line === undefined) return;
    lines[lineIndex] = line.replace(/^((?:[ \t]*>[ \t]*)*[ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[[ xX]\]/, `$1[${checked ? 'x' : ' '}]`);
    if (lines[lineIndex] !== line) {
      onChange({ content: lines.join('\n') });
      onSelectionChange(null);
    }
  };

  const revisions = [...note.revisions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const revision = revisions.find(item => item.id === revisionId);
  const words = note.content.trim() ? note.content.trim().split(/\s+/u).length : 0;
  const tools: { kind: Format; label: string; title: string; icon: typeof Bold }[] = [
    { kind: 'heading', label: 'Überschrift', title: 'Überschrift', icon: Heading2 },
    { kind: 'bold', label: 'Fett', title: 'Fett (Strg/⌘ + B)', icon: Bold },
    { kind: 'italic', label: 'Kursiv', title: 'Kursiv (Strg/⌘ + I)', icon: Italic },
    { kind: 'list', label: 'Aufzählung', title: 'Aufzählung', icon: List },
    { kind: 'checkbox', label: 'Checkliste', title: 'Checkliste', icon: CheckSquare },
  ];

  return <section className="editor notes-editor" aria-label={readOnly ? 'Notiz im Papierkorb' : 'Notiz bearbeiten'}>
    <header className="editor-header">
      <time className="notes-page-date" dateTime={note.updatedAt}>{formattedDate(note.updatedAt, timeZone)}</time>
      <input className="title-input" aria-label="Notiztitel" placeholder="Unbenannte Notiz" value={note.title} maxLength={500} readOnly={readOnly} onChange={event => onChange({ title: event.target.value })} />
      <div className="tag-editor" aria-label="Tags">
        <Tag size={14} aria-hidden="true" />
        {note.tags.map(tag => <span className="tag-chip" key={tag}><span>{tag}</span>{!readOnly && <button type="button" aria-label={`Tag ${tag} entfernen`} title={`Tag ${tag} entfernen`} onMouseDown={event => event.preventDefault()} onClick={() => onChange({ tags: note.tags.filter(item => item !== tag) })}><X size={12} aria-hidden="true" /></button>}</span>)}
        {!readOnly && <input className="tag-input" aria-label="Tags hinzufügen" placeholder={note.tags.length ? '+ Tag' : 'Tags hinzufügen …'} value={tagDraft} maxLength={MAX_TAG_LENGTH * MAX_TAGS} aria-describedby={tagError ? 'tag-error' : 'tag-hint'} onChange={event => { setTagDraft(event.target.value); setTagError(''); }} onBlur={addTags} onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); addTags(); }
          if (event.key === 'Escape') { setTagDraft(''); setTagError(''); }
        }} />}
        {readOnly && !note.tags.length && <span className="tag-hint">Keine Tags</span>}
      </div>
      {!readOnly && <small id="tag-hint" className="sr-only">Tags mit Enter oder Komma hinzufügen.</small>}
      {tagError && <p id="tag-error" className="field-error" role="alert">{tagError}</p>}
    </header>

    <div className="editor-toolbar" role="group" aria-label="Textwerkzeuge">
      {tools.map(({ kind, label, title, icon: Icon }) => <button key={kind} type="button" aria-label={label} title={title} disabled={readOnly || preview} onMouseDown={event => event.preventDefault()} onClick={() => format(kind)}><Icon size={17} aria-hidden="true" /></button>)}
      <span className="toolbar-divider" aria-hidden="true" />
      <button type="button" className="editor-mode-switch" aria-label={preview ? 'Text bearbeiten' : 'Vorschau anzeigen'} title={preview ? 'Text bearbeiten' : 'Vorschau anzeigen'} aria-pressed={preview} onClick={() => {
        setPreview(value => !value);
        onSelectionChange(null);
        if (preview) requestAnimationFrame(() => textareaRef.current?.focus());
      }}>{preview ? <PencilLine size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}<span>{preview ? 'Bearbeiten' : 'Vorschau'}</span></button>
      {!readOnly && <button type="button" className="editor-ai-button" title="KI-Assistent" aria-label="KI-Assistent" onMouseDown={event => event.preventDefault()} onClick={onAI}><Sparkles size={16} aria-hidden="true" /><span>KI</span></button>}
    </div>

    {editorError && <p id="editor-error" className="field-error" role="alert">{editorError}</p>}
    <div className="editor-content">
      {preview ? <MarkdownPreview content={note.content} onToggleTask={readOnly ? undefined : toggleTask} /> : <textarea ref={textareaRef} className="editor-textarea" aria-label="Notiztext" aria-describedby={editorError ? 'editor-error' : undefined} placeholder="Was beschäftigt dich? Schreib es auf …" value={note.content} readOnly={readOnly} spellCheck lang="de" onPaste={event => {
        if (readOnly) return;
        const textarea = event.currentTarget;
        const length = textarea.value.length - (textarea.selectionEnd - textarea.selectionStart) + event.clipboardData.getData('text/plain').length;
        if (length > MAX_CONTENT_LENGTH) {
          event.preventDefault();
          setEditorError('Der eingefügte Text würde die Grenze von 2.097.152 Zeichen überschreiten und wurde deshalb nicht eingefügt. Teile den Text auf mehrere Notizen auf.');
        }
      }} onChange={event => {
        if (event.target.value.length > MAX_CONTENT_LENGTH) {
          setEditorError('Die Grenze von 2.097.152 Zeichen ist erreicht. Dein bisheriger Text bleibt erhalten.');
          return;
        }
        setEditorError('');
        onChange({ content: event.target.value });
        reportSelection(event.currentTarget);
      }} onSelect={event => reportSelection(event.currentTarget)} onKeyDown={handleEditorKeyDown} />}
    </div>

    <footer className="editor-footer">
      <span>{words.toLocaleString('de-DE')} {words === 1 ? 'Wort' : 'Wörter'} <span aria-hidden="true">·</span> {note.content.length.toLocaleString('de-DE')} Zeichen</span>
      {readOnly && <span>Zum Bearbeiten wiederherstellen</span>}
    </footer>

    {revisions.length > 0 && <details className="revision-history">
      <summary><History size={15} aria-hidden="true" /> Versionsverlauf <span>({revisions.length})</span></summary>
      <ul className="revision-list">{revisions.map(item => <li className="revision-item" key={item.id}>
        <button type="button" className="secondary-button" aria-expanded={revisionId === item.id} onClick={() => setRevisionId(current => current === item.id ? null : item.id)}><span>{item.title || 'Unbenannte Notiz'}</span><time dateTime={item.createdAt}>{formattedDate(item.createdAt, timeZone)}</time></button>
      </li>)}</ul>
      {revision && <section className="revision-preview" aria-label="Frühere Version">
        <h3>{revision.title || 'Unbenannte Notiz'}</h3>
        {revision.tags.length > 0 && <p className="tag-hint">Tags: {revision.tags.join(', ')}</p>}
        <MarkdownPreview content={revision.content} />
        <button type="button" className="secondary-button" disabled={readOnly} onClick={() => {
          try {
            onRestoreRevision(revision.id);
            setRevisionId(null);
            setEditorError('');
          } catch (error) {
            setEditorError(error instanceof Error ? error.message : 'Die frühere Version konnte nicht wiederhergestellt werden. Dein aktueller Text bleibt erhalten.');
          }
        }}><Undo2 size={15} aria-hidden="true" /> Diese Version wiederherstellen</button>
      </section>}
    </details>}
  </section>;
}
