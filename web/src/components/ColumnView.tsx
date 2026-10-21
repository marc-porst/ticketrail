import { useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { Card } from './Card.tsx';
import { FolderGroup } from './FolderGroup.tsx';
import { ACCENT, cx } from '../lib/ui.ts';
import type { Collapsed } from '../lib/useCollapsed.ts';
import { effectiveFolder, pendingQuestion, type ColumnMeta, type Folder, type Task } from '../lib/types.ts';

export function ColumnView({
  meta,
  tasks,
  overCardId,
  overZone = 'before',
  draggingId = null,
  backlinks,
  folders = [],
  collapsed,
  overFolderId = null,
  compact = false,
  limit,
  onOpen,
  onCreate,
}: {
  meta: ColumnMeta;
  tasks: Task[];
  overCardId: string | null;
  /** Whether a drop on overCardId reorders above it or links to it. */
  overZone?: 'before' | 'link';
  draggingId?: string | null;
  /** Card id → how many cards link it as related. */
  backlinks?: Map<string, number>;
  /** The board's folders. With none, the lane is a flat list exactly as before. */
  folders?: Folder[];
  collapsed?: Collapsed;
  /** While a folder is dragged: the folder in this lane it would land above. */
  overFolderId?: string | null;
  /** One-row cards and a slimmer lane header, so long lanes need less scrolling. */
  compact?: boolean;
  /** Show only this many unfiled cards until the rest are asked for (the Done lane). */
  limit?: number;
  onOpen: (task: Task) => void;
  onCreate?: (title: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${meta.id}`, data: { column: meta.id } });
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');
  const [showAll, setShowAll] = useState(false);
  const accent = ACCENT[meta.id];

  // `tasks` already arrives in lane order: unfiled first, then folder by folder
  const unfiled = tasks.filter((t) => !effectiveFolder(t, folders));
  const folded = limit !== undefined && !showAll ? Math.max(0, unfiled.length - limit) : 0;
  const shown = folded ? unfiled.slice(0, limit) : unfiled;
  const groups = folders
    .map((folder) => ({ folder, tasks: tasks.filter((t) => t.folder === folder.id) }))
    .filter((g) => g.tasks.length > 0);
  const allCollapsed = groups.length > 0 && groups.every((g) => collapsed?.isCollapsed(meta.id, g.folder.id));

  const card = (task: Task) => (
    <Card
      key={task.id}
      task={task}
      onOpen={onOpen}
      insertBefore={overCardId === task.id && overZone === 'before'}
      linkTarget={overCardId === task.id && overZone === 'link' && draggingId !== task.id}
      referencedBy={backlinks?.get(task.id)}
      compact={compact}
    />
  );

  const submit = () => {
    const title = draft.trim();
    if (title && onCreate) onCreate(title);
    setDraft('');
    setComposing(false);
  };

  const laneFolded = collapsed?.isLaneFolded(meta.id) ?? false;
  const empty = !tasks.length && !onCreate;
  const foldButton = collapsed && (
    <button
      onClick={() => collapsed.toggleLane(meta.id)}
      className="pk-press shrink-0 rounded-md p-1 text-zinc-600 hover:bg-white/[0.06] hover:text-zinc-200"
      aria-label={`${laneFolded ? 'Expand' : 'Fold'} lane ${meta.label}`}
      title={laneFolded ? `Expand ${meta.label}` : `Fold ${meta.label} to a narrow rail`}
    >
      <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <path d={laneFolded ? 'M6 4l4 4-4 4' : 'M10 4L6 8l4 4'} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );

  // Folded: a narrow rail that still takes drops and still shows what needs you.
  if (laneFolded) {
    const live = tasks.some((t) => t.column === 'in-progress');
    const waiting = tasks.filter((t) => pendingQuestion(t)).length;
    return (
      <section
        ref={setNodeRef}
        className={cx(
          'pk-lane flex h-full w-11 shrink-0 flex-col items-center gap-2.5 rounded-2xl py-2.5 transition-colors duration-200',
          isOver && 'bg-sky-400/[0.08] outline outline-dashed outline-sky-400/50',
        )}
      >
        {foldButton}
        <span className={cx('size-2 rounded-[3px]', accent.dot)} />
        <span className={cx('pk-num rounded-md px-1 py-px font-mono text-[10.5px] font-medium', accent.soft, accent.text)}>
          {tasks.length}
        </span>
        {live && <span className="pk-ping size-1.5 rounded-full bg-emerald-400" title="A card here is in progress" />}
        {waiting > 0 && (
          <span className="size-1.5 rounded-full bg-amber-400 pk-live" title={`${waiting} waiting on you`} />
        )}
        <button
          onClick={() => collapsed?.toggleLane(meta.id)}
          className="flex-1 text-[12.5px] font-semibold tracking-[-0.01em] text-zinc-300 [writing-mode:vertical-rl] hover:text-zinc-100"
          title={`${meta.label}: ${meta.hint}`}
        >
          {meta.label}
        </button>
      </section>
    );
  }

  return (
    <section
      className={cx(
        'pk-lane flex h-full max-w-[380px] basis-0 flex-col rounded-2xl transition-[flex-grow,min-width] duration-300',
        // an empty lane only needs to be a drop target: it gives its width to the lanes with cards
        empty ? 'min-w-[136px] grow-[0.55]' : 'min-w-[208px] grow',
      )}
    >
      <header className={cx('px-3.5', compact ? 'pt-3 pb-2' : 'pt-3.5 pb-2.5')} title={compact ? meta.hint : undefined}>
        <div className="flex items-center gap-2">
          <span className={cx('size-2 rounded-[3px]', accent.dot)} />
          <h2 className="truncate text-[13.5px] font-semibold tracking-[-0.01em] text-zinc-100">{meta.label}</h2>
          {!empty && (
            <span className={cx('pk-num rounded-md px-1.5 py-px font-mono text-[10.5px] font-medium', accent.soft, accent.text)}>
              {tasks.length}
            </span>
          )}
          <span className="ml-auto flex items-center gap-1">
            {groups.length > 0 && collapsed && (
              <button
                onClick={() => collapsed.setAll(meta.id, groups.map((g) => g.folder.id), !allCollapsed)}
                className="rounded px-1 text-[10.5px] text-zinc-600 hover:text-zinc-300"
                title={allCollapsed ? 'Open every folder in this lane' : 'Collapse every folder in this lane'}
              >
                {allCollapsed ? 'Expand all' : 'Collapse all'}
              </button>
            )}
            {/* an empty lane is already narrow: its width goes to the name */}
            {!empty && foldButton}
          </span>
        </div>
        {!compact && !empty && <p className="mt-1 line-clamp-2 h-7 text-[11px] leading-snug text-zinc-500">{meta.hint}</p>}
        <div className="mt-2 h-px bg-white/[0.05]">
          <div className={cx('h-px w-10 rounded-full', accent.bar)} />
        </div>
      </header>

      <div
        ref={setNodeRef}
        className={cx(
          'mx-1.5 mb-1.5 flex min-h-0 flex-1 flex-col overflow-y-auto rounded-xl p-1.5 transition-colors duration-200',
          compact ? 'gap-1' : 'gap-2',
          isOver ? 'bg-sky-400/[0.05] outline outline-dashed outline-sky-400/40' : 'bg-transparent',
        )}
      >
        {shown.map(card)}

        {limit !== undefined && unfiled.length > limit && (
          <button
            onClick={() => setShowAll((v) => !v)}
            className="pk-press rounded-lg py-1.5 text-[11.5px] text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-200"
            aria-expanded={showAll}
          >
            {showAll ? 'Show fewer' : `Show ${folded} older ${folded === 1 ? 'card' : 'cards'}`}
          </button>
        )}

        {groups.map(({ folder, tasks: inFolder }) => (
          <FolderGroup
            key={folder.id}
            folder={folder}
            column={meta.id}
            tasks={inFolder}
            collapsed={collapsed?.isCollapsed(meta.id, folder.id) ?? false}
            onToggle={() => collapsed?.toggle(meta.id, folder.id)}
            insertBefore={overFolderId === folder.id}
            compact={compact}
          >
            {inFolder.map(card)}
          </FolderGroup>
        ))}

        {onCreate &&
          (composing ? (
            <div className="pk-rise rounded-[10px] border border-sky-400/30 bg-[var(--color-surface-2)] p-2.5 shadow-[var(--pk-shadow-lift)]">
              <textarea
                autoFocus
                rows={2}
                value={draft}
                placeholder="What should Claude build?"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                  if (e.key === 'Escape') setComposing(false);
                }}
                className="w-full resize-none bg-transparent text-[13px] text-zinc-100 outline-none placeholder:text-zinc-600"
              />
              <div className="mt-1.5 flex items-center gap-2">
                <button
                  onClick={submit}
                  className="pk-press rounded-md bg-sky-400 px-2.5 py-1 text-[11.5px] font-semibold text-sky-950 hover:bg-sky-300"
                >
                  Add card
                </button>
                <button onClick={() => setComposing(false)} className="rounded px-1 text-[11.5px] text-zinc-500 hover:text-zinc-300">
                  Cancel
                </button>
                <span className="ml-auto font-mono text-[10px] text-zinc-600">↵ to add</span>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setComposing(true)}
              className="pk-press rounded-[10px] border border-dashed border-white/[0.08] py-2 text-[12px] text-zinc-500 hover:border-sky-400/40 hover:bg-sky-400/[0.04] hover:text-sky-200"
            >
              + Add a card
            </button>
          ))}

        {!tasks.length && !onCreate && (
          <div className="flex flex-col items-center gap-1.5 rounded-[10px] border border-dashed border-white/[0.06] px-4 py-7 text-center">
            <span className={cx('size-1.5 rounded-full opacity-60', accent.dot)} />
            <span className="text-[11.5px] leading-snug text-zinc-600 [text-wrap:balance]">{meta.hint}</span>
          </div>
        )}
      </div>
    </section>
  );
}
