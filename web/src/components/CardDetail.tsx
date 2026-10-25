import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Markdown } from './Markdown.tsx';
import { Attachments } from './Attachments.tsx';
import { RelatedCards } from './RelatedCards.tsx';
import { ACCENT, FOLDER_TONE, clockTime, cx, labelTone, relativeTime } from '../lib/ui.ts';
import { hasPrintableContent, openPrintView } from '../lib/print.tsx';
import {
  COLUMN_LABELS,
  MAX_LABELS,
  MAX_LABEL_LENGTH,
  TASK_TYPES,
  TYPE_LABELS,
  isReadOnlyType,
  modelLabel,
  pendingQuestion,
  MAX_FOLDER_NAME,
  type Column,
  type AgentSummary,
  type WaitingWorker,
  type Folder,
  type PastResult,
  type Task,
  type TaskType,
} from '../lib/types.ts';

const SessionFeed = lazy(() => import('./SessionFeed.tsx').then((m) => ({ default: m.SessionFeed })));

type Tab = 'description' | 'plan' | 'result' | 'session' | 'related' | 'files' | 'activity' | 'chat';

const KIND_COLOR: Record<string, string> = {
  info: 'bg-zinc-600',
  file: 'bg-sky-500',
  test: 'bg-violet-500',
  status: 'bg-emerald-500',
  error: 'bg-red-500',
};

export function CardDetail({
  task,
  projectId,
  onClose,
  onPatch,
  onReply,
  onArchive,
  onUpload,
  onRemoveAttachment,
  onDerive,
  labelSuggestions,
  allTasks,
  onOpenCard,
  folders = [],
  onCreateFolder,
  agents = [],
  onManageAgents,
  workers = [],
}: {
  task: Task;
  projectId: string;
  onClose: () => void;
  onPatch: (
    changes: Partial<{
      title: string;
      description: string;
      plan: string | null;
      labels: string[];
      type: TaskType | null;
      related: string[];
      folder: string | null;
      agent: string | null;
      worker: string | null;
      column: Column;
    }>,
  ) => void;
  onReply: (text: string) => void;
  onArchive: () => void;
  onUpload: (files: File[]) => Promise<void>;
  onRemoveAttachment: (fileId: string) => void;
  onDerive: () => void;
  /** Every label already in use on this board, for the editor's suggestions. */
  labelSuggestions: string[];
  /** The board's cards, for linking related ones and finding backlinks. */
  allTasks: Task[];
  onOpenCard: (id: string) => void;
  folders?: Folder[];
  /** Resolves to the new folder, or null when it could not be made. */
  onCreateFolder?: (name: string) => Promise<Folder | null>;
  /** The project's agents (.claude/agents), offered in the agent picker. */
  agents?: AgentSummary[];
  /** Opens the Agents view from the agent picker. */
  onManageAgents?: () => void;
  /** Named workers waiting on this board right now, offered in the worker picker. */
  workers?: WaitingWorker[];
}) {
  const waiting = pendingQuestion(task);
  const running = task.column === 'in-progress';
  const referencedBy = allTasks.filter((t) => (t.related ?? []).includes(task.id)).length;
  const [tab, setTab] = useState<Tab>(() =>
    waiting
      ? 'chat'
      : running && task.session
        ? 'session'
        : task.result
          ? 'result'
          : task.plan
            ? 'plan'
            : 'description',
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const tabs = useMemo(
    () =>
      [
        { id: 'description' as const, label: 'Description' },
        { id: 'plan' as const, label: 'Plan', dot: Boolean(task.plan) },
        ...(task.result ? [{ id: 'result' as const, label: 'Result', done: true }] : []),
        ...(task.session || task.sessionHistory.length
          ? [{ id: 'session' as const, label: 'Session', live: running && task.session?.to === null }]
          : []),
        { id: 'related' as const, label: 'Related', count: (task.related ?? []).length + referencedBy },
        { id: 'files' as const, label: 'Files', count: task.attachments.length },
        { id: 'activity' as const, label: 'Activity', count: task.activity.length },
        { id: 'chat' as const, label: 'Chat', count: task.messages.length, alert: Boolean(waiting) },
      ] satisfies { id: Tab; label: string; count?: number; dot?: boolean; alert?: boolean; done?: boolean; live?: boolean }[],
    [task.plan, task.result, task.session, task.sessionHistory.length, running, task.related, referencedBy, task.attachments.length, task.activity.length, task.messages.length, waiting],
  );

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true">
      <div className="pk-scrim absolute inset-0" onClick={onClose} />

      <aside className="pk-drawer relative flex h-full w-full max-w-[580px] flex-col border-l border-white/[0.07] bg-[var(--color-surface-1)]">
        <header className="border-b border-[var(--color-line)] px-5 py-4">
          <div className="flex items-start gap-3">
            <span className="mt-1 font-mono text-[11px] text-zinc-600">#{task.number}</span>
            <EditableTitle value={task.title} onSave={(title) => onPatch({ title })} />
            <button onClick={onClose} className="mt-0.5 shrink-0 rounded-md p-1 text-zinc-500 hover:bg-white/5 hover:text-zinc-200" aria-label="Close">
              <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium', ACCENT[task.column].soft, ACCENT[task.column].text)}>
              <span className={cx('size-1.5 rounded-full', ACCENT[task.column].dot, task.column === 'in-progress' && 'pk-live')} />
              {COLUMN_LABELS[task.column]}
            </span>
            <span className="text-[11px] text-zinc-600">updated {relativeTime(task.updatedAt)}</span>
            <div className="ml-auto flex gap-1.5">
              <DownloadButton task={task} />
              <MoveButton label="→ Plan" active={task.column === 'plan'} onClick={() => onPatch({ column: 'plan' })} />
              {/* An investigation or a question never writes code, so Implement is not offered. */}
              {!isReadOnlyType(task.type) && (
                <MoveButton
                  label="→ Implement"
                  active={task.column === 'implement'}
                  onClick={() => onPatch({ column: 'implement' })}
                />
              )}
            </div>
          </div>

          {/* The card's properties as one even grid: a label over each value.
              Type, agent and worker are fixed while Claude works the card. */}
          <dl className="mt-3 grid grid-cols-2 gap-x-2 gap-y-2 rounded-lg border border-[var(--color-line)] bg-black/15 p-2 sm:grid-cols-4">
            <Property label="Type">
              <TypeSelect value={task.type} locked={running} onChange={(type) => onPatch({ type })} />
            </Property>
            <Property label="Folder">
              <FolderSelect
                value={task.folder}
                folders={folders}
                onChange={(folder) => onPatch({ folder })}
                onCreate={onCreateFolder}
              />
            </Property>
            <Property label="Agent">
              <AgentSelect
                value={task.agent}
                agents={agents}
                onChange={(agent) => onPatch({ agent })}
                onManage={onManageAgents}
                locked={running}
              />
            </Property>
            <Property label="Worker">
              <WorkerSelect
                value={task.worker ?? null}
                workers={workers}
                locked={running}
                onChange={(worker) => onPatch({ worker })}
              />
            </Property>
            <Property label="Labels" wide>
              <LabelEditor
                labels={task.labels}
                suggestions={labelSuggestions}
                onChange={(labels) => onPatch({ labels })}
              />
            </Property>
          </dl>
        </header>

        <nav className="pk-tabs flex overflow-x-auto border-b border-[var(--color-line)] px-3">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cx(
                'relative -mb-px flex shrink-0 items-center border-b-2 px-2 py-2.5 text-[12.5px] font-medium whitespace-nowrap transition',
                tab === t.id ? 'border-sky-400 text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-300',
              )}
            >
              {t.label}
              {'count' in t && t.count ? <span className="ml-1.5 text-[10.5px] text-zinc-600">{t.count}</span> : null}
              {'dot' in t && t.dot ? <span className="ml-1.5 inline-block size-1.5 rounded-full bg-indigo-400 align-middle" /> : null}
              {'alert' in t && t.alert ? <span className="ml-1.5 inline-block size-1.5 rounded-full bg-amber-400 align-middle pk-live" /> : null}
              {'done' in t && t.done ? <span className="ml-1.5 inline-block size-1.5 rounded-full bg-emerald-400 align-middle" /> : null}
              {'live' in t && t.live ? <span className="ml-1.5 inline-block size-1.5 rounded-full bg-emerald-400 align-middle pk-live" title="Live" /> : null}
            </button>
          ))}
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === 'description' && (
            <EditableMarkdown
              value={task.description}
              placeholder="What needs to happen? Claude reads this when no plan exists."
              onSave={(description) => onPatch({ description })}
            />
          )}

          {tab === 'plan' && (
            <EditableMarkdown
              value={task.plan ?? ''}
              placeholder="No plan yet. Drag this card to Plan and Claude will write one here."
              onSave={(plan) => onPatch({ plan: plan || null })}
              footer={
                task.plan && task.type === 'investigation' ? (
                  <div>
                    <button
                      onClick={onDerive}
                      className="rounded-md bg-sky-500/15 px-3 py-1.5 text-[12px] font-medium text-sky-300 transition hover:bg-sky-500/25"
                    >
                      Create implementation task
                    </button>
                    <p className="mt-1.5 text-[11.5px] text-zinc-500">
                      Adds a Feature card at the top of <span className="text-sky-300">Implement</span> with this plan
                      as its spec. This card stays where it is.
                    </p>
                  </div>
                ) : task.plan && task.column === 'planned' ? (
                  <p className="text-[11.5px] text-zinc-500">
                    Happy with it? Move the card to <span className="text-sky-300">Implement</span> and Claude builds
                    exactly this.
                  </p>
                ) : null
              }
            />
          )}

          {tab === 'result' && (
            <div className="p-5">
              <p className="mb-2 text-[10.5px] font-semibold tracking-wide text-emerald-400 uppercase">
                What Claude did
              </p>
              <Markdown empty="No summary was recorded.">{task.result ?? ''}</Markdown>
              {task.resultHistory.length > 0 && <ResultHistory history={task.resultHistory} />}
            </div>
          )}

          {tab === 'related' && (
            <RelatedCards
              task={task}
              allTasks={allTasks}
              onChange={(related) => onPatch({ related })}
              onOpenCard={onOpenCard}
            />
          )}

          {tab === 'files' && (
            <Attachments task={task} projectId={projectId} onUpload={onUpload} onRemove={onRemoveAttachment} />
          )}

          {tab === 'session' && (
            <Suspense fallback={null}>
              <SessionFeed task={task} projectId={projectId} />
            </Suspense>
          )}

          {tab === 'activity' && <ActivityFeed task={task} />}

          {tab === 'chat' && <Conversation task={task} onReply={onReply} />}
        </div>

        <footer className="flex items-center justify-between border-t border-[var(--color-line)] px-5 py-2.5">
          <span className="font-mono text-[10.5px] text-zinc-700">{task.id}</span>
          <button onClick={onArchive} className="text-[11.5px] text-zinc-600 transition hover:text-red-400">
            Archive card
          </button>
        </footer>
      </aside>
    </div>
  );
}

/** One labelled cell of the drawer's property grid. */
function Property({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={cx('min-w-0', wide && 'col-span-full border-t border-[var(--color-line)] pt-2')}>
      <dt className="px-2 pb-0.5 text-[9.5px] font-semibold tracking-wide text-zinc-600 uppercase">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/** A quiet select that fills its grid cell: no frame until you point at it. */
const FIELD =
  'w-full min-w-0 cursor-pointer truncate rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[12px] font-medium transition hover:border-zinc-700 hover:bg-white/[0.04] focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-transparent disabled:hover:bg-transparent';

const LOCKED_HINT = 'Locked while Claude works on this card. Leave a chat message instead.';

function TypeSelect({
  value,
  locked,
  onChange,
}: {
  value: TaskType | null;
  locked?: boolean;
  onChange: (type: TaskType | null) => void;
}) {
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange((e.target.value || null) as TaskType | null)}
      disabled={locked}
      title={locked ? LOCKED_HINT : undefined}
      aria-label="Type"
      className={cx(FIELD, value ? 'text-zinc-200' : 'text-zinc-500')}
    >
      <option value="">None</option>
      {TASK_TYPES.map((type) => (
        <option key={type} value={type}>
          {TYPE_LABELS[type]}
        </option>
      ))}
    </select>
  );
}

/**
 * Which folder the card sits in. Optional, like the type: "Folder —" is the
 * default and a perfectly good place for a card to stay.
 */
function FolderSelect({
  value,
  folders,
  onChange,
  onCreate,
}: {
  value: string | null;
  folders: Folder[];
  onChange: (folder: string | null) => void;
  onCreate?: (name: string) => Promise<Folder | null>;
}) {
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState('');
  const current = folders.find((f) => f.id === value) ?? null;

  if (naming) {
    const submit = async () => {
      const name = draft.trim();
      setNaming(false);
      setDraft('');
      if (!name || !onCreate) return;
      const folder = await onCreate(name);
      if (folder) onChange(folder.id);
    };
    return (
      <input
        autoFocus
        value={draft}
        maxLength={MAX_FOLDER_NAME}
        placeholder="Folder name"
        aria-label="New folder name"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void submit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
          if (e.key === 'Escape') {
            // stop here so Escape cancels the name, not the whole drawer
            e.nativeEvent.stopImmediatePropagation();
            setNaming(false);
            setDraft('');
          }
        }}
        className="w-full rounded-md border border-sky-500 bg-transparent px-1.5 py-1 text-[12px] text-zinc-200 focus:outline-none"
      />
    );
  }

  return (
    <span className="flex min-w-0 items-center gap-1">
      {current && <span className={cx('ml-1.5 size-2 shrink-0 rounded-sm', FOLDER_TONE[current.color].dot)} />}
      <select
        value={current?.id ?? ''}
        onChange={(e) => {
          if (e.target.value === '__new') return setNaming(true);
          onChange(e.target.value || null);
        }}
        aria-label="Folder"
        className={cx(FIELD, current ? 'text-zinc-200' : 'text-zinc-500')}
      >
        <option value="">None</option>
        {folders.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
        {onCreate && <option value="__new">New folder…</option>}
      </select>
    </span>
  );
}

/**
 * Which project agent works this card. "Agent —" means the worker does it
 * itself. It is always shown, even in a project with no agents yet, where it
 * offers to create one. An agent the card names but the project no longer has
 * stays listed, marked missing, so the select never silently shows something else.
 */
function AgentSelect({
  value,
  agents,
  onChange,
  onManage,
  locked,
}: {
  value: string | null;
  agents: AgentSummary[];
  onChange: (agent: string | null) => void;
  /** Opens the Agents view, to create or edit one. */
  onManage?: () => void;
  locked?: boolean;
}) {
  // a card from an older server has no agent field at all
  const missing = !!value && !agents.some((a) => a.name === value);
  return (
    <select
      value={value ?? ''}
      onChange={(e) => {
        if (e.target.value === '__manage') return onManage?.();
        onChange(e.target.value || null);
      }}
      aria-label="Agent"
      disabled={locked}
      title={
        locked
          ? LOCKED_HINT
          : missing
          ? `.claude/agents/${value}.md does not exist; the worker will hand this card back`
          : agents.length
            ? 'Hand this card to a project agent (.claude/agents)'
            : 'This project has no agents yet (.claude/agents)'
      }
      className={cx(FIELD, missing ? 'text-red-300' : value ? 'text-violet-300' : 'text-zinc-500')}
    >
      <option value="">{agents.length ? 'None' : 'None yet'}</option>
      {agents.map((a) => (
        <option key={a.name} value={a.name}>
          {a.name}
        </option>
      ))}
      {missing && <option value={value!}>{value} (missing)</option>}
      {onManage && <option value="__manage">{agents.length ? 'Manage agents…' : 'New agent…'}</option>}
    </select>
  );
}

/**
 * Which named worker may claim this card. "Worker — any" lets every worker
 * take it (subject to its own --only filter). The names offered are the
 * workers waiting now; a card can keep a name whose worker is offline.
 */
function WorkerSelect({
  value,
  workers,
  onChange,
  locked,
}: {
  value: string | null;
  workers: WaitingWorker[];
  onChange: (worker: string | null) => void;
  locked?: boolean;
}) {
  const named = [...new Map(workers.filter((w) => w.name).map((w) => [w.name!, w])).values()];
  const offline = !!value && !named.some((w) => w.name === value);
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      aria-label="Worker"
      disabled={locked}
      title={
        locked
          ? LOCKED_HINT
          : named.length || value
          ? 'Only this named worker may claim the card'
          : 'No named worker is running. Start one with /ticketrail-work <name> [--only label:x]'
      }
      className={cx(FIELD, value ? 'text-sky-300' : 'text-zinc-500')}
    >
      <option value="">Any</option>
      {named.map((w) => (
        <option key={w.name} value={w.name!}>
          {w.name}
          {w.filter ? ` (${w.filter})` : ''}
        </option>
      ))}
      {offline && <option value={value!}>{value} (not running)</option>}
    </select>
  );
}

/**
 * Chips plus a free-text input. Suggestions come from the labels already on the
 * board, which is what stops it drifting into "frontend", "front-end" and
 * "FrontEnd" -- the datalist offers the spelling that already exists.
 */
function LabelEditor({
  labels,
  suggestions,
  onChange,
}: {
  labels: string[];
  suggestions: string[];
  onChange: (labels: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const full = labels.length >= MAX_LABELS;

  const unused = useMemo(() => {
    const taken = new Set(labels.map((l) => l.toLowerCase()));
    return suggestions.filter((s) => !taken.has(s.toLowerCase()));
  }, [labels, suggestions]);

  const commit = (raw: string) => {
    const label = raw.trim().replace(/\s+/g, ' ');
    if (!label || full) return setDraft('');
    if (labels.some((l) => l.toLowerCase() === label.toLowerCase())) return setDraft('');
    onChange([...labels, label]);
    setDraft('');
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-1.5">
      {labels.map((label) => (
        <span
          key={label}
          className={cx('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium', labelTone(label))}
        >
          {label}
          <button
            onClick={() => onChange(labels.filter((l) => l !== label))}
            className="opacity-60 transition hover:opacity-100"
            aria-label={`Remove label ${label}`}
          >
            <svg viewBox="0 0 16 16" className="size-2.5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </span>
      ))}

      {!full && (
        <>
          <input
            value={draft}
            list="pk-label-suggestions"
            maxLength={MAX_LABEL_LENGTH}
            onChange={(e) => (e.target.value.endsWith(',') ? commit(e.target.value.slice(0, -1)) : setDraft(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit(draft);
              }
              if (e.key === 'Backspace' && !draft && labels.length) onChange(labels.slice(0, -1));
            }}
            onBlur={() => commit(draft)}
            placeholder={labels.length ? 'Add label' : 'Add a label'}
            aria-label="Add label"
            className="w-24 bg-transparent text-[11px] text-zinc-300 placeholder:text-zinc-600 focus:outline-none"
          />
          <datalist id="pk-label-suggestions">
            {unused.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </>
      )}
    </div>
  );
}

/**
 * Plan and result as a print-ready page in a new tab, where the browser's own
 * "Save as PDF" is the download. Disabled while the card has neither, since the
 * page would come out empty.
 */
function DownloadButton({ task }: { task: Task }) {
  const [blocked, setBlocked] = useState(false);
  const ready = hasPrintableContent(task);

  return (
    <div className="relative">
      <button
        onClick={() => setBlocked(!openPrintView(task))}
        disabled={!ready}
        aria-label="Download plan and result as PDF"
        title={
          ready
            ? 'Open plan and result as a printable page, then save it as PDF'
            : 'Nothing to download yet — this card has no plan and no result'
        }
        className={cx(
          'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition',
          ready
            ? 'border-zinc-700 text-zinc-300 hover:border-sky-500 hover:text-sky-300'
            : 'cursor-not-allowed border-transparent bg-white/5 text-zinc-600',
        )}
      >
        <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M8 2.5v7M5 7l3 3 3-3M3 13h10" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        PDF
      </button>

      {blocked && (
        <p className="absolute top-full right-0 z-10 mt-1 w-56 rounded-md border border-amber-700/50 bg-amber-950/90 px-2 py-1.5 text-[11px] leading-snug text-amber-200">
          The tab was blocked. Allow pop-ups for this board, then try again.
        </p>
      )}
    </div>
  );
}

function MoveButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={active}
      className={cx(
        'rounded-md border px-2 py-1 text-[11px] font-medium transition',
        active
          ? 'cursor-default border-transparent bg-white/5 text-zinc-600'
          : 'border-zinc-700 text-zinc-300 hover:border-sky-500 hover:text-sky-300',
      )}
    >
      {label}
    </button>
  );
}

function EditableTitle({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => setDraft(value), [value]);

  if (!editing) {
    return (
      <h2
        onClick={() => setEditing(true)}
        className="flex-1 cursor-text text-[17px] leading-snug font-semibold text-zinc-50"
      >
        {value}
      </h2>
    );
  }
  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        if (draft.trim() && draft !== value) onSave(draft.trim());
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setDraft(value);
          setEditing(false);
        }
      }}
      className="flex-1 rounded-md border border-zinc-700 bg-[var(--color-surface-2)] px-2 py-1 text-[17px] font-semibold text-zinc-50 outline-none focus:border-sky-500"
    />
  );
}

function EditableMarkdown({
  value,
  placeholder,
  onSave,
  footer,
}: {
  value: string;
  placeholder: string;
  onSave: (v: string) => void;
  footer?: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  if (editing) {
    return (
      <div className="flex h-full flex-col p-5">
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              onSave(draft);
              setEditing(false);
            }
            if (e.key === 'Escape') setEditing(false);
          }}
          className="min-h-[220px] flex-1 resize-none rounded-lg border border-zinc-700 bg-[var(--color-surface-2)] p-3 font-mono text-[12.5px] leading-relaxed text-zinc-200 outline-none focus:border-sky-500"
        />
        <div className="mt-2.5 flex items-center gap-2">
          <button
            onClick={() => {
              onSave(draft);
              setEditing(false);
            }}
            className="rounded-md bg-sky-500 px-3 py-1.5 text-[12px] font-medium text-sky-950 hover:bg-sky-400"
          >
            Save
          </button>
          <button onClick={() => setEditing(false)} className="text-[12px] text-zinc-500 hover:text-zinc-300">
            Cancel
          </button>
          <span className="ml-auto text-[11px] text-zinc-700">markdown · ⌘↵ to save</span>
        </div>
      </div>
    );
  }

  return (
    <div className="p-5">
      <div onDoubleClick={() => setEditing(true)}>
        <Markdown empty={placeholder}>{value}</Markdown>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={() => setEditing(true)}
          className="rounded-md border border-zinc-700 px-2.5 py-1 text-[11.5px] text-zinc-300 transition hover:border-zinc-500"
        >
          Edit
        </button>
        {footer}
      </div>
    </div>
  );
}

/** Results that later runs replaced, newest first and collapsed by default. */
function ResultHistory({ history }: { history: PastResult[] }) {
  return (
    <section className="mt-6 border-t border-[var(--color-line)] pt-4">
      <p className="mb-2 text-[10.5px] font-semibold tracking-wide text-zinc-500 uppercase">
        Earlier results ({history.length})
      </p>
      <ol className="space-y-2">
        {[...history].reverse().map((past, i) => (
          <li key={`${past.at}-${i}`}>
            <details className="group rounded-md border border-[var(--color-line)]">
              <summary className="cursor-pointer px-3 py-2 text-[12px] text-zinc-400 select-none hover:text-zinc-200">
                Run {history.length - i} · <span title={past.at}>{relativeTime(past.at)}</span>
              </summary>
              <div className="border-t border-[var(--color-line)] px-3 py-2 opacity-80">
                <Markdown empty="No summary was recorded.">{past.text}</Markdown>
              </div>
            </details>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ActivityFeed({ task }: { task: Task }) {
  if (!task.activity.length) {
    return <p className="p-5 text-sm text-zinc-600 italic">Claude has not touched this card yet.</p>;
  }
  return (
    <ol className="space-y-0 p-5">
      {task.activity.map((entry, i) => (
        <li key={i} className="relative flex gap-3 pb-4 last:pb-0">
          <div className="flex flex-col items-center">
            <span className={cx('mt-1.5 size-1.5 shrink-0 rounded-full', KIND_COLOR[entry.kind] ?? 'bg-zinc-600')} />
            {i < task.activity.length - 1 && <span className="mt-1 w-px flex-1 bg-zinc-800" />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] leading-snug break-words text-zinc-300">{entry.text}</p>
            <p className="mt-0.5 text-[10.5px] text-zinc-600">
              {clockTime(entry.at)}
              {entry.model && <span title={entry.model}> · {modelLabel(entry.model)}</span>}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Conversation({ task, onReply }: { task: Task; onReply: (text: string) => void }) {
  const [draft, setDraft] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const waiting = pendingQuestion(task);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [task.messages.length]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    onReply(text);
    setDraft('');
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-3 p-5">
        {!task.messages.length && (
          <p className="text-sm text-zinc-600 italic">
            When Claude needs a decision it asks here and the card moves to User Input. You can also leave a note at any
            time — Claude reads the thread before picking the card up.
          </p>
        )}
        {task.messages.map((message) => (
          <div key={message.id} className={cx('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}>
            <div
              className={cx(
                'max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed',
                message.role === 'user'
                  ? 'bg-sky-500/15 text-sky-50'
                  : message.needsAnswer && !message.answeredBy
                    ? 'border border-amber-500/40 bg-amber-500/10 text-amber-50'
                    : 'bg-[var(--color-surface-3)] text-zinc-200',
              )}
            >
              <p className="mb-1 text-[10.5px] font-medium tracking-wide text-zinc-500 uppercase">
                {message.role === 'user' ? 'You' : 'Claude'} · {clockTime(message.at)}
              </p>
              <div className="whitespace-pre-wrap">{message.text}</div>
            </div>
          </div>
        ))}
        <div ref={bottom} />
      </div>

      <div className="sticky bottom-0 border-t border-[var(--color-line)] bg-[var(--color-surface-1)] p-3">
        {waiting ? (
          <p className="mb-2 text-[11.5px] text-amber-300">Claude is blocked on your answer.</p>
        ) : (
          task.column === 'in-progress' && (
            <p className="mb-2 text-[11.5px] text-emerald-300/80">
              Claude is working on this card. A note you send now reaches it at its next check-in.
            </p>
          )
        )}
        <div className="flex items-end gap-2">
          <textarea
            rows={2}
            value={draft}
            placeholder={waiting ? 'Answer Claude…' : 'Leave a note for Claude…'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            className="flex-1 resize-none rounded-lg border border-zinc-700 bg-[var(--color-surface-2)] px-3 py-2 text-[13px] text-zinc-100 outline-none focus:border-sky-500 placeholder:text-zinc-600"
          />
          <button
            onClick={send}
            disabled={!draft.trim()}
            className="rounded-lg bg-sky-500 px-3 py-2 text-[12px] font-medium text-sky-950 transition hover:bg-sky-400 disabled:bg-zinc-800 disabled:text-zinc-600"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
