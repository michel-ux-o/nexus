export interface NoteRevision { id: string; createdAt: string; title: string; content: string; tags: string[]; }
export interface Note { id: string; title: string; content: string; tags: string[]; pinned: boolean; createdAt: string; updatedAt: string; deletedAt: string | null; revisions: NoteRevision[]; }
export interface Backup { format: 'nexus-notes'; version: 1; exportedAt: string; notes: Note[]; }
export type SaveStatus = 'saving' | 'saved' | 'error';
export type NotePatch = Partial<Pick<Note, 'title' | 'content' | 'tags' | 'pinned' | 'deletedAt' | 'revisions'>>;
export interface Selection { start: number; end: number; text: string; }
export type ImportMode = 'merge' | 'replace';
