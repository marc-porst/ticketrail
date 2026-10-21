import { useEffect, useState } from 'react';
import { FOLDER_TONE, cx } from '../lib/ui.ts';
import { FolderIcon } from './FolderGroup.tsx';
import { FOLDER_COLORS, MAX_FOLDER_NAME, type Folder, type FolderColor, type Task } from '../lib/types.ts';

/**
 * Create, rename, recolour, reorder and delete folders. Folders are optional:
 * a board with none simply has an empty list here.
 */
export function FoldersModal({
  folders,
  tasks,
  onClose,
  onCreate,
  onUpdate,
  onDelete,
}: {
  folders: Folder[];
  tasks: Task[];
  onClose: () => void;
  onCreate: (name: string) => Promise<unknown>;
  onUpdate: (
    id: string,
    changes: Partial<{ name: string; color: FolderColor; before: string | null; after: string | null }>,
  ) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const add = async () => {
    const name = draft.trim();
    if (!name) return;
    await onCreate(name);
    setDraft('');
  };

  /** Swap with the neighbour: land between the neighbour and the one beyond it. */
  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= folders.length) return;
    const beyond = folders[target + delta];
    const before = delta === -1 ? (beyond?.order ?? null) : folders[target].order;
    const after = delta === -1 ? folders[target].order : (beyond?.order ?? null);
    void onUpdate(folders[index].id, { before, after });
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-6" role="dialog" aria-modal="true" aria-label="Folders">
      <div className="pk-scrim absolute inset-0" onClick={onClose} />

      <div className="relative flex max-h-full w-full max-w-[480px] flex-col overflow-hidden rounded-2xl border border-white/[0.07] bg-[var(--color-surface-1)] pk-panel">
        <header className="flex items-baseline gap-3 border-b border-[var(--color-line)] px-5 py-4">
          <h2 className="text-[15px] font-semibold tracking-tight text-zinc-100">Folders</h2>
          <p className="text-[11px] text-zinc-600">Optional groups, shown in every lane</p>
          <button onClick={onClose} className="ml-auto rounded-md p-1 text-zinc-500 hover:bg-white/5 hover:text-zinc-200" aria-label="Close">
            <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <ul className="min-h-0 flex-1 divide-y divide-[var(--color-line)] overflow-y-auto">
          {folders.map((folder, i) => {
            const count = tasks.filter((t) => t.folder === folder.id).length;
            return (
              <li key={folder.id} className="flex flex-col gap-2 px-5 py-3">
                <div className="flex items-center gap-2">
                  <FolderIcon className={FOLDER_TONE[folder.color].text} />
                  <input
                    key={folder.name}
                    defaultValue={folder.name}
                    maxLength={MAX_FOLDER_NAME}
                    aria-label={`Name of folder ${folder.name}`}
                    onBlur={(e) => {
                      const name = e.target.value.trim();
                      if (name && name !== folder.name) void onUpdate(folder.id, { name });
                      else e.target.value = folder.name;
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                    className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[13px] text-zinc-100 hover:border-[var(--color-line)] focus:border-sky-500 focus:outline-none"
                  />
                  <span className="shrink-0 text-[11px] text-zinc-600">
                    {count} card{count === 1 ? '' : 's'}
                  </span>
                  <button
                    onClick={() => move(i, -1)}
                    disabled={i === 0}
                    className="rounded p-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-30"
                    aria-label={`Move ${folder.name} up`}
                  >
                    ↑
                  </button>
                  <button
                    onClick={() => move(i, 1)}
                    disabled={i === folders.length - 1}
                    className="rounded p-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-30"
                    aria-label={`Move ${folder.name} down`}
                  >
                    ↓
                  </button>
                  <button
                    onClick={() => setDeleting(folder.id)}
                    className="rounded px-1.5 py-1 text-[11.5px] text-zinc-600 hover:text-red-400"
                  >
                    Delete
                  </button>
                </div>

                <div className="flex items-center gap-1.5 pl-1.5">
                  {FOLDER_COLORS.map((color) => (
                    <button
                      key={color}
                      onClick={() => color !== folder.color && void onUpdate(folder.id, { color })}
                      aria-label={`Colour ${color}`}
                      aria-pressed={color === folder.color}
                      className={cx(
                        'size-3.5 rounded-sm transition',
                        FOLDER_TONE[color].dot,
                        color === folder.color ? 'ring-2 ring-white/70 ring-offset-1 ring-offset-[var(--color-surface-1)]' : 'opacity-50 hover:opacity-100',
                      )}
                    />
                  ))}
                </div>

                {deleting === folder.id && (
                  <div className="flex items-center gap-2 rounded-md bg-red-950/40 px-2.5 py-2 text-[12px] text-red-200">
                    <span className="flex-1">
                      Delete “{folder.name}”? {count ? `Its ${count} card${count === 1 ? '' : 's'} stay on the board, unfiled.` : 'It holds no cards.'}
                    </span>
                    <button
                      onClick={() => {
                        setDeleting(null);
                        void onDelete(folder.id);
                      }}
                      className="rounded bg-red-500/80 px-2 py-0.5 font-medium text-white hover:bg-red-500"
                    >
                      Delete
                    </button>
                    <button onClick={() => setDeleting(null)} className="text-red-300 hover:text-red-100">
                      Cancel
                    </button>
                  </div>
                )}
              </li>
            );
          })}
          {folders.length === 0 && (
            <li className="px-5 py-6 text-center text-[12px] leading-relaxed text-zinc-600">
              No folders yet. Cards work fine without them. Add one to group related cards; each lane can collapse
              it.
            </li>
          )}
        </ul>

        <form
          className="flex gap-2 border-t border-[var(--color-line)] px-5 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input
            value={draft}
            maxLength={MAX_FOLDER_NAME}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="New folder name"
            aria-label="New folder name"
            className="min-w-0 flex-1 rounded-md border border-[var(--color-line)] bg-transparent px-2.5 py-1.5 text-[12.5px] text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!draft.trim()}
            className="rounded-md bg-sky-500 px-3 py-1.5 text-[12px] font-medium text-sky-950 hover:bg-sky-400 disabled:opacity-40"
          >
            Add folder
          </button>
        </form>
      </div>
    </div>
  );
}
