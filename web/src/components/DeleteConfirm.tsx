import { useEffect, useRef, useState } from 'react';
import type { Task } from '../lib/types.ts';

/**
 * Asked before a card is deleted: says what goes with it, and lets you stop
 * being asked. Escape cancels; the safe button has the focus.
 */
export function DeleteConfirm({
  task,
  linkedFrom,
  onConfirm,
  onCancel,
}: {
  task: Task;
  /** Cards that link this one; they lose the link. */
  linkedFrom: Task[];
  /** `dontAskAgain` is the checkbox; it only counts when you confirm. */
  onConfirm: (dontAskAgain: boolean) => void;
  onCancel: () => void;
}) {
  const [dontAsk, setDontAsk] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);

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

  const files = task.attachments.length;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Delete card">
      <div className="pk-scrim absolute inset-0" onClick={onCancel} />
      <form
        className="relative w-full max-w-[440px] rounded-2xl border border-white/[0.07] bg-[var(--color-surface-1)] p-5 pk-panel"
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm(dontAsk);
        }}
      >
        <h2 className="text-[15px] font-semibold tracking-tight text-zinc-100">Delete this card?</h2>

        <p className="mt-3 flex items-baseline gap-2 rounded-lg border border-[var(--color-line)] bg-black/20 p-3 text-[12.5px]">
          <span className="font-mono text-[11px] text-zinc-600">#{task.number}</span>
          <span className="min-w-0 truncate text-zinc-200">{task.title}</span>
        </p>

        <ul className="mt-3 list-disc space-y-1 pl-5 text-[12.5px] leading-relaxed text-zinc-400">
          <li>
            The card is removed for good, with its plan, result, chat and session
            {files ? (
              <>
                {' '}and its {files} attached file{files > 1 ? 's' : ''}
              </>
            ) : null}
            . It cannot be undone.
          </li>
          {linkedFrom.length > 0 && (
            <li>
              {linkedFrom.map((t) => `#${t.number}`).join(', ')} {linkedFrom.length > 1 ? 'link' : 'links'} to it and will lose
              that link.
            </li>
          )}
        </ul>

        <label className="mt-4 flex cursor-pointer items-center gap-2 text-[12px] text-zinc-400 select-none">
          <input
            type="checkbox"
            checked={dontAsk}
            onChange={(e) => setDontAsk(e.target.checked)}
            className="size-3.5 accent-red-500"
          />
          Don't show this again
        </label>

        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancel}
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-[12px] text-zinc-300 transition hover:bg-white/5 hover:text-zinc-100"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded-md bg-red-500 px-3.5 py-1.5 text-[12px] font-medium text-white transition hover:bg-red-400"
          >
            Delete card
          </button>
        </div>
      </form>
    </div>
  );
}
