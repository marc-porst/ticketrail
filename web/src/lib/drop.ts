import { MAX_RELATED, effectiveFolder, laneOrder, type Column, type Folder, type Task } from './types.ts';

export interface Drop {
  column: Column;
  before: string | null;
  after: string | null;
  /** The folder the card ends up in. null = no folder. */
  folder: string | null;
}

/** Where on a card the pointer is: its top band reorders, the rest links. */
export type DropZone = 'before' | 'link';

/**
 * The top 35% of a card (never less than 12px) keeps the old "insert above"
 * behaviour; anywhere lower links the dragged card as related context.
 */
export function dropZone(pointerY: number, rect: { top: number; height: number }): DropZone {
  const band = Math.max(12, rect.height * 0.35);
  return pointerY - rect.top < band ? 'before' : 'link';
}

/**
 * The related list the drop target ends up with when `draggedId` is dropped on
 * it. Null when nothing would change: the card itself, already linked, or full.
 */
export function linkOnDrop(target: Task, draggedId: string): string[] | null {
  const related = target.related ?? [];
  if (target.id === draggedId || related.includes(draggedId) || related.length >= MAX_RELATED) return null;
  return [...related, draggedId];
}

export function byColumn(tasks: Task[], folders: readonly Folder[] = []): Map<Column, Task[]> {
  const map = new Map<Column, Task[]>();
  for (const task of tasks) {
    const list = map.get(task.column) ?? [];
    list.push(task);
    map.set(task.column, list);
  }
  for (const [column, list] of map) map.set(column, laneOrder(list, folders));
  return map;
}

/** Droppable id of a folder's header in one lane. */
export const folderDropId = (column: Column, folderId: string) => `folder:${column}:${folderId}`;

/**
 * Where a dragged card lands. Order keys only mean something inside one group
 * (unfiled, or one folder) of one lane, so every neighbour is looked up there.
 *
 * - on a card: insert above it, and take that card's folder
 * - on a folder header: the bottom of that folder, in that lane
 * - on the lane body: the bottom of the card's own group, keeping its folder
 *
 * Returns null when the drop would not move anything.
 */
export function resolveDrop(tasks: Task[], taskId: string, overId: string, folders: readonly Folder[] = []): Drop | null {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return null;
  const current = effectiveFolder(task, folders);
  const group = (column: Column, folder: string | null) =>
    laneOrder(
      tasks.filter((t) => t.id !== taskId && t.column === column && effectiveFolder(t, folders) === folder),
      folders,
    );

  const append = (column: Column, folder: string | null): Drop | null => {
    const siblings = group(column, folder);
    const before = siblings.length ? siblings[siblings.length - 1].order : null;
    // already the bottom card of that very group: nothing changes
    if (column === task.column && folder === current && (before === null || task.order > before)) return null;
    return { column, before, after: null, folder };
  };

  if (overId.startsWith('col:')) return append(overId.slice(4) as Column, current);

  if (overId.startsWith('folder:')) {
    const [, column, folderId] = overId.split(':');
    if (!folders.some((f) => f.id === folderId)) return null;
    return append(column as Column, folderId);
  }

  const target = tasks.find((t) => t.id === overId.replace(/^card:/, ''));
  if (!target || target.id === taskId) return null;

  const folder = effectiveFolder(target, folders);
  const siblings = group(target.column, folder);
  const index = siblings.findIndex((t) => t.id === target.id);
  const before = index > 0 ? siblings[index - 1].order : null;
  return { column: target.column, before, after: target.order, folder };
}

/** Draggable id of a folder header, so folders can be sorted by dragging. */
export const folderDragId = (column: Column, folderId: string) => `folderdrag:${column}:${folderId}`;

/**
 * Where a dragged folder lands in the board-wide folder order. `above` is the
 * folder it was dropped on (it goes above that one); null puts it last.
 * Returns the neighbouring keys, or null when nothing would change.
 */
export function resolveFolderDrop(
  folders: readonly Folder[],
  draggedId: string,
  above: string | null,
): { before: string | null; after: string | null } | null {
  const from = folders.findIndex((f) => f.id === draggedId);
  if (from < 0 || above === draggedId) return null;
  const rest = folders.filter((f) => f.id !== draggedId);
  const to = above === null ? rest.length : rest.findIndex((f) => f.id === above);
  if (to < 0 || to === from) return null;
  return { before: to > 0 ? rest[to - 1].order : null, after: to < rest.length ? rest[to].order : null };
}
