import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFor } from './api.ts';
import { normalizeFolders, normalizeTask } from './types.ts';
import { describeChange, type ChangeKind } from './changes.ts';
import type { BoardSnapshot, Task, WorkerPresence } from './types.ts';

export type Connection = 'connecting' | 'live' | 'offline';

export type BoardChange = { type: 'created' | 'updated'; id: string; task: Task } | { type: 'deleted'; id: string };

/** One server event applied to the card list. Pure, and safe to apply twice. */
export function applyBoardChange(tasks: Task[], change: BoardChange): Task[] {
  if (change.type === 'deleted' || change.task.archived) return tasks.filter((t) => t.id !== change.id);
  return tasks.some((t) => t.id === change.id)
    ? tasks.map((t) => (t.id === change.id ? change.task : t))
    : [...tasks, change.task];
}

/**
 * The board state, kept in sync with the JSON files through the server's SSE
 * stream. Every write Claude makes on disk lands here within a frame or two.
 */
export function useBoard(projectId: string | null, onChange?: (kind: ChangeKind, task: Task) => void) {
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [error, setError] = useState<string | null>(null);
  const paused = useRef(false);
  // kept in a ref so the SSE effect never re-subscribes when the handler changes
  const changeHandler = useRef(onChange);
  changeHandler.current = onChange;
  /** What the board looked like before the event being handled. */
  const tasksRef = useRef<Task[]>([]);
  /**
   * Events that arrived while the board was paused, replayed in order on
   * resume. Keeping only the last computed list would drop every earlier one.
   */
  const queued = useRef<BoardChange[]>([]);

  useEffect(() => {
    if (!projectId) return;
    // Drop the previous board immediately so its cards never flash under the
    // new project's header while the first snapshot is in flight.
    setSnapshot(null);
    setConnection('connecting');
    const source = new EventSource(`/api/projects/${projectId}/events`);

    source.addEventListener('snapshot', (event) => {
      const raw = JSON.parse((event as MessageEvent).data) as BoardSnapshot;
      // a fresh snapshot already contains anything held back during a drag
      queued.current = [];
      // Normalise on the way in as well as on the server: an older server
      // process, or a hand-edited file, must never be able to blank the board.
      setSnapshot({
        ...raw,
        folders: normalizeFolders(raw.folders ?? []),
        tasks: (raw.tasks ?? []).map((t) => normalizeTask(t, t.id)),
      });
      setConnection('live');
    });

    source.addEventListener('workers', (event) => {
      const workers = JSON.parse((event as MessageEvent).data) as WorkerPresence;
      setSnapshot((current) => (current ? { ...current, workers } : current));
    });

    source.addEventListener('board', (event) => {
      const parsed = JSON.parse((event as MessageEvent).data) as
        | { type: 'created' | 'updated'; id: string; task: Task }
        | { type: 'deleted'; id: string }
        | { type: 'folders'; folders: unknown };
      if (parsed.type === 'folders') {
        const folders = normalizeFolders(parsed.folders);
        setSnapshot((current) => (current ? { ...current, folders } : current));
        return;
      }
      const change =
        parsed.type === 'deleted' ? parsed : { ...parsed, task: normalizeTask(parsed.task, parsed.id) };

      // Diff before updating state: a setState updater must stay pure, and
      // React invokes it twice under StrictMode -- alerting from inside one
      // fires every sound and notification twice.
      if (change.type !== 'deleted') {
        const kind = describeChange(
          tasksRef.current.find((t) => t.id === change.id),
          change.task,
        );
        if (kind) changeHandler.current?.(kind, change.task);
      }

      // While a card is mid-drag, hold updates back so the board does not
      // jump under the pointer; they are applied on drop.
      if (paused.current) {
        queued.current.push(change);
        return;
      }
      setSnapshot((current) => (current ? { ...current, tasks: applyBoardChange(current.tasks, change) } : current));
    });

    source.onerror = () => setConnection((c) => (c === 'live' ? 'offline' : 'connecting'));

    // A stream can die without an error event (a laptop asleep, a network
    // switch) and miss what happened meanwhile. Coming back to the tab
    // re-reads the board, so a reload is never needed to catch up.
    const api = apiFor(projectId);
    const resync = () => {
      if (document.visibilityState !== 'visible' || paused.current) return;
      void api.board().then(
        (fresh) =>
          setSnapshot((current) =>
            current && Array.isArray(fresh?.tasks)
              ? {
                  ...current,
                  folders: normalizeFolders(fresh.folders ?? []),
                  tasks: (fresh.tasks ?? []).map((t) => normalizeTask(t, t.id)),
                }
              : current,
          ),
        () => {
          /* offline: the stream reconnects and sends a snapshot of its own */
        },
      );
    };
    document.addEventListener('visibilitychange', resync);
    window.addEventListener('online', resync);
    return () => {
      source.close();
      document.removeEventListener('visibilitychange', resync);
      window.removeEventListener('online', resync);
    };
  }, [projectId]);

  useEffect(() => {
    tasksRef.current = snapshot?.tasks ?? [];
  }, [snapshot]);

  const pause = useCallback((value: boolean) => {
    paused.current = value;
    if (!value && queued.current.length) {
      const changes = queued.current;
      queued.current = [];
      setSnapshot((current) => (current ? { ...current, tasks: changes.reduce(applyBoardChange, current.tasks) } : current));
    }
  }, []);

  /** Apply a change locally right away, then persist it. */
  const optimistic = useCallback((task: Task) => {
    setSnapshot((current) =>
      current ? { ...current, tasks: current.tasks.map((t) => (t.id === task.id ? task : t)) } : current,
    );
  }, []);

  const run = useCallback(async <T,>(work: () => Promise<T>): Promise<T | null> => {
    try {
      const result = await work();
      setError(null);
      return result;
    } catch (err) {
      setError((err as Error).message);
      const fresh = projectId ? await apiFor(projectId).board().catch(() => null) : null;
      if (fresh) setSnapshot(fresh);
      return null;
    }
  }, [projectId]);

  return { snapshot, connection, error, dismissError: () => setError(null), pause, optimistic, run };
}
