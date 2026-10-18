import { useCallback, useEffect, useState } from 'react';
import { browseForFolder, createProject, deleteProject, renameProject, type ProjectView } from '../lib/api.ts';
import { cx } from '../lib/ui.ts';
import { ProjectStatus } from './ProjectStatus.tsx';

export function SpacesModal({
  projects,
  currentId,
  defaultId,
  onClose,
  onChanged,
}: {
  projects: ProjectView[];
  currentId: string | null;
  defaultId: string | null;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState('');
  // Only a space added in this session gets its next step opened for it.
  const [added, setAdded] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const guard = useCallback(
    async <T,>(work: () => Promise<T>): Promise<T | null> => {
      setBusy(true);
      setError(null);
      try {
        return await work();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const add = useCallback(
    async (path: string) => {
      const result = await guard(() => createProject(path));
      if (!result) return;
      setAdded(result.project.id);
      setTyping(false);
      setTyped('');
      await onChanged();
    },
    [guard, onChanged],
  );

  const browse = useCallback(async () => {
    const result = await guard(() => browseForFolder());
    if (!result || result.cancelled || !result.path) return;
    await add(result.path);
  }, [guard, add]);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-6" role="dialog" aria-modal="true" aria-label="Configure spaces">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} />

      <div className="relative flex max-h-full w-full max-w-[560px] flex-col overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-1)] shadow-2xl shadow-black/60">
        <header className="flex items-baseline gap-3 border-b border-[var(--color-line)] px-5 py-4">
          <h2 className="text-[15px] font-semibold tracking-tight text-zinc-100">Configure spaces</h2>
          <p className="text-[11px] text-zinc-600">Every board this server can switch to</p>
          <button
            onClick={onClose}
            aria-label="Close"
            className="ml-auto rounded-md p-1 text-zinc-500 hover:bg-white/5 hover:text-zinc-200"
          >
            <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        {error && (
          <div className="flex items-start gap-3 border-b border-red-900/50 bg-red-950/40 px-5 py-2.5 text-[12px] leading-relaxed text-red-200">
            {error}
            <button onClick={() => setError(null)} className="ml-auto shrink-0 text-red-300 hover:text-red-100">
              dismiss
            </button>
          </div>
        )}

        <ul className="min-h-0 flex-1 divide-y divide-[var(--color-line)] overflow-y-auto">
          {projects.map((project) => (
            <SpaceRow
              key={project.id}
              project={project}
              isCurrent={project.id === currentId}
              isDefault={project.id === defaultId}
              showNextStep={project.id === added}
              onRename={async (title) => {
                await guard(() => renameProject(project.id, title));
                await onChanged();
              }}
              onRemove={async () => {
                await guard(() => deleteProject(project.id));
                await onChanged();
              }}
            />
          ))}
          {!projects.length && (
            <li className="px-5 py-8 text-center text-[12px] text-zinc-600">No spaces yet.</li>
          )}
        </ul>

        <footer className="border-t border-[var(--color-line)] px-5 py-3">
          {typing ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (typed.trim()) void add(typed.trim());
              }}
              className="flex items-center gap-2"
            >
              <input
                autoFocus
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && (setTyping(false), setTyped(''))}
                placeholder="~/code/my-project"
                className="min-w-0 flex-1 rounded-md border border-[var(--color-line)] bg-black/30 px-2.5 py-1.5 font-mono text-[12px] text-zinc-200 outline-none focus:border-sky-600"
              />
              <button
                type="submit"
                disabled={busy || !typed.trim()}
                className="shrink-0 rounded-md bg-sky-500 px-3 py-1.5 text-[12px] font-medium text-sky-950 hover:bg-sky-400 disabled:opacity-40"
              >
                Add
              </button>
              <button
                type="button"
                onClick={() => (setTyping(false), setTyped(''))}
                className="shrink-0 text-[11.5px] text-zinc-500 hover:text-zinc-300"
              >
                Cancel
              </button>
            </form>
          ) : (
            <div className="flex items-center gap-3">
              <button
                onClick={() => void browse()}
                disabled={busy}
                className="rounded-md bg-sky-500 px-3 py-1.5 text-[12px] font-medium text-sky-950 transition hover:bg-sky-400 disabled:opacity-40"
              >
                {busy ? 'Waiting for the folder picker…' : 'Add space'}
              </button>
              <button onClick={() => setTyping(true)} className="text-[11.5px] text-zinc-500 hover:text-zinc-300">
                or type a path
              </button>
              <p className="ml-auto text-right text-[10.5px] leading-snug text-zinc-600">
                The picker opens on the machine
                <br />
                running the board.
              </p>
            </div>
          )}
        </footer>
      </div>
    </div>
  );
}

function SpaceRow({
  project,
  isCurrent,
  isDefault,
  showNextStep,
  onRename,
  onRemove,
}: {
  project: ProjectView;
  isCurrent: boolean;
  isDefault: boolean;
  showNextStep: boolean;
  onRename: (title: string) => void;
  onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [openStep, setOpenStep] = useState(showNextStep);

  useEffect(() => {
    if (showNextStep) setOpenStep(true);
  }, [showNextStep]);

  return (
    <li className="px-5 py-3">
      <div className="flex items-center gap-3">
        <span className={cx('size-1.5 shrink-0 rounded-full', isCurrent ? 'bg-sky-400' : 'bg-transparent')} />

        <div className="min-w-0 flex-1">
          {project.missing ? (
            <span className="block truncate text-[13px] font-medium text-zinc-500">{project.name}</span>
          ) : (
            <EditableName value={project.name} onSave={onRename} />
          )}
          <span className="block truncate text-[11px] text-zinc-600" title={project.path}>
            {project.missing ? 'missing — folder is gone' : project.shortPath}
          </span>
        </div>

        <ProjectStatus summary={project.summary} />

        {!project.missing && (
          <button
            onClick={() => setOpenStep((v) => !v)}
            title="How to start a worker here"
            aria-label="How to start a worker here"
            className={cx(
              'shrink-0 rounded-md p-1.5 transition hover:bg-white/5',
              openStep ? 'text-zinc-300' : 'text-zinc-600 hover:text-zinc-300',
            )}
          >
            <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2" y="3" width="12" height="10" rx="2" />
              <path d="M5 7l1.8 1.5L5 10M9 10.2h2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}

        {isDefault ? (
          <span
            className="shrink-0 text-[10.5px] text-zinc-700"
            title="The board this server was started in — it re-registers itself on every start"
          >
            serving
          </span>
        ) : confirming ? (
          <span className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => {
                setConfirming(false);
                onRemove();
              }}
              className="rounded-md bg-red-500/15 px-2 py-1 text-[11px] font-medium text-red-300 hover:bg-red-500/25"
            >
              Remove
            </button>
            <button onClick={() => setConfirming(false)} className="text-[11px] text-zinc-500 hover:text-zinc-300">
              Cancel
            </button>
          </span>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            aria-label={`Remove ${project.name}`}
            title="Remove from this list"
            className="shrink-0 rounded-md p-1.5 text-zinc-600 transition hover:bg-red-500/10 hover:text-red-300"
          >
            <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8h5.8l.6-8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>

      {confirming && (
        <p className="mt-2 ml-4.5 text-[11px] leading-relaxed text-zinc-500">
          Removes it from this list only. Nothing on disk is touched — the folder and its board stay exactly as they
          are.
        </p>
      )}

      {openStep && !project.missing && <NextStep path={project.path} added={showNextStep} />}
    </li>
  );
}

/**
 * The one part of setting up a space the browser genuinely cannot do: a worker
 * needs a Claude Code session whose working directory is that project.
 */
function NextStep({ path, added }: { path: string; added: boolean }) {
  const [copied, setCopied] = useState(false);
  const command = `cd ${path} && claude`;

  return (
    <div className="mt-2 ml-4.5 rounded-lg border border-[var(--color-line)] bg-black/25 px-3 py-2.5">
      <p className="text-[11px] leading-relaxed text-zinc-500">
        {added ? 'Added. ' : ''}To let Claude work this board, start a session in that folder and run{' '}
        <code className="rounded bg-black/40 px-1 text-zinc-400">/ticketrail-work</code>:
      </p>
      <div className="mt-1.5 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-black/40 px-2 py-1 font-mono text-[11px] text-zinc-300">
          {command}
        </code>
        <button
          onClick={() => {
            void navigator.clipboard?.writeText(command).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="shrink-0 rounded-md px-2 py-1 text-[11px] text-zinc-500 transition hover:bg-white/5 hover:text-zinc-200"
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
    </div>
  );
}

function EditableName({ value, onSave }: { value: string; onSave: (title: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== value) onSave(next);
    else setDraft(value);
  };

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        title="Rename this space"
        className="block max-w-full truncate rounded text-left text-[13px] font-medium text-zinc-100 hover:text-white"
      >
        {value}
      </button>
    );
  }

  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          setDraft(value);
          setEditing(false);
        }
      }}
      aria-label="Space name"
      className="w-full rounded border border-sky-700 bg-black/30 px-1.5 py-0.5 text-[13px] font-medium text-zinc-100 outline-none"
    />
  );
}
