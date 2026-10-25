import fs from 'node:fs';
import type { ServerResponse } from 'node:http';
import type { Store } from '../core/store.ts';
import type { Task } from '../core/task.ts';
import { claudeHome } from '../core/model.ts';
import { SessionReader, isTranscriptPath, lastEntries, type SessionEntry } from '../core/transcript.ts';
import { sendJson } from './http.ts';

/** The most entries a first look sends; older ones are only in the terminal's own scrollback. */
export const SESSION_ENTRIES = 300;
/** How often a live stream checks the transcript, in case a file event is missed. */
const POLL_MS = 1_000;

export interface SessionSnapshot {
  /** False when this card has no transcript slice to show. */
  recorded: boolean;
  /** True while the run is still writing to it. */
  live: boolean;
  entries: SessionEntry[];
  /** Older entries were left out. */
  clipped: boolean;
}

/** Still being written: the run has not stopped and the card is still out with Claude. */
export function isLive(task: Task): boolean {
  return Boolean(task.session && task.session.to === null && (task.column === 'in-progress' || task.column === 'user-input'));
}

type Opened =
  | { ok: true; task: Task; snapshot: SessionSnapshot; reader: SessionReader | null }
  | { ok: false; status: number; error: string };

function open(store: Store, id: string, home: string): Opened {
  const task = store.get(id);
  if (!task) return { ok: false, status: 404, error: `No task with id "${id}"` };
  const session = task.session;
  if (!session) {
    const snapshot = { recorded: false, live: false, entries: [], clipped: false };
    return { ok: true, task, snapshot, reader: null };
  }
  // A finished run reads from its saved copy, which outlives the transcript.
  if (!isLive(task) && session.saved) {
    const saved = store.savedSession(task.id, session.run);
    if (saved) {
      const snapshot = { recorded: true, live: false, entries: saved.entries, clipped: saved.clipped };
      return { ok: true, task, snapshot, reader: null };
    }
  }
  if (!isTranscriptPath(session.transcript, home)) {
    return { ok: false, status: 403, error: 'That transcript is not inside the Claude Code projects folder' };
  }
  const reader = new SessionReader(session.transcript, session.from, store.root);
  const { entries, cut } = lastEntries(reader.read(session.to), SESSION_ENTRIES);
  return {
    ok: true,
    task,
    snapshot: { recorded: true, live: isLive(task), entries, clipped: reader.clipped || cut },
    reader,
  };
}

/** An earlier run's saved session, from the card's history (or its current run, once saved). */
export function sendSavedSession(store: Store, id: string, run: string, res: ServerResponse): void {
  const task = store.get(id);
  if (!task) return sendJson(res, 404, { error: `No task with id "${id}"` });
  const known = task.sessionHistory.some((h) => h.run === run) || task.session?.run === run;
  const saved = known ? store.savedSession(task.id, run) : null;
  if (!saved) return sendJson(res, 404, { error: 'That run has no saved session' });
  const snapshot: SessionSnapshot = { recorded: true, live: false, entries: saved.entries, clipped: saved.clipped };
  sendJson(res, 200, snapshot);
}

/** One look at a card's session: what the Session tab shows before it starts streaming. */
export function sendSession(store: Store, id: string, res: ServerResponse, home = claudeHome()): void {
  const opened = open(store, id, home);
  if (!opened.ok) return sendJson(res, opened.status, { error: opened.error });
  sendJson(res, 200, opened.snapshot);
}

/**
 * Stream a card's session: a `snapshot`, then `entries` as the transcript
 * grows, then `end` once the run stops, after which the server hangs up.
 * Nothing is read unless someone has the tab open.
 */
export function streamSession(store: Store, id: string, res: ServerResponse, home = claudeHome()): void {
  const opened = open(store, id, home);
  if (!opened.ok) return sendJson(res, opened.status, { error: opened.error });

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('snapshot', opened.snapshot);
  if (!opened.snapshot.live || !opened.reader) {
    send('end', {});
    res.end();
    return;
  }

  const { transcript, from } = opened.task.session!;
  const reader = opened.reader;
  let closed = false;
  let watcher: fs.FSWatcher | null = null;

  const stop = () => {
    if (closed) return;
    closed = true;
    clearInterval(poll);
    clearInterval(ping);
    watcher?.close();
  };

  const check = () => {
    if (closed) return;
    const task = store.get(id);
    // a new run on the same card starts a new slice; the browser reopens for it
    const same = task?.session?.transcript === transcript && task.session.from === from;
    const to = same ? task!.session!.to : null;
    const entries = reader.read(to);
    if (entries.length) send('entries', entries);
    if (!task || !same || !isLive(task)) {
      send('end', {});
      stop();
      res.end();
    }
  };

  try {
    watcher = fs.watch(transcript, () => check());
    watcher.on('error', () => {
      watcher?.close();
      watcher = null;
    });
  } catch {
    watcher = null; // the poll below still covers it
  }
  const poll = setInterval(check, POLL_MS);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  poll.unref?.();
  ping.unref?.();
  res.on('close', stop);
}
