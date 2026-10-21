import { useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { Card } from './Card.tsx';
import { FolderGroup } from './FolderGroup.tsx';
import { ACCENT, cx } from '../lib/ui.ts';
import type { Collapsed } from '../lib/useCollapsed.ts';
import { effectiveFolder, type ColumnMeta, type Folder, type Task } from '../lib/types.ts';

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
  onOpen: (task: Task) => void;
  onCreate?: (title: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${meta.id}`, data: { column: meta.id } });
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');
  const accent = ACCENT[meta.id];

  // `tasks` already arrives in lane order: unfiled first, then folder by folder
  const unfiled = tasks.filter((t) => !effectiveFolder(t, folders));
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
    />
  );

  const submit = () => {
    const title = draft.trim();
    if (title && onCreate) onCreate(title);
    setDraft('');
    setComposing(false);
  };

  return (
    <section className="pk-lane flex h-full w-[300px] shrink-0 flex-col rounded-2xl">
      <header className="px-3.5 pt-3.5 pb-2.5">
        <div className="flex items-center gap-2">
          <span className={cx('size-2 rounded-[3px]', accent.dot)} />
          <h2 className="text-[13.5px] font-semibold tracking-[-0.01em] text-zinc-100">{meta.label}</h2>
          <span className={cx('pk-num rounded-md px-1.5 py-px font-mono text-[10.5px] font-medium', accent.soft, accent.text)}>
            {tasks.length}
          </span>
          {groups.length > 0 && collapsed && (
            <button
              onClick={() => collapsed.setAll(meta.id, groups.map((g) => g.folder.id), !allCollapsed)}
              className="ml-auto rounded px-1 text-[10.5px] text-zinc-600 hover:text-zinc-300"
              title={allCollapsed ? 'Open every folder in this lane' : 'Collapse every folder in this lane'}
            >
              {allCollapsed ? 'Expand all' : 'Collapse all'}
            </button>
          )}
        </div>
        <p className="mt-1 h-7 text-[11px] leading-snug text-zinc-500">{meta.hint}</p>
        <div className="mt-2 h-px bg-white/[0.05]">
          <div className={cx('h-px w-10 rounded-full', accent.bar)} />
        </div>
      </header>

      <div
        ref={setNodeRef}
        className={cx(
          'mx-1.5 mb-1.5 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-xl p-1.5 transition-colors duration-200',
          isOver ? 'bg-sky-400/[0.05] outline outline-dashed outline-sky-400/40' : 'bg-transparent',
        )}
      >
        {unfiled.map(card)}

        {groups.map(({ folder, tasks: inFolder }) => (
          <FolderGroup
            key={folder.id}
            folder={folder}
            column={meta.id}
            tasks={inFolder}
            collapsed={collapsed?.isCollapsed(meta.id, folder.id) ?? false}
            onToggle={() => collapsed?.toggle(meta.id, folder.id)}
            insertBefore={overFolderId === folder.id}
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
            <span className="text-[11.5px] text-zinc-600">Nothing here yet</span>
          </div>
        )}
      </div>
    </section>
  );
}
