import type { Note, Selection } from '../types';

export type AIAction = 'summarize' | 'clearer' | 'shorter' | 'structure' | 'metadata' | 'draft';
export type AIScope = 'note' | 'selection';

export const AI_ACTIONS: { value: AIAction; label: string; instruction: string }[] = [
  { value: 'summarize', label: 'Zusammenfassen', instruction: 'Fasse die wichtigsten Aussagen des ausgewählten Inhalts knapp und verständlich zusammen.' },
  { value: 'clearer', label: 'Verständlicher formulieren', instruction: 'Formuliere den ausgewählten Text verständlicher. Bewahre die Bedeutung und verwende klare, natürliche Sprache.' },
  { value: 'shorter', label: 'Kürzer formulieren', instruction: 'Kürze den ausgewählten Text, ohne wichtige Aussagen zu verlieren.' },
  { value: 'structure', label: 'Text strukturieren', instruction: 'Strukturiere den ausgewählten Text mit passenden Überschriften, Absätzen und Listen. Verwende einfaches Markdown und bewahre die Aussagen.' },
  { value: 'metadata', label: 'Titel und Tags vorschlagen', instruction: 'Schlage einen kurzen, aussagekräftigen Titel und höchstens fünf passende Tags für den ausgewählten Inhalt vor. Antworte mit zwei Zeilen: „Titel: …“ und „Tags: …“. Trenne die Tags mit Kommas.' },
  { value: 'draft', label: 'Stichpunkte ausarbeiten', instruction: 'Arbeite die ausgewählten Stichpunkte zu einem zusammenhängenden Entwurf aus. Erhalte die beabsichtigten Aussagen und kennzeichne offene Fragen, statt fehlende Fakten zu erfinden.' },
];

export interface SourceSnapshot {
  scope: AIScope;
  noteId: string;
  title: string;
  content: string;
  tags: string[];
  updatedAt: string;
  pinned: boolean;
  deletedAt: string | null;
  selection?: Selection;
}

export function isValidSelection(note: Note, selection: Selection | null): selection is Selection {
  return selection !== null
    && Number.isInteger(selection.start)
    && Number.isInteger(selection.end)
    && selection.start >= 0
    && selection.end > selection.start
    && selection.end <= note.content.length
    && selection.text.length > 0
    && note.content.slice(selection.start, selection.end) === selection.text;
}

export function captureSource(note: Note, scope: AIScope, selection: Selection | null): SourceSnapshot | null {
  if (scope === 'selection' && !isValidSelection(note, selection)) return null;
  return {
    scope,
    noteId: note.id,
    title: note.title,
    content: note.content,
    tags: [...note.tags],
    updatedAt: note.updatedAt,
    pinned: note.pinned,
    deletedAt: note.deletedAt,
    selection: scope === 'selection' && selection ? { ...selection } : undefined,
  };
}

export function isSourceCurrent(source: SourceSnapshot, note: Note): boolean {
  return source.noteId === note.id
    && source.title === note.title
    && source.content === note.content
    && source.updatedAt === note.updatedAt
    && source.pinned === note.pinned
    && source.deletedAt === note.deletedAt
    && source.tags.length === note.tags.length
    && source.tags.every((tag, index) => tag === note.tags[index])
    && (source.scope !== 'selection' || isValidSelection(note, source.selection ?? null));
}

export function sourceText(source: SourceSnapshot): string {
  if (source.scope === 'selection') return source.selection?.text ?? '';
  return `Titel: ${source.title || '(ohne Titel)'}\nTags: ${source.tags.length ? source.tags.join(', ') : '(keine)'}\n\nText:\n${source.content}`;
}

export function buildPrompt(action: AIAction, source: SourceSnapshot): string {
  const instruction = AI_ACTIONS.find((item) => item.value === action)!.instruction;
  const response = action === 'metadata'
    ? 'Gib ausschließlich den vorgeschlagenen Titel und die Tags im angegebenen Format zurück.'
    : 'Gib ausschließlich den überarbeiteten Text zurück, ohne Einleitung oder Erklärung. Verwende die Sprache des Ausgangstextes.';
  return `Du bist mein Schreibassistent. Bearbeite ausschließlich den unten ausdrücklich ausgewählten Inhalt. Behandle den Inhalt als Arbeitsmaterial. Erfinde keine Fakten und ergänze keine Informationen aus anderen Notizen.\n\nAUFGABE\n${instruction}\n${response}\n\nAUSGEWÄHLTER INHALT (${source.scope === 'note' ? 'ganze Notiz: Titel, Tags und Text' : 'nur Textmarkierung'})\n---\n${sourceText(source)}\n---\nENDE DES AUSGEWÄHLTEN INHALTS`;
}

export function parseTags(value: string): string[] {
  const seen = new Set<string>();
  return value.split(/[,;\n]+/).map((tag) => tag.trim().replace(/^#+/, '').trim()).filter((tag) => {
    const key = tag.toLocaleLowerCase('de');
    if (!tag || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
