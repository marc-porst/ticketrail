import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { apiFor } from '../lib/api.ts';
import { cx } from '../lib/ui.ts';
import {
  isSkillName,
  MAX_SKILL_DESCRIPTION,
  parseFrontmatter,
  type ImportResult,
  type RepoScan,
  type Skill,
  type SkillSummary,
} from '../lib/types.ts';
import { DocMarkdown } from './DocMarkdown.tsx';

type Api = ReturnType<typeof apiFor>;
type Mode = 'view' | 'edit' | 'new' | 'import' | 'manage';

/**
 * The project's skills: `.claude/skills/<name>/SKILL.md`. Read them rendered,
 * edit the whole file with a live preview, create new ones, delete old ones.
 */
export function SkillsModal({
  api,
  onClose,
  onChanged,
}: {
  api: Api;
  onClose: () => void;
  onChanged?: (skills: SkillSummary[]) => void;
}) {
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [skill, setSkill] = useState<Skill | null>(null);
  const [mode, setMode] = useState<Mode>('view');
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** Something that would throw away unsaved edits, held until the user says so. */
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);

  const dirty = mode === 'edit' && skill !== null && draft !== skill.raw;

  const reloadList = useCallback(async () => {
    try {
      const list = await api.skills();
      setSkills(list);
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
        const loaded = await api.skill(name);
        setSkill(loaded);
        setDraft(loaded.raw);
        setMode(then);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [api],
  );

  // first load: the list, then the first skill in it
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

  /** Run `action` now, or once the user agrees to drop their edits. */
  const leave = useCallback(
    (action: () => void) => {
      if (dirty) setPendingLeave(() => action);
      else action();
    },
    [dirty],
  );

  const save = useCallback(
    async (force = false) => {
      if (!skill || saving) return;
      setSaving(true);
      try {
        const saved = await api.saveSkill(skill.name, draft, skill.version, force);
        setSkill(saved);
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
    [api, skill, draft, saving, reloadList],
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
      if (mode === 'edit') return leave(() => (setDraft(skill?.raw ?? ''), setMode('view')));
      leave(onClose);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, save, leave, onClose, skill, pendingLeave, confirmDelete]);

  const remove = async () => {
    if (!skill) return;
    try {
      await api.deleteSkill(skill.name);
      setSkill(null);
      setSelected(null);
      setConfirmDelete(false);
      const list = await reloadList();
      if (list?.length) void open(list[0].name);
      else setMode('new');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !skills) return skills ?? [];
    return skills.filter((s) => s.name.includes(q) || s.description.toLowerCase().includes(q));
  }, [skills, query]);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4 sm:p-6" role="dialog" aria-modal="true" aria-label="Skills">
      <div className="pk-scrim absolute inset-0" onClick={() => leave(onClose)} />

      <div className="relative flex h-[85vh] w-full max-w-[1100px] flex-col overflow-hidden rounded-2xl border border-white/[0.07] bg-[var(--color-surface-1)] pk-panel">
        <header className="flex items-baseline gap-3 border-b border-[var(--color-line)] px-5 py-4">
          <h2 className="text-[15px] font-semibold tracking-tight text-zinc-100">Skills</h2>
          <p className="hidden text-[11px] text-zinc-600 sm:block">
            This project's <code className="font-mono">.claude/skills</code> — Claude loads them when a task fits
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
            <span className="min-w-0 flex-1">You have unsaved changes to {skill?.name}.</span>
            <button
              onClick={() => {
                const action = pendingLeave;
                setPendingLeave(null);
                setDraft(skill?.raw ?? '');
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
            <div className="p-3">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter skills"
                aria-label="Filter skills"
                className="w-full rounded-md border border-[var(--color-line)] bg-black/30 px-2.5 py-1.5 text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-sky-600"
              />
            </div>
            <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-label="Skill list">
              {skills === null && <li className="px-2 py-3 text-[12px] text-zinc-600">Loading…</li>}
              {skills !== null && filtered.length === 0 && (
                <li className="px-2 py-3 text-[12px] text-zinc-600">{skills.length ? 'No match.' : 'No skills yet.'}</li>
              )}
              {filtered.map((s) => (
                <li key={s.name}>
                  <button
                    onClick={() => leave(() => void open(s.name))}
                    aria-current={s.name === selected && (mode === 'view' || mode === 'edit') ? 'true' : undefined}
                    className={cx(
                      'w-full rounded-lg px-2.5 py-2 text-left transition',
                      s.name === selected && (mode === 'view' || mode === 'edit') ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]',
                    )}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="truncate font-mono text-[12.5px] font-medium text-zinc-100">{s.name}</span>
                      {s.managed && (
                        <span className="shrink-0 rounded bg-sky-400/10 px-1 py-px text-[9.5px] font-medium text-sky-300">managed</span>
                      )}
                      {s.readonly && (
                        <span className="shrink-0 rounded bg-zinc-500/15 px-1 py-px text-[9.5px] font-medium text-zinc-400">linked</span>
                      )}
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug text-zinc-500">
                      {s.description || 'No description'}
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
                <span className="text-[15px] leading-none">+</span> New skill
              </button>
              <button
                onClick={() => leave(() => (setMode('import'), setSelected(null), setConfirmDelete(false)))}
                className={cx(
                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] font-medium transition',
                  mode === 'import' ? 'bg-sky-500/15 text-sky-200' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-100',
                )}
              >
                <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M3 13h10" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Import from git
              </button>
              <button
                onClick={() => leave(() => (setMode('manage'), setSelected(null), setConfirmDelete(false)))}
                disabled={!skills?.length}
                className={cx(
                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] font-medium transition disabled:opacity-40',
                  mode === 'manage' ? 'bg-sky-500/15 text-sky-200' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-100',
                )}
              >
                <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
                  <path d="M5.5 8l1.8 1.8L10.5 6.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Select &amp; delete
              </button>
            </div>
          </aside>

          <section className="flex min-w-0 flex-1 flex-col">
            {mode === 'manage' ? (
              <ManageSkills
                api={api}
                skills={skills ?? []}
                onDeleted={async () => {
                  const list = await reloadList();
                  if (!list?.length) setMode('new');
                }}
                onError={setError}
              />
            ) : mode === 'import' ? (
              <ImportSkills
                api={api}
                // stay on the import pane: its summary says what was skipped and why
                onImported={async () => {
                  await reloadList();
                }}
                onError={setError}
              />
            ) : mode === 'new' ? (
              <NewSkill
                api={api}
                empty={skills?.length === 0}
                taken={(name) => !!skills?.some((s) => s.name === name)}
                onCreated={async (created) => {
                  await reloadList();
                  setSelected(created.name);
                  setSkill(created);
                  setDraft(created.raw);
                  setMode('edit');
                }}
                onError={setError}
              />
            ) : skill ? (
              <>
                <div className="flex items-center gap-2 border-b border-[var(--color-line)] px-5 py-2.5">
                  <span className="min-w-0 truncate font-mono text-[11px] text-zinc-600" title={skill.path}>
                    .claude/skills/{skill.name}/SKILL.md
                  </span>
                  <button
                    onClick={() => void navigator.clipboard?.writeText(skill.path)}
                    className="shrink-0 rounded px-1.5 py-0.5 text-[10.5px] text-zinc-600 hover:bg-white/5 hover:text-zinc-300"
                    title="Copy the full path"
                  >
                    Copy path
                  </button>
                  <div className="ml-auto flex shrink-0 items-center gap-1.5">
                    {mode === 'view' ? (
                      <>
                        <button
                          onClick={() => {
                            setDraft(skill.raw);
                            setMode('edit');
                          }}
                          disabled={skill.readonly}
                          title={skill.readonly ? 'This skill is a symlink; edit it where it lives' : undefined}
                          className="rounded-md bg-white/[0.06] px-2.5 py-1 text-[11.5px] font-medium text-zinc-200 transition hover:bg-white/10 disabled:opacity-40"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => setConfirmDelete(true)}
                          disabled={skill.readonly || skill.managed}
                          title={skill.managed ? 'Comes with Ticketrail; /ticketrail-work depends on it' : undefined}
                          className="rounded-md px-2.5 py-1 text-[11.5px] text-zinc-500 transition hover:bg-red-500/10 hover:text-red-300 disabled:opacity-40"
                        >
                          Delete
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="mr-1 text-[10.5px] text-zinc-600">{dirty ? 'Unsaved changes' : 'No changes'} · ⌘S</span>
                        <button
                          onClick={() => leave(() => (setDraft(skill.raw), setMode('view')))}
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
                      Delete <strong className="font-mono">{skill.name}</strong>
                      {skill.files.length ? ` and its ${skill.files.length} other file${skill.files.length === 1 ? '' : 's'}` : ''}?
                    </span>
                    <button
                      onClick={() => void remove()}
                      className="rounded-md bg-red-500/20 px-2 py-1 text-[11px] font-medium text-red-200 hover:bg-red-500/30"
                    >
                      Delete skill
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
                      onClick={() => void open(skill.name, 'edit')}
                      className="rounded-md bg-amber-400/15 px-2 py-1 text-[11px] font-medium text-amber-200 hover:bg-amber-400/25"
                    >
                      Reload (discard mine)
                    </button>
                    <button onClick={() => void save(true)} className="text-[11px] text-amber-300/80 hover:text-amber-100">
                      Overwrite
                    </button>
                  </div>
                )}

                {mode === 'edit' && skill.managed && (
                  <p className="border-b border-[var(--color-line)] bg-sky-950/20 px-5 py-2 text-[11.5px] text-sky-200/80">
                    Ticketrail installs this skill. <code className="font-mono">ticketrail init --force</code> will
                    overwrite your edits.
                  </p>
                )}

                {mode === 'view' ? (
                  <div className="min-h-0 flex-1 overflow-y-auto px-8 py-7">
                    <SkillView raw={skill.raw} name={skill.name} files={skill.files} />
                  </div>
                ) : (
                  <SkillEditor draft={draft} onChange={setDraft} name={skill.name} />
                )}
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center text-[12px] text-zinc-600">
                {skills === null ? 'Loading…' : 'Pick a skill on the left.'}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/** The frontmatter as a header card, then the body as a proper document. */
function SkillView({ raw, name, files }: { raw: string; name: string; files: string[] }) {
  const { frontmatter, body, valid } = parseFrontmatter(raw);
  const { name: declared, description, ...rest } = frontmatter;
  const extras = Object.entries(rest);

  return (
    <article className="mx-auto max-w-[72ch]">
      <header className="mb-7 rounded-xl border border-[var(--color-line)] bg-gradient-to-b from-white/[0.035] to-transparent px-5 py-4">
        <div className="flex items-center gap-2">
          <h1 className="font-mono text-[17px] font-semibold tracking-tight text-zinc-50">{declared || name}</h1>
          {declared && declared !== name && (
            <span className="rounded bg-amber-400/10 px-1.5 py-px text-[10px] text-amber-300" title="The frontmatter name differs from the folder name">
              folder: {name}
            </span>
          )}
        </div>
        {description ? (
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-zinc-300">{description}</p>
        ) : (
          <p className="mt-1.5 text-[12.5px] text-amber-300/90">
            No description. Claude uses the description to decide when to load this skill.
          </p>
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

      <DocMarkdown empty="This skill has no instructions yet.">
        {body}
      </DocMarkdown>

      {files.length > 0 && (
        <footer className="mt-10 border-t border-[var(--color-line)] pt-4">
          <h2 className="mb-2 text-[10.5px] font-medium tracking-wide text-zinc-600 uppercase">Other files in this skill</h2>
          <ul className="flex flex-wrap gap-1.5">
            {files.map((f) => (
              <li key={f} className="rounded-md bg-white/[0.04] px-2 py-0.5 font-mono text-[11px] text-zinc-400">
                {f}
              </li>
            ))}
          </ul>
        </footer>
      )}
    </article>
  );
}

/** The whole file on the left, how it will read on the right. */
function SkillEditor({ draft, onChange, name }: { draft: string; onChange: (v: string) => void; name: string }) {
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => area.current?.focus(), []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex gap-1 border-b border-[var(--color-line)] px-4 py-1.5 lg:hidden">
        {(['write', 'preview'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cx('rounded px-2 py-0.5 text-[11px] capitalize', tab === t ? 'bg-white/10 text-zinc-100' : 'text-zinc-500')}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1">
        <textarea
          ref={area}
          value={draft}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          aria-label={`Contents of ${name}`}
          className={cx(
            'min-h-0 flex-1 resize-none border-r border-[var(--color-line)] bg-black/30 px-5 py-4 font-mono text-[12.5px] leading-[1.65] text-zinc-200 outline-none',
            tab === 'preview' && 'hidden lg:block',
          )}
          onKeyDown={(e) => {
            // a tab key that indents instead of leaving the editor
            if (e.key !== 'Tab' || e.shiftKey) return;
            e.preventDefault();
            const el = e.currentTarget;
            const { selectionStart: start, selectionEnd: end } = el;
            onChange(draft.slice(0, start) + '  ' + draft.slice(end));
            requestAnimationFrame(() => el.setSelectionRange(start + 2, start + 2));
          }}
        />
        <div className={cx('min-h-0 flex-1 overflow-y-auto px-7 py-6', tab === 'write' && 'hidden lg:block')} aria-label="Preview">
          <SkillView raw={draft} name={name} files={[]} />
        </div>
      </div>
    </div>
  );
}

function NewSkill({
  api,
  empty,
  taken,
  onCreated,
  onError,
}: {
  api: Api;
  empty: boolean;
  taken: (name: string) => boolean;
  onCreated: (skill: Skill) => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  const nameProblem = !name
    ? null
    : !isSkillName(name)
      ? 'Lowercase letters, digits and single hyphens; start with a letter or digit; at most 64 characters.'
      : taken(name)
        ? 'A skill with this name already exists.'
        : null;
  const ready = !!name && !nameProblem && !!description.trim() && description.length <= MAX_SKILL_DESCRIPTION;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      await onCreated(await api.createSkill({ name, description }));
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
            {empty ? 'No skills in this project yet' : 'New skill'}
          </h3>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-zinc-500">
            A skill is a folder with a <code className="font-mono text-zinc-400">SKILL.md</code>: instructions Claude loads
            on its own when a task matches the description. It is created in{' '}
            <code className="font-mono text-zinc-400">.claude/skills/{name || '<name>'}/</code>.
          </p>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-[11.5px] font-medium text-zinc-400">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, '-'))}
            placeholder="release-notes"
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
            rows={4}
            maxLength={MAX_SKILL_DESCRIPTION}
            placeholder="What the skill does and when Claude should use it, e.g. “Write release notes from the git log. Use when the user asks for a changelog or release notes.”"
            className="resize-y rounded-md border border-[var(--color-line)] bg-black/30 px-2.5 py-2 text-[12.5px] leading-relaxed text-zinc-100 outline-none placeholder:text-zinc-700 focus:border-sky-600"
          />
          <span className="text-right text-[10.5px] text-zinc-700">
            {description.length}/{MAX_SKILL_DESCRIPTION}
          </span>
        </label>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={!ready || busy}
            className="rounded-md bg-sky-500 px-3.5 py-1.5 text-[12px] font-medium text-sky-950 transition hover:bg-sky-400 disabled:opacity-40"
          >
            {busy ? 'Creating…' : empty ? 'Create your first skill' : 'Create skill'}
          </button>
          <span className="text-[11px] text-zinc-600">Opens in the editor with a starter outline.</span>
        </div>
      </form>
    </div>
  );
}

/**
 * Paste a repository URL, see every skill in it, tick the ones to bring into
 * this project. The server clones; nothing is copied until Import.
 */
function ImportSkills({
  api,
  onImported,
  onError,
}: {
  api: Api;
  onImported: () => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const [url, setUrl] = useState('');
  const [scan, setScan] = useState<RepoScan | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState<'scan' | 'import' | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  // one copy per name: a repo that mirrors its skills (.factory/skills…) lists each twice
  const importable = scan?.skills.filter((s) => s.name && !s.duplicateOf) ?? [];
  const allPicked = importable.length > 0 && importable.every((s) => picked.has(s.path));
  const replacing = importable.filter((s) => picked.has(s.path) && s.exists).length;

  const load = async () => {
    if (!url.trim() || busy) return;
    setBusy('scan');
    setScan(null);
    setResult(null);
    try {
      const found = await api.scanSkillRepo(url.trim());
      setScan(found);
      // start with what can be added without replacing anything
      setPicked(new Set(found.skills.filter((s) => s.name && !s.exists && !s.duplicateOf).map((s) => s.path)));
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const toggle = (p: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  const run = async () => {
    if (!scan || !picked.size || busy) return;
    setBusy('import');
    try {
      const done = await api.importSkills(scan.id, [...picked], overwrite);
      setResult(done);
      setScan({
        ...scan,
        skills: scan.skills.map((s) => (s.name && done.imported.includes(s.name) ? { ...s, exists: true } : s)),
      });
      setPicked(new Set());
      await onImported();
    } catch (err) {
      onError((err as Error).message);
      // an expired scan cannot be imported from; make the user load it again
      if ((err as { status?: number }).status === 410) setScan(null);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        className="shrink-0 border-b border-[var(--color-line)] px-6 py-5"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <h3 className="text-[15px] font-semibold tracking-tight text-zinc-100">Import skills from git</h3>
        <p className="mt-1 text-[12px] leading-relaxed text-zinc-500">
          Paste a repository URL — or a link to a folder in it, like{' '}
          <code className="font-mono text-zinc-400">github.com/owner/repo/tree/main/skills</code>. Every folder with a{' '}
          <code className="font-mono text-zinc-400">SKILL.md</code> is listed; pick the ones to copy into this project.
        </p>
        <div className="mt-3 flex gap-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/owner/skills-repo"
            aria-label="Repository URL"
            autoFocus
            spellCheck={false}
            className="min-w-0 flex-1 rounded-md border border-[var(--color-line)] bg-black/30 px-2.5 py-1.5 font-mono text-[12.5px] text-zinc-100 outline-none placeholder:text-zinc-700 focus:border-sky-600"
          />
          <button
            type="submit"
            disabled={!url.trim() || !!busy}
            className="shrink-0 rounded-md bg-white/[0.08] px-3 py-1.5 text-[12px] font-medium text-zinc-100 transition hover:bg-white/[0.12] disabled:opacity-40"
          >
            {busy === 'scan' ? 'Cloning…' : scan ? 'Reload' : 'Load skills'}
          </button>
        </div>
      </form>

      {result && (
        // capped and scrollable: a long summary must not push the list off the dialog
        <div
          role="status"
          className="max-h-[22vh] shrink-0 overflow-y-auto border-b border-emerald-900/40 bg-emerald-950/25 px-6 py-2.5 text-[12px] text-emerald-100"
        >
          <div className="flex items-start gap-3">
            <span className="min-w-0 flex-1">
              {result.imported.length
                ? `Imported ${result.imported.length} skill${result.imported.length === 1 ? '' : 's'}: ${result.imported.join(', ')}.`
                : 'Nothing was imported.'}
            </span>
            <button onClick={() => setResult(null)} className="shrink-0 text-[11px] text-emerald-300/80 hover:text-emerald-100">
              Dismiss
            </button>
          </div>
          {result.skipped.length > 0 && (
            <ul className="mt-1 text-[11.5px] text-amber-200/90">
              {result.skipped.map((s) => (
                <li key={s.path}>
                  Skipped <span className="font-mono">{s.path}</span>: {s.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {scan && (
        <>
          <div className="flex shrink-0 items-center gap-3 border-b border-[var(--color-line)] px-6 py-2">
            <label className="flex items-center gap-2 text-[12px] text-zinc-300">
              <input
                type="checkbox"
                checked={allPicked}
                disabled={!importable.length}
                ref={(el) => {
                  if (el) el.indeterminate = picked.size > 0 && !allPicked;
                }}
                onChange={() => setPicked(allPicked ? new Set() : new Set(importable.map((s) => s.path)))}
                className="accent-sky-400"
              />
              {allPicked ? 'Deselect all' : 'Select all'}
            </label>
            <span className="text-[11px] text-zinc-600">
              {scan.skills.length} skill{scan.skills.length === 1 ? '' : 's'} in{' '}
              <span className="font-mono">{scan.repo.replace(/^https?:\/\//, '').replace(/\.git$/, '')}</span>
              {scan.ref && <span className="font-mono"> @ {scan.ref}</span>}
              {scan.subdir && <span className="font-mono"> / {scan.subdir}</span>}
              {scan.skills.length > importable.length && (
                <span> · {scan.skills.length - importable.length} duplicate or unnamed, left out of Select all</span>
              )}
            </span>
          </div>

          <ul className="min-h-0 flex-1 divide-y divide-[var(--color-line)] overflow-y-auto" aria-label="Skills in the repository">
            {scan.skills.length === 0 && (
              <li className="px-6 py-8 text-center text-[12px] text-zinc-600">No SKILL.md files in this repository.</li>
            )}
            {scan.skills.map((s) => (
              <li key={s.path}>
                <label
                  className={cx(
                    'flex items-start gap-3 px-6 py-3 transition',
                    s.name ? 'cursor-pointer hover:bg-white/[0.03]' : 'cursor-not-allowed opacity-50',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={picked.has(s.path)}
                    disabled={!s.name}
                    onChange={() => toggle(s.path)}
                    aria-label={`Import ${s.name ?? s.path}`}
                    className="mt-0.5 accent-sky-400"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-[12.5px] font-medium text-zinc-100">{s.name ?? 'unnamed'}</span>
                      {s.duplicateOf && (
                        <span
                          className="rounded bg-zinc-500/15 px-1 py-px text-[9.5px] font-medium text-zinc-400"
                          title={`The same skill is also at ${s.duplicateOf}; Select all takes that one`}
                        >
                          duplicate of {s.duplicateOf}
                        </span>
                      )}
                      {s.exists && (
                        <span className="rounded bg-amber-400/10 px-1 py-px text-[9.5px] font-medium text-amber-300">
                          already in project
                        </span>
                      )}
                      {s.files > 0 && (
                        <span className="text-[10.5px] text-zinc-600">
                          +{s.files} file{s.files === 1 ? '' : 's'}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-[11.5px] leading-snug text-zinc-500">
                      {s.description || 'No description'}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[10.5px] text-zinc-700">{s.path}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>

          <div className="flex shrink-0 items-center gap-3 border-t border-[var(--color-line)] px-6 py-3">
            <label className="flex items-center gap-2 text-[11.5px] text-zinc-400">
              <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} className="accent-amber-400" />
              Replace skills that already exist
            </label>
            {replacing > 0 && !overwrite && (
              <span className="text-[11px] text-amber-300/80">
                {replacing} selected skill{replacing === 1 ? '' : 's'} will be skipped
              </span>
            )}
            <button
              onClick={() => void run()}
              disabled={!picked.size || !!busy}
              className="ml-auto rounded-md bg-sky-500 px-3.5 py-1.5 text-[12px] font-medium text-sky-950 transition hover:bg-sky-400 disabled:opacity-40"
            >
              {busy === 'import' ? 'Importing…' : `Import ${picked.size || ''} skill${picked.size === 1 ? '' : 's'}`.replace('  ', ' ')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Every skill with a checkbox, so several can go at once. */
function ManageSkills({
  api,
  skills,
  onDeleted,
  onError,
}: {
  api: Api;
  skills: SkillSummary[];
  onDeleted: () => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ removed: string[]; failed: { name: string; reason: string }[] } | null>(null);

  // linked skills live elsewhere; Ticketrail's own are needed by /ticketrail-work
  const deletable = skills.filter((s) => !s.readonly && !s.managed);
  // a skill deleted elsewhere drops out of the selection
  const chosen = deletable.filter((s) => picked.has(s.name));
  const allPicked = deletable.length > 0 && chosen.length === deletable.length;

  const toggle = (name: string) => {
    setConfirming(false);
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const run = async () => {
    if (!chosen.length || busy) return;
    setBusy(true);
    try {
      const done = await api.deleteSkills(chosen.map((s) => s.name));
      setOutcome(done);
      setPicked(new Set());
      setConfirming(false);
      await onDeleted();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-[var(--color-line)] px-6 py-5">
        <h3 className="text-[15px] font-semibold tracking-tight text-zinc-100">Select &amp; delete</h3>
        <p className="mt-1 text-[12px] leading-relaxed text-zinc-500">
          Tick the skills to remove from this project. Each one's folder in{' '}
          <code className="font-mono text-zinc-400">.claude/skills</code> is deleted, with every file in it.
        </p>
      </div>

      {outcome && (
        <div
          role="status"
          className="max-h-[22vh] shrink-0 overflow-y-auto border-b border-emerald-900/40 bg-emerald-950/25 px-6 py-2.5 text-[12px] text-emerald-100"
        >
          <div className="flex items-start gap-3">
            <span className="min-w-0 flex-1">
              {outcome.removed.length
                ? `Deleted ${outcome.removed.length} skill${outcome.removed.length === 1 ? '' : 's'}: ${outcome.removed.join(', ')}.`
                : 'Nothing was deleted.'}
            </span>
            <button onClick={() => setOutcome(null)} className="shrink-0 text-[11px] text-emerald-300/80 hover:text-emerald-100">
              Dismiss
            </button>
          </div>
          {outcome.failed.length > 0 && (
            <ul className="mt-1 text-[11.5px] text-amber-200/90">
              {outcome.failed.map((f) => (
                <li key={f.name}>
                  Kept <span className="font-mono">{f.name}</span>: {f.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--color-line)] px-6 py-2">
        <label className="flex items-center gap-2 text-[12px] text-zinc-300">
          <input
            type="checkbox"
            checked={allPicked}
            disabled={!deletable.length}
            ref={(el) => {
              if (el) el.indeterminate = chosen.length > 0 && !allPicked;
            }}
            onChange={() => {
              setConfirming(false);
              setPicked(allPicked ? new Set() : new Set(deletable.map((s) => s.name)));
            }}
            className="accent-sky-400"
          />
          {allPicked ? 'Deselect all' : 'Select all'}
        </label>
        <span className="text-[11px] text-zinc-600">
          {chosen.length} of {skills.length} selected
          {skills.length > deletable.length &&
            ` · ${skills.length - deletable.length} protected (Ticketrail's own or linked) and cannot be deleted`}
        </span>
      </div>

      <ul className="min-h-0 flex-1 divide-y divide-[var(--color-line)] overflow-y-auto" aria-label="Skills to delete">
        {skills.map((s) => {
          const locked = s.readonly || s.managed;
          return (
            <li key={s.name}>
              <label
                className={cx(
                  'flex items-start gap-3 px-6 py-3 transition',
                  locked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-white/[0.03]',
                  picked.has(s.name) && !locked && 'bg-red-500/[0.04]',
                )}
              >
                <input
                  type="checkbox"
                  checked={picked.has(s.name) && !locked}
                  disabled={locked}
                  title={s.managed ? 'Comes with Ticketrail and cannot be deleted' : s.readonly ? 'A symlink; delete it where it lives' : undefined}
                  onChange={() => toggle(s.name)}
                  aria-label={`Select ${s.name}`}
                  className="mt-0.5 accent-red-400"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[12.5px] font-medium text-zinc-100">{s.name}</span>
                    {s.managed && (
                      <span className="rounded bg-sky-400/10 px-1 py-px text-[9.5px] font-medium text-sky-300">managed</span>
                    )}
                    {s.readonly && (
                      <span className="rounded bg-zinc-500/15 px-1 py-px text-[9.5px] font-medium text-zinc-400">linked</span>
                    )}
                    {s.files.length > 0 && (
                      <span className="text-[10.5px] text-zinc-600">
                        +{s.files.length} file{s.files.length === 1 ? '' : 's'}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-[11.5px] leading-snug text-zinc-500">
                    {s.description || 'No description'}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      <div className="flex shrink-0 items-center gap-3 border-t border-[var(--color-line)] px-6 py-3">
        {confirming ? (
          <>
            <span className="min-w-0 flex-1 text-[12px] text-red-100">
              Delete {chosen.length} skill{chosen.length === 1 ? '' : 's'} and all their files? This cannot be undone here.
            </span>
            <button onClick={() => setConfirming(false)} className="shrink-0 text-[11.5px] text-zinc-400 hover:text-zinc-100">
              Cancel
            </button>
            <button
              onClick={() => void run()}
              disabled={busy}
              className="shrink-0 rounded-md bg-red-500/80 px-3.5 py-1.5 text-[12px] font-medium text-white transition hover:bg-red-500 disabled:opacity-40"
            >
              {busy ? 'Deleting…' : `Yes, delete ${chosen.length}`}
            </button>
          </>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            disabled={!chosen.length}
            className="ml-auto rounded-md bg-red-500/15 px-3.5 py-1.5 text-[12px] font-medium text-red-200 transition hover:bg-red-500/25 disabled:opacity-40"
          >
            Delete {chosen.length || ''} skill{chosen.length === 1 ? '' : 's'}
          </button>
        )}
      </div>
    </div>
  );
}
