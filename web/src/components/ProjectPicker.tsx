import { useEffect, useRef, useState } from 'react';
import { cx } from '../lib/ui.ts';
import type { ProjectView } from '../lib/api.ts';
import { hasWorker } from '../lib/workers.ts';
import { ProjectStatus } from './ProjectStatus.tsx';

export function ProjectPicker({
  projects,
  current,
  onSelect,
  onConfigure,
}: {
  projects: ProjectView[];
  current: ProjectView | null;
  onSelect: (id: string) => void;
  onConfigure: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onClick = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  // Somewhere else needing attention is worth a mark on the closed button.
  const elsewhereBlocked = projects.some((p) => p.id !== current?.id && p.summary.blocked > 0);

  return (
    <div ref={box} className="relative min-w-0">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex min-w-0 items-baseline gap-2.5 rounded-md px-1.5 py-1 text-left transition hover:bg-white/5"
      >
        <span className="truncate text-[15px] font-semibold tracking-tight text-zinc-100">
          {current?.name ?? 'Loading…'}
        </span>
        {current?.shortPath && (
          <span className="hidden truncate text-[11.5px] text-zinc-600 sm:inline" title={current.path}>
            {current.shortPath}
          </span>
        )}
        {elsewhereBlocked && <span className="size-1.5 shrink-0 rounded-full bg-amber-400" title="Another project is waiting on you" />}
        <svg viewBox="0 0 16 16" className="size-3 shrink-0 text-zinc-500" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M4 6.5l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute top-full left-0 z-50 mt-1.5 w-[380px] overflow-hidden rounded-xl border border-white/[0.08] bg-[var(--color-surface-2)] pk-panel"
        >
          <ul className="max-h-[60vh] overflow-y-auto py-1">
            {projects.map((project) => {
              const active = project.id === current?.id;
              const worker = hasWorker(project.workers, project.summary.inProgress);

              return (
                <li key={project.id}>
                  <button
                    role="option"
                    aria-selected={active}
                    disabled={project.missing}
                    onClick={() => {
                      onSelect(project.id);
                      setOpen(false);
                    }}
                    className={cx(
                      'flex w-full items-center gap-3 px-3 py-2 text-left transition',
                      project.missing ? 'cursor-not-allowed opacity-40' : 'hover:bg-white/5',
                    )}
                  >
                    <span className={cx('size-1.5 shrink-0 rounded-full', active ? 'bg-sky-400' : 'bg-transparent')} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-zinc-100">{project.name}</span>
                      <span className="block truncate text-[11px] text-zinc-600">
                        {project.missing ? 'missing — folder is gone' : project.shortPath}
                      </span>
                    </span>
                    {!project.missing && (
                      <span
                        className={cx('size-1.5 shrink-0 rounded-full', worker ? 'bg-emerald-400' : 'bg-red-500')}
                        title={worker ? 'A worker is on this board' : 'No worker on this board'}
                        aria-label={worker ? 'worker running' : 'no worker'}
                      />
                    )}
                    <ProjectStatus summary={project.summary} />
                  </button>
                </li>
              );
            })}
          </ul>

          <button
            onClick={() => {
              setOpen(false);
              onConfigure();
            }}
            className="flex w-full items-center gap-2 border-t border-[var(--color-line)] px-3 py-2.5 text-left text-[11.5px] text-zinc-500 transition hover:bg-white/5 hover:text-zinc-200"
          >
            <svg viewBox="0 0 16 16" className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.4">
              <circle cx="8" cy="8" r="2.2" />
              <path d="M8 1.5v1.6M8 12.9v1.6M14.5 8h-1.6M3.1 8H1.5M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1M12.6 12.6l-1.1-1.1M4.5 4.5L3.4 3.4" strokeLinecap="round" />
            </svg>
            Configure spaces
          </button>
        </div>
      )}
    </div>
  );
}
