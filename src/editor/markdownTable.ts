interface TableCell {
  text: string;
  start: number;
  end: number;
}

function tableCell(line: string, from: number, until: number): TableCell {
  const source = line.slice(from, until);
  const text = source.trim();
  const start = text ? from + source.length - source.trimStart().length : Math.floor((from + until) / 2);
  return { text: text.replace(/\\\|/g, '|'), start, end: start + text.length };
}

export function tableCells(line: string): TableCell[] {
  const pipes: number[] = [];
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === '|' && !escaped) pipes.push(index);
    escaped = character === '\\' && !escaped;
  }
  if (!pipes.length) return [];

  const boundaries = [-1, ...pipes, line.length];
  if (!line.slice(0, pipes[0]).trim()) boundaries.shift();
  if (!line.slice(pipes[pipes.length - 1] + 1).trim()) boundaries.pop();
  return boundaries.slice(1).map((until, index) => tableCell(line, boundaries[index] + 1, until));
}

export function markdownTableStart(lines: string[], index: number) {
  if (!lines[index + 1]?.includes('|') || !lines[index].includes('|')) return null;
  const headers = tableCells(lines[index]);
  const separators = tableCells(lines[index + 1]);
  if (!headers.length || headers.length !== separators.length || separators.some(cell => !/^:?-+:?$/.test(cell.text))) return null;
  return headers;
}

export function hasFocusLogTable(content: string): boolean {
  const lines = content.split(/\r\n?|\n/);
  let fenced = false;
  return lines.some((line, index) => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced || /^\s*[>#]/.test(line)) return false;
    const headers = markdownTableStart(lines, index)?.map(cell => cell.text.toLocaleLowerCase('de-DE'));
    return headers?.includes('ergebnis') && headers.includes('nächster schritt');
  });
}
