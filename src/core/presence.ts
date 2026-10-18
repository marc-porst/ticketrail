import fs from 'node:fs';
import path from 'node:path';
import type { Store } from './store.ts';

/** How often a waiting worker refreshes its heartbeat file. */
export const HEARTBEAT_MS = 15_000;
/** A heartbeat older than this belongs to a worker that is gone (SIGKILL, lid closed). */
export const STALE_MS = 45_000;

export interface WorkerPresence {
  /** Workers blocked in `wait` / `next --wait` right now. */
  waiting: number;
  /** The last time any worker command ran or a heartbeat ticked; null if never. */
  lastSeen: string | null;
  /** Who those waiting workers are. Absent from an older server. */
  workers?: WaitingWorker[];
}

export interface WaitingWorker {
  pid: number;
  /** `--worker <name>`; null for an unnamed worker. */
  name: string | null;
  /** The `--only` filter as typed, or null when it takes any card. */
  filter: string | null;
  /** When this wait began. */
  since: string;
}

const LAST_SEEN = 'last-seen';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it just is not ours to signal
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Announce a waiting worker until the returned stop function runs or the
 * process exits. The file is what the board header reads to say a worker is
 * there; a worker killed outright leaves it behind, which `workerPresence`
 * recognises by its age and its dead pid.
 */
export function startHeartbeat(store: Store, who: { name?: string | null; filter?: string | null } = {}): () => void {
  const dir = store.paths.workers;
  const file = path.join(dir, `${process.pid}.json`);
  const startedAt = new Date().toISOString();
  const name = who.name || null;
  const filter = who.filter || null;
  const beat = () => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const seenAt = new Date().toISOString();
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, name, filter, startedAt, seenAt, state: 'waiting' }));
    } catch {
      /* presence is best effort: never let it break a worker */
    }
  };
  beat();
  const timer = setInterval(beat, HEARTBEAT_MS);
  timer.unref?.();

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    process.off('exit', stop);
    for (const signal of SIGNALS) process.off(signal, onSignal);
    fs.rmSync(file, { force: true });
  };
  // A listener on a signal replaces Node's default exit, so exit ourselves.
  const onSignal = (signal: NodeJS.Signals) => {
    stop();
    process.exit(128 + (signal === 'SIGINT' ? 2 : signal === 'SIGHUP' ? 1 : 15));
  };
  process.once('exit', stop);
  for (const signal of SIGNALS) process.once(signal, onSignal);
  return stop;
}

const SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** Record that a worker just did something. Cheap, and never throws. */
export function touchWorker(store: Store): void {
  try {
    fs.mkdirSync(store.paths.workers, { recursive: true });
    fs.writeFileSync(path.join(store.paths.workers, LAST_SEEN), new Date().toISOString());
  } catch {
    /* best effort */
  }
}

/** Who is working this board, as far as the files on disk can tell. */
export function workerPresence(store: Store, now: number = Date.now()): WorkerPresence {
  const dir = store.paths.workers;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { waiting: 0, lastSeen: null, workers: [] };
  }

  const workers: WaitingWorker[] = [];
  let latest = 0;
  for (const name of entries) {
    const file = path.join(dir, name);
    try {
      if (name === LAST_SEEN) {
        const at = Date.parse(fs.readFileSync(file, 'utf8').trim());
        if (Number.isFinite(at)) latest = Math.max(latest, at);
        continue;
      }
      if (!name.endsWith('.json')) continue;
      const beat = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        pid: number;
        seenAt: string;
        startedAt?: string;
        name?: string | null;
        filter?: string | null;
      };
      const at = Date.parse(beat.seenAt);
      if (!Number.isFinite(at) || now - at > STALE_MS || !alive(beat.pid)) {
        fs.rmSync(file, { force: true });
        continue;
      }
      workers.push({
        pid: beat.pid,
        name: typeof beat.name === 'string' && beat.name ? beat.name : null,
        filter: typeof beat.filter === 'string' && beat.filter ? beat.filter : null,
        since: typeof beat.startedAt === 'string' ? beat.startedAt : beat.seenAt,
      });
      latest = Math.max(latest, at);
    } catch {
      /* half-written or vanished mid-read: skip it this round */
    }
  }
  workers.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || a.pid - b.pid);
  return { waiting: workers.length, lastSeen: latest ? new Date(latest).toISOString() : null, workers };
}
