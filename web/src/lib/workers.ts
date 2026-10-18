import type { Connection } from './useBoard.ts';
import type { Task, WorkerPresence } from './types.ts';

/** A worker that ran a command this recently still counts as there between cards. */
export const READY_GRACE_MS = 45_000;
/** An In Progress card with no worker check-in for this long has probably been abandoned. */
export const STALLED_MS = 10 * 60_000;

export type IndicatorTone = 'green' | 'amber' | 'red' | 'grey';

export interface Indicator {
  tone: IndicatorTone;
  label: string;
  title: string;
  pulse: boolean;
}

/**
 * What the header dot says. The SSE connection only tells us the board server
 * is up; whether anyone is actually working the board comes from the worker
 * heartbeats the server reports alongside the cards.
 */
export function describeIndicator(
  connection: Connection,
  workers: WorkerPresence | undefined,
  tasks: Task[],
  now: number = Date.now(),
): Indicator {
  if (connection === 'offline') {
    return { tone: 'red', label: 'offline', title: 'The board server is not reachable', pulse: false };
  }
  if (connection === 'connecting') return { tone: 'amber', label: 'connecting', title: '', pulse: false };
  // an older server knows nothing about workers: say what it always said
  if (!workers) return { tone: 'green', label: 'live', title: 'Connected to the board server', pulse: false };

  const seen = workers.lastSeen ? now - Date.parse(workers.lastSeen) : Infinity;
  const running = tasks.filter((t) => t.column === 'in-progress');
  const active = running[0];
  if (active) {
    if (workers.waiting > 0 || seen < STALLED_MS) {
      const on = running.map((t) => `#${t.number}${t.claimedBy ? ` (${t.claimedBy})` : ''}`).join(', ');
      return { tone: 'green', label: running.length > 1 ? `working · ${running.length}` : 'working', title: `Claude is on ${on}`, pulse: true };
    }
    return {
      tone: 'amber',
      label: 'stalled?',
      title: `#${active.number} is In Progress, but no worker has checked in for over 10 minutes`,
      pulse: false,
    };
  }
  if (workers.waiting > 0 || seen < READY_GRACE_MS) {
    return { tone: 'green', label: 'worker ready', title: '/ticketrail-work is waiting for cards', pulse: false };
  }
  return {
    tone: 'grey',
    label: 'no worker',
    title: 'Nothing is working this board. Run /ticketrail-work in Claude Code to start a worker.',
    pulse: false,
  };
}

/**
 * The switcher's dot for one space: green while a worker is on that board or
 * between its cards, red when nothing is working it. Without the board's tasks
 * a running card is judged from the summary count alone.
 */
export function hasWorker(workers: WorkerPresence | undefined, inProgress: number, now: number = Date.now()): boolean {
  if (!workers) return false;
  if (workers.waiting > 0) return true;
  const seen = workers.lastSeen ? now - Date.parse(workers.lastSeen) : Infinity;
  return seen < (inProgress > 0 ? STALLED_MS : READY_GRACE_MS);
}
