import { useMemo, useState } from 'react';
import { ACCENT, cx } from '../lib/ui.ts';
import { COLUMN_LABELS, MAX_RELATED, TYPE_LABELS, type Task } from '../lib/types.ts';

/**
 * Cards whose plan and result Claude reads alongside this one. Links are stored
 * one way, on the card that needs the context; "Referenced by" is worked out
 * from everyone else's links and is read-only here.
 */
export function RelatedCards({
  task,
  allTasks,
  onChange,
  onOpenCard,
}: {
  task: Task;
  allTasks: Task[];
  onChange: (related: string[]) => void;
  onOpenCard: (id: string) => void;
}) {
  const related = task.related ?? [];
  const byId = useMemo(() => new Map(allTasks.map((t) => [t.id, t])), [allTasks]);
  const derivedFrom = task.derivedFrom ? byId.get(task.derivedFrom) : undefined;
  const referencedBy = allTasks.filter((t) => t.id !== task.id && (t.related ?? []).includes(task.id));
  const full = related.length >= MAX_RELATED;

  return (
    <div className="space-y-5 p-5">
      <section>
        {related.length === 0 ? (
          <p className="text-[12.5px] text-zinc-500">
            Link cards whose plan or result Claude should read with this one.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {related.map((id) => (
              <RelatedRow
                key={id}
                card={byId.get(id)}
                onOpen={() => onOpenCard(id)}
                onRemove={() => onChange(related.filter((r) => r !== id))}
              />
            ))}
          </ul>
        )}

        <CardPicker
          disabled={full}
          candidates={allTasks.filter((t) => t.id !== task.id && !related.includes(t.id))}
          onPick={(id) => onChange([...related, id])}
        />
        {full && <p className="mt-1.5 text-[11px] text-zinc-600">At most {MAX_RELATED} related cards.</p>}
      </section>

      {derivedFrom && (
        <section>
          <Heading>Derived from</Heading>
          <ul>
            <RelatedRow card={derivedFrom} onOpen={() => onOpenCard(derivedFrom.id)} />
          </ul>
        </section>
      )}

      {referencedBy.length > 0 && (
        <section>
          <Heading>Referenced by</Heading>
          <ul className="space-y-1.5">
            {referencedBy.map((t) => (
              <RelatedRow key={t.id} card={t} onOpen={() => onOpenCard(t.id)} />
            ))}
          </ul>
        </section>
      )}

      <p className="text-[11px] leading-relaxed text-zinc-600">
        When Claude picks this card up it reads the description, plan and result of each linked card (and the card it
        was derived from) as context. Referenced-by links are shown here only.
      </p>
    </div>
  );
}

function Heading({ children }: { children: string }) {
  return <p className="mb-2 text-[10.5px] font-semibold tracking-wide text-zinc-500 uppercase">{children}</p>;
}

function RelatedRow({ card, onOpen, onRemove }: { card: Task | undefined; onOpen: () => void; onRemove?: () => void }) {
  return (
    <li className="group flex items-center gap-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] px-2.5 py-2">
      {card ? (
        <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <span className="font-mono text-[11px] text-zinc-600">#{card.number}</span>
          <span className="truncate text-[12.5px] text-zinc-200 group-hover:text-white">{card.title}</span>
          {(card.plan || card.result) && (
            <span
              className={cx('size-1.5 shrink-0 rounded-full', card.result ? 'bg-emerald-400' : 'bg-indigo-400')}
              title={card.result ? 'Has a result' : 'Has a plan'}
            />
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {card.type && <span className="text-[10.5px] text-zinc-500">{TYPE_LABELS[card.type]}</span>}
            <span className={cx('rounded-full px-1.5 py-0.5 text-[10px] font-medium', ACCENT[card.column].soft, ACCENT[card.column].text)}>
              {COLUMN_LABELS[card.column]}
            </span>
          </span>
        </button>
      ) : (
        <span className="flex-1 text-[12px] text-zinc-600 italic">Archived or deleted card</span>
      )}
      {onRemove && (
        <button
          onClick={onRemove}
          className="shrink-0 rounded p-0.5 text-zinc-600 hover:bg-white/5 hover:text-red-400"
          aria-label={card ? `Unlink #${card.number}` : 'Unlink'}
        >
          <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </li>
  );
}

/** Type a number or part of a title; ↑/↓ to move, Enter to link, Esc to clear. */
function CardPicker({
  candidates,
  disabled,
  onPick,
}: {
  candidates: Task[];
  disabled: boolean;
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^#/, '');
    if (!q) return [];
    return candidates
      .filter((t) => String(t.number).startsWith(q) || t.title.toLowerCase().includes(q))
      .slice(0, 8);
  }, [candidates, query]);

  const pick = (t: Task) => {
    onPick(t.id);
    setQuery('');
    setCursor(0);
  };

  return (
    <div className="relative mt-3">
      <input
        value={query}
        disabled={disabled}
        onChange={(e) => {
          setQuery(e.target.value);
          setCursor(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setCursor((c) => Math.min(c + 1, matches.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setCursor((c) => Math.max(c - 1, 0));
          } else if (e.key === 'Enter' && matches[cursor]) {
            e.preventDefault();
            pick(matches[cursor]);
          } else if (e.key === 'Escape' && query) {
            // keep the drawer open: Escape here only clears the search
            e.stopPropagation();
            e.nativeEvent.stopImmediatePropagation();
            setQuery('');
          }
        }}
        placeholder="Add related card — #number or title"
        aria-label="Add related card"
        className="w-full rounded-lg border border-[var(--color-line)] bg-transparent px-3 py-2 text-[12.5px] text-zinc-200 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none disabled:opacity-50"
      />
      {matches.length > 0 && (
        <ul
          role="listbox"
          className="absolute right-0 left-0 z-10 mt-1 overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] shadow-xl"
        >
          {matches.map((t, i) => (
            <li key={t.id} role="option" aria-selected={i === cursor}>
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(t)}
                onMouseEnter={() => setCursor(i)}
                className={cx(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px]',
                  i === cursor ? 'bg-white/5 text-zinc-100' : 'text-zinc-300',
                )}
              >
                <span className="font-mono text-[11px] text-zinc-600">#{t.number}</span>
                <span className="truncate">{t.title}</span>
                <span className="ml-auto shrink-0 text-[10.5px] text-zinc-500">{COLUMN_LABELS[t.column]}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {query.trim() && matches.length === 0 && (
        <p className="mt-1.5 text-[11px] text-zinc-600">No card matches.</p>
      )}
    </div>
  );
}
