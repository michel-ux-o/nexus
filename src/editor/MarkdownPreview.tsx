import { createElement, type ReactNode } from 'react';

interface MarkdownPreviewProps {
  content: string;
  onToggleTask?: (lineIndex: number, checked: boolean) => void;
}

// Only these links become anchors. All other source content stays React text.
function safeLink(href: string): string | null {
  if (/^(https?:\/\/|mailto:)/i.test(href) || /^#[\w-]+$/.test(href)) return href;
  return null;
}

function inline(source: string, depth = 0): ReactNode[] {
  if (depth > 8) return [source];
  const pattern = /(`+)([^`]*?)\1|\[([^\[\]]+)\]\(([^\s)]+)\)|\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|__(.+?)__|\*(.+?)\*|_([^_]+?)_|~~(.+?)~~/g;
  const result: ReactNode[] = [];
  let end = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source))) {
    const start = match.index;
    if (start > end) result.push(source.slice(end, start));
    const key = `${depth}-${start}`;
    if (match[1]) {
      result.push(<code key={key}>{match[2]}</code>);
    } else if (match[3]) {
      const href = safeLink(match[4]);
      result.push(href ? <a key={key} href={href} target="_blank" rel="noopener noreferrer">{inline(match[3], depth + 1)}</a> : match[0]);
    } else if (match[5]) {
      result.push(<strong key={key}><em>{inline(match[5], depth + 1)}</em></strong>);
    } else if (match[6] || match[7]) {
      result.push(<strong key={key}>{inline(match[6] || match[7], depth + 1)}</strong>);
    } else if (match[8] || match[9]) {
      result.push(<em key={key}>{inline(match[8] || match[9], depth + 1)}</em>);
    } else {
      result.push(<del key={key}>{inline(match[10], depth + 1)}</del>);
    }
    end = pattern.lastIndex;
  }
  if (end < source.length) result.push(source.slice(end));
  return result;
}

const listLine = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const isSpecialLine = (line: string) => /^(?:#{1,6}\s|\s*```|>\s?|\s*[-*+]\s|\s*\d+[.)]\s|(?:---+|\*\*\*+)\s*$)/.test(line);

function blocks(source: string, depth = 0, onToggleTask?: MarkdownPreviewProps['onToggleTask'], lineOffset = 0): ReactNode[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const result: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const key = index;
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      result.push(<pre key={key}><code>{code.join('\n')}</code></pre>);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      result.push(createElement(`h${heading[1].length}`, { key }, inline(heading[2])));
      index += 1;
      continue;
    }
    if (/^(?:---+|\*\*\*+)\s*$/.test(line)) {
      result.push(<hr key={key} />);
      index += 1;
      continue;
    }
    if (/^>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ''));
      result.push(<blockquote key={key}>{depth < 12 ? blocks(quote.join('\n'), depth + 1, onToggleTask, lineOffset + key) : <p>{quote.join('\n')}</p>}</blockquote>);
      continue;
    }
    const list = listLine.exec(line);
    if (list) {
      const ordered = /^\d/.test(list[2]);
      const items: ReactNode[] = [];
      let item: RegExpExecArray | null;
      while (index < lines.length && (item = listLine.exec(lines[index])) && /^\d/.test(item[2]) === ordered) {
        const task = /^\[([ xX])\]\s?(.*)$/.exec(item[3]);
        const lineIndex = lineOffset + index;
        items.push(task
          ? <li key={index} className="markdown-task"><input type="checkbox" checked={task[1].toLowerCase() === 'x'} disabled={!onToggleTask} onChange={event => onToggleTask?.(lineIndex, event.target.checked)} aria-label={task[2] || 'Aufgabe'} /><span>{inline(task[2])}</span></li>
          : <li key={index}>{inline(item[3])}</li>);
        index += 1;
      }
      result.push(ordered ? <ol key={key} start={Number.parseInt(list[2], 10)}>{items}</ol> : <ul key={key}>{items}</ul>);
      continue;
    }
    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isSpecialLine(lines[index])) paragraph.push(lines[index++]);
    result.push(<p key={key}>{paragraph.map((text, lineIndex) => <span key={lineIndex}>{lineIndex > 0 && <br />}{inline(text)}</span>)}</p>);
  }

  return result;
}

export function MarkdownPreview({ content, onToggleTask }: MarkdownPreviewProps) {
  return <article className="markdown-preview" aria-label="Markdown-Vorschau">
    {content.trim() ? blocks(content, 0, onToggleTask) : <p className="editor-empty-preview">Deine Vorschau erscheint hier, sobald du etwas schreibst.</p>}
  </article>;
}
