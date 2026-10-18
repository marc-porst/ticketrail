import type { Task } from './task.ts';

/**
 * Folders group cards across the whole board. A card keeps its folder as it
 * moves between lanes; each lane draws the folder as a group holding only its
 * own cards. Folders are optional -- a board without any looks exactly as it
 * did before they existed.
 */
export const FOLDER_COLORS = ['slate', 'rose', 'amber', 'lime', 'emerald', 'sky', 'violet', 'fuchsia'] as const;

export type FolderColor = (typeof FOLDER_COLORS)[number];

export const MAX_FOLDER_NAME = 48;

export interface Folder {
  id: string;
  name: string;
  color: FolderColor;
  /** Fractional key: the order groups appear in, in every lane. */
  order: string;
  createdAt: string;
}

export function isFolderColor(value: unknown): value is FolderColor {
  return typeof value === 'string' && (FOLDER_COLORS as readonly string[]).includes(value);
}

export function cleanFolderName(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, MAX_FOLDER_NAME) : '';
}

/** Tolerant reader for folders.json: `{ folders: [...] }` or a bare array. */
export function normalizeFolders(raw: any): Folder[] {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.folders) ? raw.folders : [];
  const out: Folder[] = [];
  for (const f of list) {
    const name = cleanFolderName(f?.name);
    if (typeof f?.id !== 'string' || !name || out.some((o) => o.id === f.id)) continue;
    out.push({
      id: f.id,
      name,
      color: isFolderColor(f?.color) ? f.color : 'slate',
      order: typeof f?.order === 'string' && f.order ? f.order : 'n',
      createdAt: typeof f?.createdAt === 'string' ? f.createdAt : new Date(0).toISOString(),
    });
  }
  return out.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.createdAt < b.createdAt ? -1 : 1));
}

/** The folder a card is shown in: its own, unless that folder no longer exists. */
export function effectiveFolder(task: Pick<Task, 'folder'>, folders: readonly Folder[]): string | null {
  return task.folder && folders.some((f) => f.id === task.folder) ? task.folder : null;
}

/**
 * The order a lane shows its cards in, and therefore the order Claude claims
 * them in: unfiled cards first, then each folder in folder order, each by its
 * fractional key. One function for both so "top card first" means the card at
 * the top of the screen.
 */
export function laneOrder<T extends Pick<Task, 'folder' | 'order' | 'number'>>(tasks: T[], folders: readonly Folder[]): T[] {
  const rank = new Map(folders.map((f, i) => [f.id, i]));
  const group = (t: T) => (t.folder && rank.has(t.folder) ? rank.get(t.folder)! : -1);
  return [...tasks].sort((a, b) => {
    const ga = group(a);
    const gb = group(b);
    if (ga !== gb) return ga - gb;
    if (a.order !== b.order) return a.order < b.order ? -1 : 1;
    return a.number - b.number;
  });
}
