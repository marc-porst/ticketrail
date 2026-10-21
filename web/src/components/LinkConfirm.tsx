import { useEffect, useRef, useState } from 'react';
import type { Task } from '../lib/types.ts';

/**
 * Asked before a drag links two cards: says what the link means, and lets you
 * stop being asked. Enter confirms, Escape cancels.
 */
export function LinkConfirm({
  dragged,
  target,
  onConfirm,
  onCancel,
}: {
  dragged: Task;
  target: Task;
  /** `dontAskAgain` is the checkbox; it only counts when you confirm. */
  onConfirm: (dontAskAgain: boolean) => void;
  onCancel: () => void;
}) {
  const [dontAsk, setDontAsk] = useState(false);
  const ok = useRef<HTMLButtonElement>(null);
  useEffect(() => ok.current?.focus(), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Link cards">
      <div className="pk-scrim absolute inset-0" onClick={onCancel} />
      <form
        className="relative w-full max-w-[440px] rounded-2xl border border-white/[0.07] bg-[var(--color-surface-1)] p-5 pk-panel"
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm(dontAsk);
        }}
      >
        <h2 className="text-[15px] font-semibold tracking-tight text-zinc-100">Link these cards?</h2>

        <div className="mt-3 space-y-1.5 rounded-lg border border-[var(--color-line)] bg-black/20 p-3 text-[12.5px]">
          <CardLine task={dragged} />
          <p className="pl-1 text-[11px] text-sky-300/80">becomes related context of</p>
          <CardLine task={target} />
        </div>

        <p className="mt-3 text-[12.5px] leading-relaxed text-zinc-400">
          <span className="font-mono text-zinc-500">#{target.number}</span> will list{' '}
          <span className="font-mono text-zinc-500">#{dragged.number}</span> under <span className="text-zinc-200">Related</span>.
          When Claude works <span className="font-mono text-zinc-500">#{target.number}</span>, it reads the description, plan and
          result of <span className="font-mono text-zinc-500">#{dragged.number}</span> as context. Neither card moves, and you
          can remove the link in the Related tab.
        </p>

        <label className="mt-4 flex cursor-pointer items-center gap-2 text-[12px] text-zinc-400 select-none">
          <input
            type="checkbox"
            checked={dontAsk}
            onChange={(e) => setDontAsk(e.target.checked)}
            className="size-3.5 accent-sky-500"
          />
          Don't show this again
        </label>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-[12px] text-zinc-400 transition hover:bg-white/5 hover:text-zinc-100"
          >
            Cancel
          </button>
          <button
            ref={ok}
            type="submit"
            className="rounded-md bg-sky-500 px-3.5 py-1.5 text-[12px] font-medium text-sky-950 transition hover:bg-sky-400"
          >
            OK, link them
          </button>
        </div>
      </form>
    </div>
  );
}

function CardLine({ task }: { task: Task }) {
  return (
    <p className="flex items-baseline gap-2">
      <span className="font-mono text-[11px] text-zinc-600">#{task.number}</span>
      <span className="min-w-0 truncate text-zinc-200">{task.title}</span>
    </p>
  );
}
