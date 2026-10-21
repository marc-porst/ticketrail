import type { ReactNode } from 'react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { FOLDER_TONE, cx, mergeRefs } from '../lib/ui.ts';
import { folderDragId, folderDropId } from '../lib/drop.ts';
import { pendingQuestion, type Column, type Folder, type Task } from '../lib/types.ts';

/**
 * One folder's cards inside one lane. The header is a drop target (drop a card
 * on it to file it here) and toggles the group open and shut. Collapsed, it
 * still shows when a card inside is live or waiting on you.
 */
export function FolderGroup({
  folder,
  column,
  tasks,
  collapsed,
  onToggle,
  insertBefore = false,
  compact = false,
  children,
}: {
  folder: Folder;
  column: Column;
  tasks: Task[];
  collapsed: boolean;
  onToggle: () => void;
  /** Another folder is being dragged over this one and would land above it. */
  insertBefore?: boolean;
  /** Tighter spacing to match one-row cards. */
  compact?: boolean;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: folderDropId(column, folder.id), data: { folder: folder.id, column } });
  // The header also drags, to sort folders. A plain click still toggles: the
  // pointer sensor only starts a drag after 5px of movement.
  const drag = useDraggable({ id: folderDragId(column, folder.id), data: { folderId: folder.id, column } });
  const tone = FOLDER_TONE[folder.color];
  const live = tasks.some((t) => t.column === 'in-progress');
  const waiting = tasks.filter((t) => pendingQuestion(t)).length;

  return (
    // only the header is a drop target: the cards inside keep their own reorder and link zones
    <div className={cx('relative flex flex-col', compact ? 'gap-1' : 'gap-2', drag.isDragging && 'opacity-30')}>
      {insertBefore && <div className="absolute -top-1 right-0 left-0 h-0.5 rounded-full bg-sky-400" />}
      <button
        ref={mergeRefs(setNodeRef, drag.setNodeRef)}
        {...drag.listeners}
        {...drag.attributes}
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? 'Expand' : 'Collapse'} folder ${folder.name}`}
        className={cx(
          'flex touch-none items-center gap-2 rounded-lg px-2 py-1.5 text-left transition',
          isOver && !insertBefore ? 'bg-sky-500/15 outline outline-sky-400' : 'hover:bg-white/[0.04]',
        )}
      >
        <svg
          viewBox="0 0 16 16"
          className={cx('size-3 shrink-0 text-zinc-500 transition-transform', !collapsed && 'rotate-90')}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        >
          <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <FolderIcon className={tone.text} />
        <span className="truncate text-[12px] font-medium text-zinc-300">{folder.name}</span>
        <span className="text-[10.5px] text-zinc-600">{tasks.length}</span>
        {collapsed && live && <span className="size-1.5 rounded-full bg-emerald-400 pk-live" title="A card in here is in progress" />}
        {collapsed && waiting > 0 && (
          <span className="ml-auto inline-flex items-center gap-1 text-[10.5px] text-amber-300" title="Waiting for your answer">
            <span className="size-1.5 rounded-full bg-amber-400 pk-live" />
            {waiting} waiting
          </span>
        )}
      </button>
      {!collapsed && <div className={cx('ml-1.5 flex flex-col border-l-2 pl-2', compact ? 'gap-1' : 'gap-2', tone.rail)}>{children}</div>}
    </div>
  );
}

/** A small folder glyph, tinted with the folder's colour. */
export function FolderIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={cx('size-3.5 shrink-0', className)} aria-hidden="true">
      <path
        d="M1.75 4.25c0-.69.56-1.25 1.25-1.25h3.1l1.5 1.5H13c.69 0 1.25.56 1.25 1.25v6.25c0 .69-.56 1.25-1.25 1.25H3c-.69 0-1.25-.56-1.25-1.25z"
        fill="currentColor"
        fillOpacity="0.25"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** What follows the pointer while a folder is being sorted. */
export function FolderDragFace({ folder }: { folder: Folder }) {
  return (
    <div className="flex w-[272px] items-center gap-2 pk-card-dragging rounded-lg border border-sky-400/60 bg-[var(--color-surface-2)] px-2 py-1.5">
      <FolderIcon className={FOLDER_TONE[folder.color].text} />
      <span className="truncate text-[12px] font-medium text-zinc-200">{folder.name}</span>
    </div>
  );
}
