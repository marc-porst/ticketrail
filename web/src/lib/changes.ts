import type { Task } from './types.ts';

export type ChangeKind = 'needs-you' | 'planned' | 'done' | 'started';

/**
 * Whether a card's move is worth interrupting someone for.
 *
 * Only transitions Claude makes qualify. Moves into Backlog, Plan or Implement
 * are things you did yourself, and a board that beeps at your own drags gets
 * muted within a day.
 */
export function describeChange(previous: Task | undefined, current: Task): ChangeKind | null {
  // A card seen for the first time is not a change: on a reload every card
  // would otherwise fire at once for moves that happened while you were away.
  if (!previous) return null;
  if (previous.column === current.column) return null;

  switch (current.column) {
    case 'user-input':
      return 'needs-you';
    case 'planned':
      return 'planned';
    case 'done':
      return 'done';
    case 'in-progress':
      return 'started';
    default:
      return null;
  }
}

export const CHANGE_TEXT: Record<ChangeKind, { title: string; body: (title: string) => string }> = {
  'needs-you': { title: 'Claude needs your answer', body: (t) => t },
  planned: { title: 'A plan is ready to review', body: (t) => t },
  done: { title: 'Finished', body: (t) => t },
  started: { title: 'Claude started a card', body: (t) => t },
};
