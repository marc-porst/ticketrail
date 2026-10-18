import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { ColumnView } from './components/ColumnView.tsx';
import { CardFace } from './components/Card.tsx';
import { CardDetail } from './components/CardDetail.tsx';
import { apiFor } from './lib/api.ts';
import { useBoard } from './lib/useBoard.ts';
import { useProjects, useSelectedProject } from './lib/useProjects.ts';
import { ProjectPicker } from './components/ProjectPicker.tsx';
import { Settings } from './components/Settings.tsx';
import { WorkerIndicator } from './components/WorkerIndicator.tsx';
import { LinkConfirm } from './components/LinkConfirm.tsx';
import { setConfirmLink, shouldConfirmLink } from './lib/confirmLink.ts';
import { SpacesModal } from './components/SpacesModal.tsx';
import { FoldersModal } from './components/FoldersModal.tsx';
import { useCollapsed } from './lib/useCollapsed.ts';
import { CHANGE_TEXT, type ChangeKind } from './lib/changes.ts';
import { playCue, primeAudio } from './lib/sound.ts';
import { showNotification } from './lib/notify.ts';
import {
  byColumn as groupByColumn,
  dropZone,
  linkOnDrop,
  resolveDrop,
  resolveFolderDrop,
  type DropZone,
} from './lib/drop.ts';
import { FolderDragFace } from './components/FolderGroup.tsx';
import { cx, labelTone } from './lib/ui.ts';
import { matchesSearch, searchTerms } from './lib/search.ts';
import { pendingQuestion, type Column, type AgentSummary, type NotificationSettings, type SkillSummary, type Task } from './lib/types.ts';

// The skills view brings a syntax highlighter; load it only when it is opened.
const SkillsModal = lazy(() => import('./components/SkillsModal.tsx').then((m) => ({ default: m.SkillsModal })));
const AgentsModal = lazy(() => import('./components/AgentsModal.tsx').then((m) => ({ default: m.AgentsModal })));

export default function App() {
  const { projects, defaultId, refresh } = useProjects();
  const { selected, select } = useSelectedProject(projects, defaultId);

  // Board-wide, so everyone opening this board gets the same alerts.
  const [settings, setSettings] = useState<NotificationSettings>({ sound: true, desktop: true, onStart: false });
  const announce = useCallback(
    (kind: ChangeKind, task: Task) => {
      if (kind === 'started' && !settings.onStart) return;

      if (settings.sound) playCue(kind);
      if (settings.desktop) {
        const text = CHANGE_TEXT[kind];
        showNotification({
          title: text.title,
          body: text.body(task.title),
          tag: task.id,
          onClick: () => setOpenId(task.id),
        });
      }
    },
    [settings],
  );

  const { snapshot, connection, error, dismissError, pause, optimistic, run } = useBoard(selected, announce);
  const api = useMemo(() => (selected ? apiFor(selected) : null), [selected]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  /** A folder header being dragged to sort folders, and where it would land. */
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [overFolder, setOverFolder] = useState<{ column: string; above: string | null } | null>(null);
  const [spacesOpen, setSpacesOpen] = useState(false);
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skillCount, setSkillCount] = useState<number | null>(null);
  const onSkillsChanged = useCallback((list: SkillSummary[]) => setSkillCount(list.length), []);

  const [agentsOpen, setAgentsOpen] = useState(false);
  /** The open space's agents: the header count and the card's agent picker. */
  const [agents, setAgents] = useState<AgentSummary[]>([]);

  // reload on focus too: an agent file may have been added in the editor
  useEffect(() => {
    setAgents([]);
    if (!api) return;
    let live = true;
    const load = () =>
      api.agents().then(
        (list) => live && Array.isArray(list) && setAgents(list),
        () => {
          /* an older server has no agents route: no picker, nothing else changes */
        },
      );
    void load();
    window.addEventListener('focus', load);
    return () => {
      live = false;
      window.removeEventListener('focus', load);
    };
  }, [api]);

  // the header shows how many skills the open space has
  useEffect(() => {
    setSkillCount(null);
    if (!api) return;
    let live = true;
    api.skills().then(
      (list) => live && Array.isArray(list) && setSkillCount(list.length),
      () => {
        /* an older server has no skills route: the button still opens and explains */
      },
    );
    return () => {
      live = false;
    };
  }, [api]);
  const collapsed = useCollapsed(selected);
  const [overCardId, setOverCardId] = useState<string | null>(null);
  const [overZone, setOverZone] = useState<DropZone>('before');
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const searchBox = useRef<HTMLInputElement>(null);
  const terms = useMemo(() => searchTerms(query), [query]);

  // a search belongs to the board it was typed on
  useEffect(() => setQuery(''), [selected]);

  // "/" jumps to the search from anywhere that is not already a text field
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      searchBox.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  /** Every label in use on this board, for the filter row and the card editor. */
  const allLabels = useMemo(() => {
    const seen = new Map<string, string>();
    for (const task of snapshot?.tasks ?? []) {
      for (const label of task.labels) if (!seen.has(label.toLowerCase())) seen.set(label.toLowerCase(), label);
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }, [snapshot?.tasks]);

  // A label that disappears from the board (last card archived) must not leave
  // the board filtered to nothing with no chip left to click.
  useEffect(() => {
    if (labelFilter && !allLabels.some((l) => l.toLowerCase() === labelFilter.toLowerCase())) setLabelFilter(null);
  }, [allLabels, labelFilter]);

  const visible = useMemo(
    () =>
      (snapshot?.tasks ?? []).filter(
        (t) =>
          (!labelFilter || t.labels.some((l) => l.toLowerCase() === labelFilter.toLowerCase())) &&
          matchesSearch(t, terms),
      ),
    [snapshot?.tasks, labelFilter, terms],
  );

  const folders = useMemo(() => snapshot?.folders ?? [], [snapshot?.folders]);
  const byColumn = useMemo(() => groupByColumn(visible, folders), [visible, folders]);

  // Links are stored on the card that needs the context; count the other end here.
  const backlinks = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of snapshot?.tasks ?? []) {
      for (const id of task.related ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [snapshot?.tasks]);

  const open = snapshot?.tasks.find((t) => t.id === openId) ?? null;
  const active = snapshot?.tasks.find((t) => t.id === activeId) ?? null;
  const blocked = (snapshot?.tasks ?? []).filter((t) => pendingQuestion(t)).length;
  useEffect(() => {
    if (snapshot?.settings) setSettings(snapshot.settings);
  }, [snapshot?.settings]);

  // A browser will not play a sound before the page has been interacted with.
  useEffect(() => {
    const wake = () => primeAudio();
    window.addEventListener('pointerdown', wake, { once: true });
    window.addEventListener('keydown', wake, { once: true });
    return () => {
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', wake);
    };
  }, []);

  const current = projects.find((p) => p.id === selected) ?? null;
  // the registry knows the name before the board snapshot arrives
  const projectName = current?.name ?? snapshot?.project?.name ?? snapshot?.title ?? null;

  // Two boards open in two tabs are otherwise impossible to tell apart.
  useEffect(() => {
    if (projectName) document.title = `${projectName} · Ticketrail`;
  }, [projectName]);

  // The alert worth having most is about the project you are not looking at.
  const blockedElsewhere = useRef<Record<string, number>>({});
  useEffect(() => {
    for (const project of projects) {
      const previous = blockedElsewhere.current[project.id];
      blockedElsewhere.current[project.id] = project.summary.blocked;
      if (previous === undefined || project.id === selected) continue;
      if (project.summary.blocked > previous) {
        if (settings.sound) playCue('needs-you');
        if (settings.desktop) {
          showNotification({
            title: `${project.name} needs your answer`,
            body: `${project.summary.blocked} card${project.summary.blocked > 1 ? 's' : ''} waiting`,
            tag: `project-${project.id}`,
            onClick: () => select(project.id),
          });
        }
      }
    }
  }, [projects, selected, settings, select]);

  const onDragStart = (event: DragStartEvent) => {
    pause(true);
    const id = String(event.active.id);
    if (id.startsWith('folderdrag:')) setActiveFolder(id.split(':')[2]);
    else setActiveId(id.replace('card:', ''));
  };

  /**
   * Which folder a dragged folder would land above, in the lane under the
   * pointer: a header or a filed card means that folder, an unfiled card means
   * the top, the lane body means the bottom.
   */
  const folderTarget = (event: DragMoveEvent | DragEndEvent): { column: string; above: string | null } | null => {
    const over = event.over ? String(event.over.id) : '';
    if (over.startsWith('folder:')) {
      const [, column, id] = over.split(':');
      return { column, above: id };
    }
    if (over.startsWith('col:')) return { column: over.slice(4), above: null };
    if (over.startsWith('card:')) {
      const card = snapshot?.tasks.find((t) => t.id === over.slice(5));
      if (!card) return null;
      const filed = folders.some((f) => f.id === card.folder) ? card.folder : null;
      return { column: card.column, above: filed ?? folders.find((f) => f.id !== activeFolder)?.id ?? null };
    }
    return null;
  };

  /** Which card the pointer is over, and whether it is in that card's reorder or link zone. */
  const pointerOver = (event: DragMoveEvent | DragEndEvent): { cardId: string | null; zone: DropZone } => {
    const over = event.over ? String(event.over.id) : '';
    if (!event.over || !over.startsWith('card:')) return { cardId: null, zone: 'before' };
    const start = event.activatorEvent as PointerEvent;
    const y = (start?.clientY ?? 0) + event.delta.y;
    return { cardId: over.slice(5), zone: dropZone(y, event.over.rect) };
  };

  // onDragMove rather than onDragOver: the zone changes while the pointer stays on one card
  const onDragMove = (event: DragMoveEvent) => {
    if (activeFolder) return setOverFolder(folderTarget(event));
    const { cardId, zone } = pointerOver(event);
    setOverCardId(cardId);
    setOverZone(zone);
  };

  /** A drop that would link two cards, held until the user confirms it. */
  const [pendingLink, setPendingLink] = useState<{ dragged: Task; target: Task } | null>(null);
  const [confirmLinks, setConfirmLinks] = useState(() => shouldConfirmLink());
  const link = (targetId: string, related: string[]) =>
    void run(() => api!.patch(targetId, { related }).then((t) => (refresh(), t)));

  const onDragEnd = (event: DragEndEvent) => {
    if (activeFolder) {
      const target = folderTarget(event);
      const moved = target ? resolveFolderDrop(folders, activeFolder, target.above) : null;
      setActiveFolder(null);
      setOverFolder(null);
      pause(false);
      if (moved) void run(() => api!.updateFolder(activeFolder, moved));
      return;
    }

    const taskId = String(event.active.id).replace('card:', '');
    setActiveId(null);
    setOverCardId(null);

    // Dropped low on another card: the dragged card becomes that card's related
    // context, and neither card moves.
    const { cardId, zone } = pointerOver(event);
    const target = cardId ? snapshot?.tasks.find((t) => t.id === cardId) : undefined;
    if (target && zone === 'link' && target.id !== taskId) {
      const related = linkOnDrop(target, taskId);
      const dragged = snapshot?.tasks.find((t) => t.id === taskId);
      pause(false);
      if (!related || !dragged) return;
      if (shouldConfirmLink()) return setPendingLink({ dragged, target });
      return link(target.id, related);
    }

    const task = snapshot?.tasks.find((t) => t.id === taskId);
    const drop = event.over && task ? resolveDrop(snapshot!.tasks, taskId, String(event.over.id), folders) : null;
    if (!drop || !task) return pause(false);

    // Applying the move locally first is also what keeps your own drags silent:
    // the echo that comes back over SSE carries no change to announce.
    optimistic({ ...task, column: drop.column, folder: drop.folder });
    void run(() => api!.patch(taskId, drop)).finally(() => pause(false));
  };

  if (!snapshot) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-600">
        {connection === 'connecting' ? 'Connecting to the board…' : 'The board server is not reachable.'}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-[var(--color-line)] px-5 py-3">
        <div className="flex items-center gap-2">
          <img src="/favicon.svg" alt="Ticketrail" className="size-8" />
        </div>

        <ProjectPicker
          projects={projects}
          current={current}
          onSelect={select}
          onConfigure={() => setSpacesOpen(true)}
        />

        {blocked > 0 && (
          <span className="rounded-full bg-amber-400/10 px-2 py-0.5 text-[11px] font-medium text-amber-300">
            {blocked} waiting on you
          </span>
        )}

        <div className="relative ml-auto w-full max-w-[280px] min-w-[140px]">
          <svg
            viewBox="0 0 16 16"
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-zinc-600"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5L14 14" strokeLinecap="round" />
          </svg>
          <input
            ref={searchBox}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQuery('');
                e.currentTarget.blur();
              }
            }}
            placeholder="Search cards"
            aria-label="Search cards by title and description"
            title="Search titles and descriptions — press / to jump here"
            className={cx(
              'w-full rounded-md border bg-black/30 py-1 pr-16 pl-8 text-[12px] text-zinc-100 outline-none transition placeholder:text-zinc-600 [&::-webkit-search-cancel-button]:hidden',
              terms.length ? 'border-sky-700/70' : 'border-[var(--color-line)] focus:border-sky-600',
            )}
          />
          {terms.length > 0 ? (
            <span className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-1">
              <span className="text-[10.5px] text-zinc-500" aria-live="polite">
                {visible.length} {visible.length === 1 ? 'card' : 'cards'}
              </span>
              <button
                onClick={() => {
                  setQuery('');
                  searchBox.current?.focus();
                }}
                className="rounded p-0.5 text-zinc-500 hover:bg-white/10 hover:text-zinc-200"
                aria-label="Clear search"
              >
                <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                </svg>
              </button>
            </span>
          ) : (
            <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border border-[var(--color-line)] px-1 font-mono text-[10px] text-zinc-600">
              /
            </kbd>
          )}
        </div>

        <div className="flex items-center gap-2 text-[11.5px] text-zinc-500">
          <button
            onClick={() => setSkillsOpen(true)}
            className="rounded-md px-2 py-1 text-zinc-500 transition hover:bg-white/5 hover:text-zinc-200"
            title="This project's Claude skills (.claude/skills)"
          >
            Skills{skillCount ? ` · ${skillCount}` : ''}
          </button>
          <button
            onClick={() => setAgentsOpen(true)}
            className="rounded-md px-2 py-1 text-zinc-500 transition hover:bg-white/5 hover:text-zinc-200"
            title="This project's Claude agents (.claude/agents); assign one to a card"
          >
            Agents{agents.length ? ` · ${agents.length}` : ''}
          </button>
          <button
            onClick={() => setFoldersOpen(true)}
            className="rounded-md px-2 py-1 text-zinc-500 transition hover:bg-white/5 hover:text-zinc-200"
            title="Optional folders that group cards in every lane"
          >
            Folders{folders.length ? ` · ${folders.length}` : ''}
          </button>
          <Settings
            confirmLinks={confirmLinks}
            onConfirmLinksChange={(on) => {
              setConfirmLink(on);
              setConfirmLinks(on);
            }}
            settings={settings}
            onChange={(changes) => {
              setSettings((s) => ({ ...s, ...changes }));
              void run(() => api!.saveSettings(changes));
            }}
          />
          <WorkerIndicator
            connection={connection}
            workers={snapshot?.workers}
            tasks={snapshot?.tasks ?? []}
            onOpenCard={setOpenId}
          />
        </div>
      </header>

      {allLabels.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--color-line)] px-5 py-2">
          <span className="mr-1 text-[10.5px] tracking-wide text-zinc-600 uppercase">Labels</span>
          {allLabels.map((label) => {
            const on = labelFilter?.toLowerCase() === label.toLowerCase();
            return (
              <button
                key={label}
                onClick={() => setLabelFilter(on ? null : label)}
                className={cx(
                  'rounded px-1.5 py-0.5 text-[11px] font-medium transition',
                  labelTone(label),
                  on ? 'ring-1 ring-zinc-400' : 'opacity-60 hover:opacity-100',
                )}
              >
                {label}
              </button>
            );
          })}
          {labelFilter && (
            <button onClick={() => setLabelFilter(null)} className="ml-1 text-[11px] text-zinc-500 hover:text-zinc-300">
              clear
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-3 border-b border-red-900/50 bg-red-950/40 px-5 py-2 text-[12px] text-red-200">
          {error}
          <button onClick={dismissError} className="ml-auto text-red-300 hover:text-red-100">
            dismiss
          </button>
        </div>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
        onDragCancel={() => {
          setActiveId(null);
          setOverCardId(null);
          setActiveFolder(null);
          setOverFolder(null);
          pause(false);
        }}
      >
        <main className="flex min-h-0 flex-1 gap-4 overflow-x-auto px-5 py-4">
          {snapshot.columns.map((meta) => (
            <ColumnView
              key={meta.id}
              meta={meta}
              tasks={byColumn.get(meta.id) ?? []}
              overCardId={activeId ? overCardId : null}
              overZone={overZone}
              draggingId={activeId}
              backlinks={backlinks}
              folders={folders}
              collapsed={collapsed}
              overFolderId={overFolder?.column === meta.id ? overFolder.above : null}
              onOpen={(task) => setOpenId(task.id)}
              onCreate={
                meta.id === 'backlog'
                  ? (title) => void run(() => api!.create({ title, column: 'backlog' }).then(refresh))
                  : undefined
              }
            />
          ))}
        </main>

        <DragOverlay dropAnimation={null}>
          {active ? (
            <CardFace task={active} dragging />
          ) : activeFolder && folders.find((f) => f.id === activeFolder) ? (
            <FolderDragFace folder={folders.find((f) => f.id === activeFolder)!} />
          ) : null}
        </DragOverlay>
      </DndContext>

      {foldersOpen && (
        <FoldersModal
          folders={folders}
          tasks={snapshot.tasks}
          onClose={() => setFoldersOpen(false)}
          onCreate={(name) => run(() => api!.createFolder(name))}
          onUpdate={(id, changes) => run(() => api!.updateFolder(id, changes))}
          onDelete={(id) => run(() => api!.deleteFolder(id))}
        />
      )}

      {skillsOpen && api && (
        <Suspense fallback={null}>
          <SkillsModal key={selected} api={api} onClose={() => setSkillsOpen(false)} onChanged={onSkillsChanged} />
        </Suspense>
      )}

      {pendingLink && (
        <LinkConfirm
          dragged={pendingLink.dragged}
          target={pendingLink.target}
          onCancel={() => setPendingLink(null)}
          onConfirm={(dontAskAgain) => {
            const { dragged, target } = pendingLink;
            setPendingLink(null);
            if (dontAskAgain) {
              setConfirmLink(false);
              setConfirmLinks(false);
            }
            // the board may have moved on while the dialog was open: link against the card as it is now
            const current = snapshot?.tasks.find((t) => t.id === target.id);
            const related = current ? linkOnDrop(current, dragged.id) : null;
            if (related) link(target.id, related);
          }}
        />
      )}

      {agentsOpen && api && (
        <Suspense fallback={null}>
          <AgentsModal key={selected} api={api} onClose={() => setAgentsOpen(false)} onChanged={setAgents} />
        </Suspense>
      )}

      {spacesOpen && (
        <SpacesModal
          projects={projects}
          currentId={selected}
          defaultId={defaultId}
          onClose={() => setSpacesOpen(false)}
          onChanged={refresh}
        />
      )}

      {open && (
        <CardDetail
          key={open.id}
          task={open}
          projectId={selected!}
          onClose={() => setOpenId(null)}
          onPatch={(changes) => void run(() => api!.patch(open.id, changes).then((t) => (refresh(), t)))}
          onReply={(text) => void run(() => api!.reply(open.id, text).then((t) => (refresh(), t)))}
          onUpload={async (files) => {
            for (const file of files) await run(() => api!.upload(open.id, file));
          }}
          onRemoveAttachment={(fileId) => void run(() => api!.removeAttachment(open.id, fileId))}
          onDerive={() => void run(() => api!.derive(open.id).then((t) => (refresh(), t)))}
          labelSuggestions={allLabels}
          allTasks={snapshot.tasks}
          onOpenCard={setOpenId}
          folders={folders}
          onCreateFolder={(name) => run(() => api!.createFolder(name))}
          agents={agents}
          workers={snapshot.workers?.workers ?? []}
          onManageAgents={() => {
            setOpenId(null);
            setAgentsOpen(true);
          }}
          onArchive={() => {
            setOpenId(null);
            void run(() => api!.archive(open.id).then((t) => (refresh(), t)));
          }}
        />
      )}
    </div>
  );
}
