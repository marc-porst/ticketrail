import { lazy, type ComponentType } from 'react';

/**
 * A view loaded on first use, like React.lazy, but one that survives a
 * rebuild. Every build names its files by content, and a rebuild replaces
 * them; a page opened before the rebuild then asks for a file that no longer
 * exists. Plain lazy() would throw and take the whole board down with it.
 * This shows a small "reload" notice in place of the view instead.
 */
export function lazyView<P extends object>(load: () => Promise<ComponentType<P>>) {
  return lazy(async () => {
    try {
      return { default: await load() };
    } catch (err) {
      console.warn('[ticketrail] could not load part of the page, it was probably rebuilt', err);
      return { default: Outdated as ComponentType<P> };
    }
  });
}

/** Stands in for a view whose file is gone. Reloading fetches the current build. */
export function Outdated({ onClose }: { onClose?: () => void }) {
  return (
    <div className="fixed inset-x-0 bottom-6 z-50 flex justify-center px-4" role="alert">
      <div className="pk-panel flex max-w-md items-start gap-3 rounded-xl border border-amber-500/30 bg-[var(--color-surface-2)] px-4 py-3 shadow-xl">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-amber-200">Ticketrail was updated while this page was open</p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-400">
            This part of the page belongs to the new version. Reload to get it; your board is not affected.
          </p>
        </div>
        <button
          onClick={() => window.location.reload()}
          className="shrink-0 rounded-md bg-amber-400/20 px-3 py-1.5 text-[12px] font-medium text-amber-100 hover:bg-amber-400/30"
        >
          Reload
        </button>
        {onClose && (
          <button onClick={onClose} className="shrink-0 rounded-md p-1 text-zinc-500 hover:text-zinc-200" aria-label="Close">
            <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
