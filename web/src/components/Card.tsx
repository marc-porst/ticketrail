import { useDraggable, useDroppable } from '@dnd-kit/core';
import { ACCENT, cx, labelTone, mergeRefs, relativeTime } from '../lib/ui.ts';
import { pendingQuestion, TYPE_LABELS, type Task } from '../lib/types.ts';

export function CardFace({
  task,
  dragging,
  referencedBy = 0,
}: {
  task: Task;
  dragging?: boolean;
  /** How many other cards link this one as related. */
  referencedBy?: number;
}) {
  const accent = ACCENT[task.column];
  const waiting = pendingQuestion(task);
  const live = task.column === 'in-progress';
  const lastActivity = task.activity[task.activity.length - 1];

  return (
    <div
      className={cx(
        'pk-card relative overflow-hidden rounded-[10px] border px-3 pt-2.5 pb-2 text-left',
        waiting ? 'border-amber-400/40' : live ? 'border-emerald-400/25' : 'border-white/[0.06]',
        dragging ? 'pk-card-dragging rotate-[1.5deg] scale-[1.02]' : 'hover:border-white/[0.12]',
      )}
    >
      {/* a status rail on the leading edge: live work and open questions read at a glance */}
      {(live || waiting) && (
        <span
          aria-hidden="true"
          className={cx('absolute inset-y-2 left-0 w-[2px] rounded-r-full', waiting ? 'bg-amber-400' : 'bg-emerald-400')}
        />
      )}
      <div className="flex items-start gap-2">
        {live && <span className={cx('pk-ping mt-[7px] size-1.5 shrink-0 rounded-full', accent.dot)} />}
        <p className="flex-1 text-[13.5px] leading-[1.4] font-medium tracking-[-0.005em] text-zinc-100">{task.title}</p>
        {!live && task.worker && (
          <span className="mt-0.5 shrink-0 rounded-[4px] bg-sky-400/10 px-1.5 py-px font-mono text-[10px] text-sky-300/80" title={`Only worker ${task.worker} takes this card`}>
            → {task.worker}
          </span>
        )}
        {live && task.claimedBy && (
          <span className="mt-0.5 shrink-0 rounded-[4px] bg-emerald-400/10 px-1.5 py-px font-mono text-[10px] text-emerald-300" title={`Worked by ${task.claimedBy}`}>
            {task.claimedBy}
          </span>
        )}
      </div>

      {live && lastActivity && (
        <p className="mt-1.5 truncate text-[11px] text-emerald-300/75">{lastActivity.text}</p>
      )}

      {waiting && (
        <p className="mt-2 line-clamp-2 rounded-md bg-amber-400/[0.07] px-2 py-1.5 text-[11.5px] leading-snug text-amber-100/90">{waiting.text}</p>
      )}

      {task.labels.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {task.labels.slice(0, 3).map((label) => (
            <span key={label} className={cx('rounded-[4px] px-1.5 py-px text-[10.5px] font-medium', labelTone(label))}>
              {label}
            </span>
          ))}
          {task.labels.length > 3 && (
            <span className="text-[10px] text-zinc-600">+{task.labels.length - 3}</span>
          )}
        </div>
      )}

      <div className="mt-2.5 flex items-center gap-2.5 border-t border-white/[0.04] pt-2 text-[10.5px] text-zinc-500">
        <span className="font-mono text-zinc-600">#{task.number}</span>
        {task.type && (
          <span className="text-zinc-400" title={`Type: ${TYPE_LABELS[task.type]}`}>
            {TYPE_LABELS[task.type]}
          </span>
        )}
        {task.agent && (
          <span className="inline-flex min-w-0 items-center gap-1 text-violet-300/80" title={`Agent: ${task.agent}`}>
            <Glyph d="M8 2a3 3 0 110 6 3 3 0 010-6zM3 14a5 5 0 0110 0" />
            <span className="max-w-[90px] truncate">{task.agent}</span>
          </span>
        )}
        {task.plan && (
          <span className="inline-flex items-center gap-1 text-indigo-300/70" title="Has a plan">
            <Glyph d="M4 3h8l2 2v8H4z" /> plan
          </span>
        )}
        <RelatedBadge links={(task.related ?? []).length} referencedBy={referencedBy} />
        {task.attachments.length > 0 && (
          <span className="inline-flex items-center gap-1" title="Attachments">
            <Glyph d="M10 5L5.5 9.5a2 2 0 002.8 2.8l4.2-4.2a3.5 3.5 0 00-5-5L3 7.6" /> {task.attachments.length}
          </span>
        )}
        {task.messages.length > 0 && (
          <span className="inline-flex items-center gap-1" title="Conversation">
            <Glyph d="M2 3h12v8H6l-4 3z" /> {task.messages.length}
          </span>
        )}
        {task.activity.length > 0 && (
          <span className="inline-flex items-center gap-1" title="Activity">
            <Glyph d="M2 8h3l2-4 2 8 2-4h3" /> {task.activity.length}
          </span>
        )}
        <span className="pk-num ml-auto shrink-0 text-zinc-600">{relativeTime(task.updatedAt)}</span>
      </div>
    </div>
  );
}

/** Links out ("2") and links in ("←1"), so both ends of a relation show it. */
function RelatedBadge({ links, referencedBy }: { links: number; referencedBy: number }) {
  if (!links && !referencedBy) return null;
  const title = [
    links ? `Links ${links} related card${links > 1 ? 's' : ''}` : '',
    referencedBy ? `Related to by ${referencedBy} card${referencedBy > 1 ? 's' : ''}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <span className="inline-flex items-center gap-1 text-sky-300/70" title={title} aria-label={title}>
      <Glyph d="M7 9a3 3 0 004.2.3l2-2a3 3 0 00-4.2-4.2l-.8.8M9 7a3 3 0 00-4.2-.3l-2 2a3 3 0 004.2 4.2l.8-.8" />
      {links > 0 && <span>{links}</span>}
      {referencedBy > 0 && <span>←{referencedBy}</span>}
    </span>
  );
}

function Glyph({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d={d} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Card({
  task,
  onOpen,
  insertBefore,
  linkTarget = false,
  referencedBy,
}: {
  task: Task;
  onOpen: (task: Task) => void;
  insertBefore: boolean;
  /** A dragged card is over this card's link zone. */
  linkTarget?: boolean;
  referencedBy?: number;
}) {
  const draggable = useDraggable({ id: `card:${task.id}`, data: { taskId: task.id } });
  const droppable = useDroppable({ id: `card:${task.id}`, data: { taskId: task.id } });

  return (
    <div ref={droppable.setNodeRef} className="pk-rise relative">
      {insertBefore && <div className="absolute -top-1 right-0 left-0 h-0.5 rounded-full bg-sky-400" />}
      {linkTarget && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-end justify-center rounded-[10px] bg-sky-500/10 pb-1.5 outline-2 outline-sky-400 outline-dashed">
          <span className="rounded-full bg-sky-500/90 px-2 py-0.5 text-[10.5px] font-semibold text-white shadow">
            Link as related
          </span>
        </div>
      )}
      <button
        ref={mergeRefs(draggable.setNodeRef)}
        {...draggable.listeners}
        {...draggable.attributes}
        onClick={() => onOpen(task)}
        className={cx('block w-full cursor-grab touch-none rounded-[10px] active:cursor-grabbing', draggable.isDragging && 'opacity-30')}
      >
        <CardFace task={task} referencedBy={referencedBy} />
      </button>
    </div>
  );
}
