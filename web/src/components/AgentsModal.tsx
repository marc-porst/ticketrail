import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { apiFor } from '../lib/api.ts';
import { cx } from '../lib/ui.ts';
import {
  AGENT_TEMPLATES,
  isSkillName,
  MAX_SKILL_DESCRIPTION,
  parseFrontmatter,
  type Agent,
  type AgentSummary,
} from '../lib/types.ts';
import { DocMarkdown } from './DocMarkdown.tsx';

type Api = ReturnType<typeof apiFor>;
type Mode = 'view' | 'edit' | 'new';

/**
 * The project's agents: `.claude/agents/<name>.md`, Claude Code subagents. A
 * card assigned to one is handed to it by the worker. Read, edit with a live
 * preview, create from a starter, delete.
 */
export function AgentsModal({
  api,
  onClose,
  onChanged,
}: {
  api: Api;
  onClose: () => void;
  onChanged?: (agents: AgentSummary[]) => void;
}) {
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [mode, setMode] = useState<Mode>('view');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** Something that would throw away unsaved edits, held until the user says so. */
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);

  const dirty = mode === 'edit' && agent !== null && draft !== agent.raw;

  const reloadList = useCallback(async () => {
    try {
      const found = await api.agents();
      // an older server answers this route with something that is not a list
      const list = Array.isArray(found) ? found : [];
      setAgents(list);
      onChanged?.(list);
      return list;
    } catch (err) {
      setError((err as Error).message);
      return null;
    }
  }, [api, onChanged]);

  const open = useCallback(
    async (name: string, then: Mode = 'view') => {
      setSelected(name);
      setConfirmDelete(false);
      setConflict(false);
      try {
        const loaded = await api.agent(name);
        setAgent(loaded);
        setDraft(loaded.raw);
        setMode(then);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [api],
  );

  useEffect(() => {
    void reloadList().then((list) => {
      if (list?.length) void open(list[0].name);
      else if (list) setMode('new');
    });
  }, [reloadList, open]);

  // another editor (or Claude) may have touched the files while we were away
  useEffect(() => {
    const onFocus = () => {
      void reloadList();
      if (selected && mode === 'view') void open(selected);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reloadList, open, selected, mode]);

  const leave = useCallback(
    (action: () => void) => {
      if (dirty) setPendingLeave(() => action);
      else action();
    },
    [dirty],
  );

  const save = useCallback(
    async (force = false) => {
      if (!agent || saving) return;
      setSaving(true);
      try {
        const saved = await api.saveAgent(agent.name, draft, agent.version, force);
        setAgent(saved);
        setDraft(saved.raw);
        setConflict(false);
        setMode('view');
        void reloadList();
      } catch (err) {
        if ((err as { status?: number }).status === 409) setConflict(true);
        else setError((err as Error).message);
      } finally {
        setSaving(false);
      }
    },
    [api, agent, draft, saving, reloadList],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && mode === 'edit') {
        e.preventDefault();
        void save();
        return;
      }
      if (e.key !== 'Escape') return;
      if (pendingLeave) return setPendingLeave(null);
      if (confirmDelete) return setConfirmDelete(false);
      if (mode === 'edit') return leave(() => (setDraft(agent?.raw ?? ''), setMode('view')));
      leave(onClose);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, save, leave, onClose, agent, pendingLeave, confirmDelete]);

  const remove = async () => {
    if (!agent) return;
    try {
      await api.deleteAgent(agent.name);
      setAgent(null);
      setSelected(null);
      setConfirmDelete(false);
      const list = await reloadList();
      if (list?.length) void open(list[0].name);
      else setMode('new');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4 sm:p-6" role="dialog" aria-modal="true" aria-label="Agents">
      <div className="pk-scrim absolute inset-0" onClick={() => leave(onClose)} />

      <div className="relative flex h-[85vh] w-full max-w-[1100px] flex-col overflow-hidden rounded-2xl border border-white/[0.07] bg-[var(--color-surface-1)] pk-panel">
        <header className="flex items-baseline gap-3 border-b border-[var(--color-line)] px-5 py-4">
          <h2 className="text-[15px] font-semibold tracking-tight text-zinc-100">Agents</h2>
          <p className="hidden text-[11px] text-zinc-600 sm:block">
            This project's <code className="font-mono">.claude/agents</code> — assign one to a card and the worker hands
            the card to it
          </p>
          <button
            onClick={() => leave(onClose)}
            className="ml-auto rounded-md p-1 text-zinc-500 hover:bg-white/5 hover:text-zinc-200"
            aria-label="Close"
          >
            <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        {error && (
          <div className="flex items-start gap-3 border-b border-red-900/50 bg-red-950/40 px-5 py-2.5 text-[12px] leading-relaxed text-red-200">
            <span className="min-w-0 flex-1">{error}</span>
            <button onClick={() => setError(null)} className="shrink-0 text-red-300 hover:text-red-100">
              Dismiss
            </button>
          </div>
        )}

        {pendingLeave && (
          <div className="flex items-center gap-3 border-b border-amber-900/50 bg-amber-950/30 px-5 py-2.5 text-[12px] text-amber-100">
            <span className="min-w-0 flex-1">You have unsaved changes to {agent?.name}.</span>
            <button
              onClick={() => {
                const action = pendingLeave;
                setPendingLeave(null);
                setDraft(agent?.raw ?? '');
                setMode('view');
                action();
              }}
              className="rounded-md bg-amber-400/15 px-2 py-1 text-[11px] font-medium text-amber-200 hover:bg-amber-400/25"
            >
              Discard changes
            </button>
            <button onClick={() => setPendingLeave(null)} className="text-[11px] text-amber-300/80 hover:text-amber-100">
              Keep editing
            </button>
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          <aside className="flex w-[260px] shrink-0 flex-col border-r border-[var(--color-line)] bg-[var(--color-surface-0)]/40">
            <ul className="min-h-0 flex-1 overflow-y-auto p-2" aria-label="Agent list">
              {agents === null && <li className="px-2 py-3 text-[12px] text-zinc-600">Loading…</li>}
              {agents?.length === 0 && <li className="px-2 py-3 text-[12px] text-zinc-600">No agents yet.</li>}
              {agents?.map((a) => (
                <li key={a.name}>
                  <button
                    onClick={() => leave(() => void open(a.name))}
                    aria-current={a.name === selected && mode !== 'new' ? 'true' : undefined}
                    className={cx(
                      'w-full rounded-lg px-2.5 py-2 text-left transition',
                      a.name === selected && mode !== 'new' ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]',
                    )}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="truncate font-mono text-[12.5px] font-medium text-zinc-100">{a.name}</span>
                      {a.model && (
                        <span className="shrink-0 rounded bg-violet-400/10 px-1 py-px text-[9.5px] font-medium text-violet-300">
                          {a.model}
                        </span>
                      )}
                      {a.readonly && (
                        <span className="shrink-0 rounded bg-zinc-500/15 px-1 py-px text-[9.5px] font-medium text-zinc-400">linked</span>
                      )}
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug text-zinc-500">
                      {a.description || 'No description'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="border-t border-[var(--color-line)] p-2">
              <button
                onClick={() => leave(() => (setMode('new'), setSelected(null), setConfirmDelete(false)))}
                className={cx(
                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] font-medium transition',
                  mode === 'new' ? 'bg-sky-500/15 text-sky-200' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-100',
                )}
              >
                <span className="text-[15px] leading-none">+</span> New agent
              </button>
            </div>
          </aside>

          <section className="flex min-w-0 flex-1 flex-col">
            {mode === 'new' ? (
              <NewAgent
                api={api}
                empty={agents?.length === 0}
                taken={(name) => !!agents?.some((a) => a.name === name)}
                onCreated={async (created) => {
                  await reloadList();
                  setSelected(created.name);
                  setAgent(created);
                  setDraft(created.raw);
                  setMode('edit');
                }}
                onError={setError}
              />
            ) : agent ? (
              <>
                <div className="flex items-center gap-2 border-b border-[var(--color-line)] px-5 py-2.5">
                  <span className="min-w-0 truncate font-mono text-[11px] text-zinc-600" title={agent.path}>
                    .claude/agents/{agent.name}.md
                  </span>
                  <div className="ml-auto flex shrink-0 items-center gap-1.5">
                    {mode === 'view' ? (
                      <>
                        <button
                          onClick={() => {
                            setDraft(agent.raw);
                            setMode('edit');
                          }}
                          disabled={agent.readonly}
                          title={agent.readonly ? 'This agent is a symlink; edit it where it lives' : undefined}
                          className="rounded-md bg-white/[0.06] px-2.5 py-1 text-[11.5px] font-medium text-zinc-200 transition hover:bg-white/10 disabled:opacity-40"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => setConfirmDelete(true)}
                          disabled={agent.readonly}
                          className="rounded-md px-2.5 py-1 text-[11.5px] text-zinc-500 transition hover:bg-red-500/10 hover:text-red-300 disabled:opacity-40"
                        >
                          Delete
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="mr-1 text-[10.5px] text-zinc-600">{dirty ? 'Unsaved changes' : 'No changes'} · ⌘S</span>
                        <button
                          onClick={() => leave(() => (setDraft(agent.raw), setMode('view')))}
                          className="rounded-md px-2.5 py-1 text-[11.5px] text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => void save()}
                          disabled={saving || !dirty}
                          className="rounded-md bg-sky-500 px-3 py-1 text-[11.5px] font-medium text-sky-950 transition hover:bg-sky-400 disabled:opacity-40"
                        >
                          {saving ? 'Saving…' : 'Save'}
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {confirmDelete && (
                  <div className="flex items-center gap-3 border-b border-red-900/50 bg-red-950/30 px-5 py-2.5 text-[12px] text-red-100">
                    <span className="min-w-0 flex-1">
                      Delete <strong className="font-mono">{agent.name}</strong>? Cards assigned to it go back to you when a
                      worker picks them up.
                    </span>
                    <button
                      onClick={() => void remove()}
                      className="rounded-md bg-red-500/20 px-2 py-1 text-[11px] font-medium text-red-200 hover:bg-red-500/30"
                    >
                      Delete agent
                    </button>
                    <button onClick={() => setConfirmDelete(false)} className="text-[11px] text-red-300/80 hover:text-red-100">
                      Cancel
                    </button>
                  </div>
                )}

                {conflict && (
                  <div className="flex items-center gap-3 border-b border-amber-900/50 bg-amber-950/30 px-5 py-2.5 text-[12px] text-amber-100">
                    <span className="min-w-0 flex-1">This file changed on disk since you opened it.</span>
                    <button
                      onClick={() => void open(agent.name, 'edit')}
                      className="rounded-md bg-amber-400/15 px-2 py-1 text-[11px] font-medium text-amber-200 hover:bg-amber-400/25"
                    >
                      Reload (discard mine)
                    </button>
                    <button onClick={() => void save(true)} className="text-[11px] text-amber-300/80 hover:text-amber-100">
                      Overwrite
                    </button>
                  </div>
                )}

                {mode === 'view' ? (
                  <div className="min-h-0 flex-1 overflow-y-auto px-8 py-7">
                    <AgentView raw={agent.raw} name={agent.name} />
                  </div>
                ) : (
                  <AgentEditor draft={draft} onChange={setDraft} name={agent.name} />
                )}
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center text-[12px] text-zinc-600">
                {agents === null ? 'Loading…' : 'Pick an agent on the left.'}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/** The frontmatter as a header card, then the system prompt. */
function AgentView({ raw, name }: { raw: string; name: string }) {
  const { frontmatter, body, valid } = parseFrontmatter(raw);
  const { name: declared, description, ...rest } = frontmatter;
  const extras = Object.entries(rest);

  return (
    <article className="mx-auto max-w-[72ch]">
      <header className="mb-7 rounded-xl border border-[var(--color-line)] bg-gradient-to-b from-white/[0.035] to-transparent px-5 py-4">
        <div className="flex items-center gap-2">
          <h1 className="font-mono text-[17px] font-semibold tracking-tight text-zinc-50">{declared || name}</h1>
          {declared && declared !== name && (
            <span className="rounded bg-amber-400/10 px-1.5 py-px text-[10px] text-amber-300" title="The frontmatter name differs from the file name">
              file: {name}.md
            </span>
          )}
        </div>
        {description ? (
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-zinc-300">{description}</p>
        ) : (
          <p className="mt-1.5 text-[12.5px] text-amber-300/90">No description. It says what this agent is for.</p>
        )}
        {extras.length > 0 && (
          <dl className="mt-3 flex flex-wrap gap-1.5">
            {extras.map(([key, value]) => (
              <div key={key} className="flex items-baseline gap-1.5 rounded-md border border-[var(--color-line)] bg-black/25 px-2 py-1 text-[11px]">
                <dt className="font-mono text-zinc-500">{key}</dt>
                <dd className="font-mono text-zinc-200">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {!valid && (
          <p className="mt-3 text-[11.5px] text-amber-300/90">Part of the frontmatter could not be read; check the YAML.</p>
        )}
      </header>

      <h2 className="mb-2 text-[10.5px] font-medium tracking-wide text-zinc-600 uppercase">System prompt</h2>
      <DocMarkdown empty="This agent has no instructions yet.">{body}</DocMarkdown>
    </article>
  );
}

/** The whole file on the left, how it will read on the right. */
function AgentEditor({ draft, onChange, name }: { draft: string; onChange: (v: string) => void; name: string }) {
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => area.current?.focus(), []);

  return (
    <div className="flex min-h-0 flex-1">
      <textarea
        ref={area}
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        aria-label={`Contents of ${name}`}
        className="min-h-0 flex-1 resize-none border-r border-[var(--color-line)] bg-black/30 px-5 py-4 font-mono text-[12.5px] leading-[1.65] text-zinc-200 outline-none"
      />
      <div className="hidden min-h-0 flex-1 overflow-y-auto px-7 py-6 lg:block" aria-label="Preview">
        <AgentView raw={draft} name={name} />
      </div>
    </div>
  );
}

function NewAgent({
  api,
  empty,
  taken,
  onCreated,
  onError,
}: {
  api: Api;
  empty: boolean;
  taken: (name: string) => boolean;
  onCreated: (agent: Agent) => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const [template, setTemplate] = useState('blank');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const templates = useMemo(() => Object.entries(AGENT_TEMPLATES), []);

  const pick = (id: string) => {
    setTemplate(id);
    // only replace text the user has not changed from a starter
    const starter = templates.some(([, t]) => t.description === description);
    if (!description || starter) setDescription(AGENT_TEMPLATES[id].description);
    if (!name && id !== 'blank') setName(id);
  };

  const nameProblem = !name
    ? null
    : !isSkillName(name)
      ? 'Lowercase letters, digits and single hyphens; start with a letter or digit; at most 64 characters.'
      : taken(name)
        ? 'An agent with this name already exists.'
        : null;
  const ready = !!name && !nameProblem && !!description.trim() && description.length <= MAX_SKILL_DESCRIPTION;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      await onCreated(await api.createAgent({ name, description, template }));
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-8 py-8">
      <form
        className="mx-auto flex max-w-[520px] flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div>
          <h3 className="text-[17px] font-semibold tracking-tight text-zinc-100">
            {empty ? 'No agents in this project yet' : 'New agent'}
          </h3>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-zinc-500">
            An agent is a Claude Code subagent: a role with its own instructions. Assign it to a card and the worker hands
            that card to it. It is created as{' '}
            <code className="font-mono text-zinc-400">.claude/agents/{name || '<name>'}.md</code>. An agent created while
            a worker is running is used from the worker's next session, or followed as instructions until then.
          </p>
        </div>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-[11.5px] font-medium text-zinc-400">Start from</legend>
          <div className="flex flex-wrap gap-1.5">
            {templates.map(([id, t]) => (
              <button
                key={id}
                type="button"
                onClick={() => pick(id)}
                aria-pressed={template === id}
                className={cx(
                  'rounded-full border px-2.5 py-1 text-[11.5px] transition',
                  template === id
                    ? 'border-sky-600 bg-sky-500/15 text-sky-200'
                    : 'border-[var(--color-line)] text-zinc-400 hover:border-zinc-600 hover:text-zinc-200',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="flex flex-col gap-1.5">
          <span className="text-[11.5px] font-medium text-zinc-400">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, '-'))}
            placeholder="reviewer"
            autoFocus
            maxLength={64}
            aria-invalid={!!nameProblem}
            className={cx(
              'rounded-md border bg-black/30 px-2.5 py-1.5 font-mono text-[13px] text-zinc-100 outline-none placeholder:text-zinc-700',
              nameProblem ? 'border-red-700 focus:border-red-500' : 'border-[var(--color-line)] focus:border-sky-600',
            )}
          />
          {nameProblem && <span className="text-[11px] text-red-300">{nameProblem}</span>}
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[11.5px] font-medium text-zinc-400">Description</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            maxLength={MAX_SKILL_DESCRIPTION}
            placeholder="What this agent is for, e.g. “Reviews code changes for bugs. Use for review cards.”"
            className="resize-y rounded-md border border-[var(--color-line)] bg-black/30 px-2.5 py-2 text-[12.5px] leading-relaxed text-zinc-100 outline-none placeholder:text-zinc-700 focus:border-sky-600"
          />
        </label>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={!ready || busy}
            className="rounded-md bg-sky-500 px-3.5 py-1.5 text-[12px] font-medium text-sky-950 transition hover:bg-sky-400 disabled:opacity-40"
          >
            {busy ? 'Creating…' : empty ? 'Create your first agent' : 'Create agent'}
          </button>
          <span className="text-[11px] text-zinc-600">Opens in the editor.</span>
        </div>
      </form>
    </div>
  );
}
