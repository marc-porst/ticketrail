import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Markdown } from './Markdown.tsx';
import { clockTime, cx, relativeTime } from '../lib/ui.ts';
import { apiFor } from '../lib/api.ts';
import type { PastSession, SessionEntry, SessionSnapshot, Task } from '../lib/types.ts';

/** Within this many pixels of the bottom counts as "following" the stream. */
const STICK_PX = 48;

type Row =
  | { kind: 'text'; entry: SessionEntry }
  /** `steps`: what a subagent started by this call did, nested under it. */
  | { kind: 'tool'; entry: SessionEntry; result: SessionEntry | null; steps: Row[] }
  | { kind: 'result'; entry: SessionEntry };

/**
 * Each call with the result that answered it, in the order the calls were
 * made, and each subagent's steps under the Agent call that started it.
 */
export function pairRows(entries: SessionEntry[]): Row[] {
  const byParent = new Map<string, SessionEntry[]>();
  const own: SessionEntry[] = [];
  for (const entry of entries) {
    if (!entry.parent) own.push(entry);
    else byParent.set(entry.parent, [...(byParent.get(entry.parent) ?? []), entry]);
  }
  const used = new Set<string>();
  const rows = buildRows(own, byParent, used);
  // steps whose call is not in view still show, rather than vanish
  for (const [parent, steps] of byParent) {
    if (!used.has(parent)) rows.push(...buildRows(steps, byParent, used));
  }
  return rows;
}

function buildRows(entries: SessionEntry[], byParent: Map<string, SessionEntry[]>, used: Set<string>): Row[] {
  const rows: Row[] = [];
  const calls = new Map<string, Extract<Row, { kind: 'tool' }>>();
  for (const entry of entries) {
    if (entry.kind === 'text') rows.push({ kind: 'text', entry });
    else if (entry.kind === 'tool') {
      const id = entry.toolId;
      const steps = id && byParent.has(id) && !used.has(id) ? (used.add(id), buildRows(byParent.get(id)!, byParent, used)) : [];
      const row = { kind: 'tool' as const, entry, result: null, steps };
      if (id) calls.set(id, row);
      rows.push(row);
    } else {
      const call = entry.toolId ? calls.get(entry.toolId) : undefined;
      if (call && !call.result) call.result = entry;
      else rows.push({ kind: 'result', entry }); // its call was before the first entry we were sent
    }
  }
  return rows;
}

/** Add what streamed in, skipping anything already shown (a reconnect resends). */
function merge(current: SessionEntry[], incoming: SessionEntry[]): SessionEntry[] {
  const seen = new Set(current.map((e) => e.id));
  const fresh = incoming.filter((e) => !seen.has(e.id));
  return fresh.length ? [...current, ...fresh] : current;
}

export function SessionFeed({ task, projectId }: { task: Task; projectId: string }) {
  const history = task.sessionHistory;
  // the newest run is always shown; when the latest claim recorded nothing, that is the newest saved one
  const latestPast = !task.session && history.length ? history[history.length - 1] : null;
  const earlier = latestPast ? history.slice(0, -1) : history;
  const runs = history.length + (task.session ? 1 : 0);

  if (!task.session && !history.length) {
    return (
      <p className="p-5 text-sm text-zinc-600 italic">
        No session recorded for this card. It shows what the worker's terminal shows, read from its Claude Code
        transcript, so it fills in once a worker running in Claude Code picks the card up (unless{' '}
        <code>liveSession</code> is off in .ticketrail/config.json).
      </p>
    );
  }

  return (
    <div className="p-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <RunHeading
          number={runs}
          mode={task.session ? task.mode : latestPast!.mode}
          at={task.session?.startedAt ?? latestPast?.startedAt ?? null}
        />
        <ClearSession task={task} projectId={projectId} runs={runs} />
      </div>
      {task.session ? (
        <LiveSession task={task} projectId={projectId} />
      ) : (
        <SavedSession projectId={projectId} taskId={task.id} run={latestPast!.run} />
      )}

      {earlier.length > 0 && (
        <section className="mt-6 border-t border-[var(--color-line)] pt-4">
          <p className="mb-2 text-[10.5px] font-semibold tracking-wide text-zinc-500 uppercase">
            Earlier sessions ({earlier.length})
          </p>
          <ol className="space-y-2">
            {[...earlier].reverse().map((past, i) => (
              <li key={past.run}>
                <PastRun projectId={projectId} taskId={task.id} past={past} number={earlier.length - i} />
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

const MODE_LABEL = { plan: 'Plan', implement: 'Implement' } as const;

/**
 * Forget this card's sessions, asking once first. Not while a run is being
 * written: the next poll would only bring it back.
 */
function ClearSession({ task, projectId, runs }: { task: Task; projectId: string; runs: number }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = task.session?.to === null && (task.column === 'in-progress' || task.column === 'user-input');

  const clear = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiFor(projectId).clearSession(task.id);
      // the board stream brings the emptied card back; nothing else to do here
    } catch (err) {
      setError((err as Error).message);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  if (confirming) {
    return (
      <span className="flex shrink-0 items-center gap-2 text-[11px]">
        <span className="text-zinc-400">{runs === 1 ? 'Clear this session?' : `Clear all ${runs} runs?`}</span>
        <button
          onClick={clear}
          disabled={busy}
          className="rounded-md bg-red-500/15 px-2 py-0.5 font-medium text-red-300 transition hover:bg-red-500/25 disabled:opacity-50"
        >
          Clear
        </button>
        <button onClick={() => setConfirming(false)} className="text-zinc-500 hover:text-zinc-300">
          Cancel
        </button>
      </span>
    );
  }
  return (
    <span className="flex shrink-0 flex-col items-end">
      <button
        onClick={() => setConfirming(true)}
        disabled={live}
        title={live ? 'Claude is still working on this card' : "Remove this card's session and its history"}
        className="text-[11px] text-zinc-600 transition hover:text-red-400 disabled:cursor-not-allowed disabled:hover:text-zinc-600"
      >
        Clear session
      </button>
      {error && <span className="mt-1 max-w-[220px] text-right text-[10.5px] text-red-400">{error}</span>}
    </span>
  );
}

function RunHeading({ number, mode, at }: { number: number; mode: Task['mode']; at: string | null }) {
  return (
    <p className="text-[10.5px] font-semibold tracking-wide text-sky-300/90 uppercase">
      Run {number}
      {mode && <> · {MODE_LABEL[mode]}</>}
      {at && (
        <span className="font-normal text-zinc-500 normal-case" title={at}>
          {' '}
          · {relativeTime(at)}
        </span>
      )}
    </p>
  );
}

/** An earlier run, collapsed until opened; its entries are fetched the first time. */
function PastRun({ projectId, taskId, past, number }: { projectId: string; taskId: string; past: PastSession; number: number }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="group rounded-md border border-[var(--color-line)]" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer px-3 py-2 text-[12px] text-zinc-400 select-none hover:text-zinc-200">
        Run {number}
        {past.mode && <> · {MODE_LABEL[past.mode]}</>} · <span title={past.endedAt}>{relativeTime(past.endedAt)}</span>
      </summary>
      {open && (
        <div className="border-t border-[var(--color-line)] px-3 py-3 opacity-90">
          <SavedSession projectId={projectId} taskId={taskId} run={past.run} />
        </div>
      )}
    </details>
  );
}

/** A finished run, read once from its saved copy. */
function SavedSession({ projectId, taskId, run }: { projectId: string; taskId: string; run: string }) {
  const [state, setState] = useState<{ entries: SessionEntry[]; clipped: boolean; error: string | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setState(null);
    fetch(`/api/projects/${projectId}/tasks/${taskId}/sessions/${run}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? 'The session could not be read.');
        return body as SessionSnapshot;
      })
      .then((snap) => !cancelled && setState({ entries: snap.entries, clipped: snap.clipped, error: null }))
      .catch((err: Error) => !cancelled && setState({ entries: [], clipped: false, error: err.message }));
    return () => {
      cancelled = true;
    };
  }, [projectId, taskId, run]);

  if (!state) return <p className="text-[12px] text-zinc-600">Loading…</p>;
  return <SessionRows entries={state.entries} clipped={state.clipped} error={state.error} empty="Nothing was recorded for this run." />;
}

function SessionRows({
  entries,
  clipped,
  error,
  empty,
}: {
  entries: SessionEntry[];
  clipped: boolean;
  error: string | null;
  empty: string | null;
}) {
  const rows = useMemo(() => pairRows(entries), [entries]);
  return (
    <>
      {clipped && <p className="mb-3 text-[11px] text-zinc-600">Earlier output is not shown.</p>}
      {error && <p className="mb-3 text-[12px] text-red-400">{error}</p>}
      {!rows.length && !error && empty && <p className="text-sm text-zinc-600 italic">{empty}</p>}
      <RowList rows={rows} />
    </>
  );
}

function RowList({ rows }: { rows: Row[] }) {
  return (
    <ol className="space-y-2">
      {rows.map((row) => (
        // steps nested under their call are already set apart; only stray subagent rows need the marker
        <li key={row.entry.id} className={cx(row.entry.subagent && !row.entry.parent && 'ml-4 border-l border-violet-500/30 pl-3')}>
          {row.entry.subagent && !row.entry.parent && <span className="mb-0.5 block text-[10px] text-violet-300/80">subagent</span>}
          {row.kind === 'text' ? (
            <div className="text-[13px]">
              <Markdown>{row.entry.text ?? ''}</Markdown>
            </div>
          ) : (
            <>
              <ToolRow call={row.kind === 'tool' ? row.entry : null} result={row.kind === 'tool' ? row.result : row.entry} />
              {row.kind === 'tool' && row.steps.length > 0 && <SubagentSteps steps={row.steps} />}
            </>
          )}
        </li>
      ))}
    </ol>
  );
}

/** What a subagent did, under the Agent call that started it. */
function SubagentSteps({ steps }: { steps: Row[] }) {
  const [open, setOpen] = useState(true);
  const count = steps.filter((r) => r.kind === 'tool').length;
  return (
    <div className="mt-1.5 ml-3 border-l border-violet-500/30 pl-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="mb-1.5 flex items-center gap-1.5 text-[10.5px] text-violet-300/80 hover:text-violet-200"
        aria-expanded={open}
      >
        <span>{open ? '▾' : '▸'}</span>
        Subagent · {count} {count === 1 ? 'step' : 'steps'}
      </button>
      {open && <RowList rows={steps} />}
    </div>
  );
}

/** The current run: a snapshot, then whatever streams in until the run stops. */
function LiveSession({ task, projectId }: { task: Task; projectId: string }) {
  const [entries, setEntries] = useState<SessionEntry[]>([]);
  const [state, setState] = useState<{ loaded: boolean; live: boolean; clipped: boolean; error: string | null }>({
    loaded: false,
    live: false,
    clipped: false,
    error: null,
  });
  const end = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [behind, setBehind] = useState(false);

  // A new run on the card is a new slice: start over when it begins.
  const slice = task.session ? task.session.run : null;
  const running = task.session?.to === null && (task.column === 'in-progress' || task.column === 'user-input');

  useEffect(() => {
    setEntries([]);
    setState({ loaded: false, live: false, clipped: false, error: null });
    if (!slice || typeof EventSource === 'undefined') {
      setState((s) => ({ ...s, loaded: true }));
      return;
    }
    const source = new EventSource(`/api/projects/${projectId}/tasks/${task.id}/session/events`);
    source.addEventListener('snapshot', (e) => {
      const snap = JSON.parse((e as MessageEvent).data) as SessionSnapshot;
      setEntries((current) => merge(current, snap.entries));
      setState({ loaded: true, live: snap.live, clipped: snap.clipped, error: null });
    });
    source.addEventListener('entries', (e) => {
      const more = JSON.parse((e as MessageEvent).data) as SessionEntry[];
      setEntries((current) => merge(current, more));
    });
    // the server hangs up once the run stops; without this EventSource would reconnect
    source.addEventListener('end', () => {
      source.close();
      setState((s) => ({ ...s, loaded: true, live: false }));
    });
    source.onerror = () => {
      // a refusal (403/404) closes the source for good; a dropped connection retries by itself
      if (source.readyState === EventSource.CLOSED) {
        setState((s) => ({ ...s, loaded: true, live: false, error: 'The session could not be read.' }));
      }
    };
    return () => source.close();
  }, [projectId, task.id, slice, running]);

  // Follow the end of this run like a terminal, unless the user has scrolled up to read.
  const scroller = () => end.current?.closest('.overflow-y-auto') ?? null;
  const atEnd = () => {
    const box = scroller();
    if (!box || !end.current) return true;
    return end.current.getBoundingClientRect().bottom - box.getBoundingClientRect().bottom < STICK_PX;
  };

  useEffect(() => {
    const box = scroller();
    if (!box) return;
    const onScroll = () => {
      following.current = atEnd();
      if (following.current) setBehind(false);
    };
    box.addEventListener('scroll', onScroll, { passive: true });
    return () => box.removeEventListener('scroll', onScroll);
  }, []);

  useLayoutEffect(() => {
    if (!entries.length || !state.live) return;
    if (following.current) end.current?.scrollIntoView?.({ block: 'end' });
    else setBehind(true);
  }, [entries.length, state.live]);

  const jump = () => {
    end.current?.scrollIntoView?.({ block: 'end' });
    following.current = true;
    setBehind(false);
  };

  return (
    <div className="relative">
      <SessionRows
        entries={entries}
        clipped={state.clipped}
        error={state.error}
        empty={state.loaded ? (state.live ? 'Waiting for the worker…' : 'Nothing was recorded for this run.') : null}
      />

      {state.live && (
        <p className="mt-4 flex items-center gap-2 text-[11px] text-emerald-300/80">
          <span className="pk-live inline-block size-1.5 rounded-full bg-emerald-400" /> Live
        </p>
      )}
      <div ref={end} />

      {behind && (
        <button
          onClick={jump}
          className="sticky bottom-3 left-full mt-3 block rounded-full bg-sky-500/90 px-3 py-1 text-[11.5px] font-medium text-white shadow-lg transition hover:bg-sky-400"
        >
          Jump to latest ↓
        </button>
      )}
    </div>
  );
}

function ToolRow({ call, result }: { call: SessionEntry | null; result: SessionEntry | null }) {
  const error = Boolean(result?.error);
  const [open, setOpen] = useState(error);
  useEffect(() => {
    if (error) setOpen(true);
  }, [error]);
  const tool = call?.tool ?? result?.tool ?? 'Tool';
  const pending = call && !result;
  const hasOutput = Boolean(result?.output?.trim() || call?.detail);

  return (
    <div className={cx('rounded-md border font-mono text-[11.5px]', error ? 'border-red-500/30 bg-red-500/[0.06]' : 'border-white/[0.06] bg-[var(--color-surface-2)]')}>
      <button
        onClick={() => hasOutput && setOpen((o) => !o)}
        className={cx('flex w-full items-center gap-2 px-2.5 py-1.5 text-left', hasOutput && 'cursor-pointer')}
        aria-expanded={hasOutput ? open : undefined}
      >
        <span className={cx('shrink-0 rounded-[4px] px-1.5 py-px text-[10.5px]', error ? 'bg-red-500/15 text-red-300' : 'bg-sky-500/10 text-sky-300')}>
          {tool}
        </span>
        <span className="min-w-0 flex-1 truncate text-zinc-300" title={call?.summary}>
          {call?.summary || (call ? '' : 'result')}
        </span>
        {pending && <span className="pk-live size-1.5 shrink-0 rounded-full bg-amber-400" title="Running" />}
        <span className="shrink-0 text-[10px] text-zinc-600">{clockTime((call ?? result)!.at)}</span>
        {hasOutput && <span className="shrink-0 text-zinc-600">{open ? '▾' : '▸'}</span>}
      </button>
      {open && hasOutput && (
        <div className="border-t border-white/[0.05] px-2.5 py-2">
          {call?.detail && <pre className="mb-2 whitespace-pre-wrap break-words text-zinc-400">$ {call.detail}</pre>}
          {result?.output?.trim() && (
            <pre className={cx('max-h-80 overflow-auto whitespace-pre-wrap break-words', error ? 'text-red-200' : 'text-zinc-500')}>
              {result.output}
            </pre>
          )}
          {result?.more ? <p className="mt-1 text-[10.5px] text-zinc-600">… {result.more} more lines</p> : null}
        </div>
      )}
    </div>
  );
}
