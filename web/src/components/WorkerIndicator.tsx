import { useEffect, useRef, useState } from 'react';
import { cx, relativeTime } from '../lib/ui.ts';
import { describeIndicator, type IndicatorTone } from '../lib/workers.ts';
import type { Connection } from '../lib/useBoard.ts';
import type { Task, WorkerPresence } from '../lib/types.ts';

const DOT: Record<IndicatorTone, string> = {
  green: 'bg-emerald-400',
  amber: 'bg-amber-400',
  red: 'bg-red-500',
  grey: 'bg-zinc-600',
};

/**
 * The header dot: is the board server up, and is a worker actually on it.
 * Click it for who: the workers waiting (with their name and filter) and the
 * cards being worked right now.
 */
export function WorkerIndicator({
  connection,
  workers,
  tasks,
  onOpenCard,
}: {
  connection: Connection;
  workers: WorkerPresence | undefined;
  tasks: Task[];
  onOpenCard?: (id: string) => void;
}) {
  // the grace windows run out without any event arriving, so re-check on a clock
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const indicator = describeIndicator(connection, workers, tasks, now);
  const waiting = workers?.workers ?? [];
  const running = tasks.filter((t) => t.column === 'in-progress');

  return (
    <span ref={box} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Workers: ${indicator.label}`}
        title={indicator.title || undefined}
        className="flex items-center gap-2 rounded-md px-1.5 py-1 transition hover:bg-white/5 hover:text-zinc-200"
      >
        <span className={cx('size-1.5 rounded-full', DOT[indicator.tone], indicator.pulse && 'pk-live')} />
        {indicator.label}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Workers on this board"
          className="absolute top-full right-0 z-50 mt-1.5 w-[300px] rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-1)] p-3 text-[11.5px] shadow-2xl shadow-black/60"
        >
          <h3 className="mb-1.5 text-[10.5px] font-semibold tracking-wide text-zinc-500 uppercase">Working</h3>
          {running.length ? (
            <ul className="mb-3 space-y-1">
              {running.map((t) => (
                <li key={t.id}>
                  <button
                    onClick={() => (setOpen(false), onOpenCard?.(t.id))}
                    className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-white/5"
                  >
                    <span className="size-1.5 shrink-0 rounded-full bg-emerald-400 pk-live" />
                    <span className="font-mono text-zinc-600">#{t.number}</span>
                    <span className="min-w-0 flex-1 truncate text-zinc-200">{t.title}</span>
                    {t.claimedBy && <span className="shrink-0 font-mono text-[10.5px] text-sky-300">{t.claimedBy}</span>}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mb-3 px-1.5 text-zinc-600">No card in progress.</p>
          )}

          <h3 className="mb-1.5 text-[10.5px] font-semibold tracking-wide text-zinc-500 uppercase">Waiting for cards</h3>
          {waiting.length ? (
            <ul className="space-y-1">
              {waiting.map((w) => (
                <li key={w.pid} className="flex items-baseline gap-2 px-1.5 py-0.5">
                  <span className="size-1.5 shrink-0 self-center rounded-full bg-emerald-400/60" />
                  <span className={cx('font-mono', w.name ? 'text-zinc-200' : 'text-zinc-500 italic')}>{w.name ?? 'unnamed'}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-zinc-500" title={w.filter ?? 'Takes any card'}>
                    {w.filter ?? 'any card'}
                  </span>
                  <span className="shrink-0 text-[10.5px] text-zinc-600">{relativeTime(w.since)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-1.5 text-zinc-600">
              {workers?.waiting ? `${workers.waiting} worker(s) waiting.` : 'None right now.'}
            </p>
          )}

          <p className="mt-3 border-t border-[var(--color-line)] pt-2 text-[10.5px] leading-relaxed text-zinc-600">
            Run several in parallel: <code className="font-mono text-zinc-400">/ticketrail-work fe --only label:frontend</code> in
            one Claude Code session, <code className="font-mono text-zinc-400">/ticketrail-work be --only label:backend</code> in
            another — ideally each in its own git worktree.
          </p>
        </div>
      )}
    </span>
  );
}
