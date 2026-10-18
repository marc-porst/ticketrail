import type { ProjectView } from '../lib/api.ts';

/**
 * What a space is doing right now, for the switcher and Configure spaces:
 * a card waiting on the user and a card being worked are both worth a badge,
 * side by side.
 */
export function ProjectStatus({ summary }: { summary: ProjectView['summary'] }) {
  const running = summary.inProgress;
  if (!summary.blocked && !running && !summary.queued) return null;

  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {summary.blocked > 0 && (
        <span className="rounded-full bg-amber-400/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300" title="A card is waiting for your input">
          {summary.blocked} waiting for you
        </span>
      )}
      {running > 0 && (
        <span className="flex items-center gap-1 rounded-full bg-sky-400/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-300" title="A card is being worked on">
          <span className="pk-live size-1 rounded-full bg-sky-300" />
          {running} in progress
        </span>
      )}
      {!summary.blocked && !running && <span className="text-[10.5px] text-zinc-600">{summary.queued} queued</span>}
    </span>
  );
}
