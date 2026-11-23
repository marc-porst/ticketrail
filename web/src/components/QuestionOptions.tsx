import { useState } from 'react';
import { cx } from '../lib/ui.ts';
import type { Message } from '../lib/types.ts';

/**
 * The choices Claude offered with a question, as buttons. One click answers a
 * single-choice question; a multiple-choice one collects picks and sends them
 * together. Once answered, the picks stay highlighted and nothing is clickable.
 */
export function QuestionOptions({
  question,
  answer,
  onAnswer,
  compact = false,
}: {
  question: Message;
  /** The user's reply, when the question has one. */
  answer?: Message | null;
  onAnswer: (text: string, choices: string[]) => void;
  /** Small buttons for the card face, without descriptions. */
  compact?: boolean;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const options = question.options ?? [];
  if (!options.length) return null;

  const answered = Boolean(question.answeredBy);
  const chosen = new Set(answer?.choices ?? []);
  const multi = question.multiSelect === true;

  const click = (label: string) => {
    if (answered) return;
    if (!multi) return onAnswer(label, [label]);
    setPicked((p) => (p.includes(label) ? p.filter((l) => l !== label) : [...p, label]));
  };
  // in the order Claude offered them, not the order they were clicked
  const send = () => {
    const labels = options.map((o) => o.label).filter((l) => picked.includes(l));
    if (labels.length) onAnswer(labels.join(', '), labels);
  };

  return (
    <div className={cx('flex flex-col', compact ? 'gap-1' : 'gap-1.5')} role="group" aria-label="Answer options">
      <div className={cx('flex flex-wrap', compact ? 'gap-1' : 'gap-1.5')}>
        {options.map((option) => {
          const on = answered ? chosen.has(option.label) : picked.includes(option.label);
          return (
            <button
              key={option.label}
              type="button"
              disabled={answered}
              aria-pressed={multi ? on : undefined}
              title={option.description}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                click(option.label);
              }}
              className={cx(
                'rounded-md border text-left transition',
                compact ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1.5 text-[12px]',
                on
                  ? 'border-amber-300/70 bg-amber-400/20 text-amber-50'
                  : answered
                    ? 'border-zinc-800 text-zinc-500'
                    : 'border-amber-400/35 bg-amber-400/[0.06] text-amber-100 hover:border-amber-300/70 hover:bg-amber-400/15',
              )}
            >
              <span className="font-medium">
                {multi && !compact && <span aria-hidden="true">{on ? '☑ ' : '☐ '}</span>}
                {option.label}
              </span>
              {!compact && option.description && (
                <span className={cx('block text-[11px] leading-snug', on ? 'text-amber-100/80' : 'text-zinc-400')}>
                  {option.description}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {multi && !answered && (
        <button
          type="button"
          disabled={!picked.length}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            send();
          }}
          className="self-start rounded-md bg-amber-400 px-2.5 py-1 text-[11.5px] font-medium text-amber-950 transition hover:bg-amber-300 disabled:bg-zinc-800 disabled:text-zinc-600"
        >
          {picked.length ? `Send ${picked.length} choice${picked.length > 1 ? 's' : ''}` : 'Pick one or more'}
        </button>
      )}
    </div>
  );
}
