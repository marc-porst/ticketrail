import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ACCENT, cx } from '../lib/ui.ts';
import { COLUMN_LABELS, TYPE_LABELS, type Task } from '../lib/types.ts';
import {
  NODE_H,
  NODE_W,
  canvasSize,
  edgesOf,
  arrow,
  loadPositions,
  placeMissing,
  savePositions,
  fitZoom,
  tidyLayout,
  tidyToFit,
  type Edge,
  type Point,
  type Positions,
} from '../lib/graph.ts';

/** How far the map can zoom out and in. */
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 1.5;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));

/** Further than this and a press on a card is a drag, not a click. */
const CLICK_SLOP = 4;

type Gesture =
  | { kind: 'move'; id: string; offset: Point; start: Point; moved: boolean }
  | { kind: 'link'; from: string; at: Point; over: string | null };

/**
 * Every card on the board and the arrows between them. Cards can be dragged
 * around, a line drawn from one card's handle to another links them, an arrow
 * can be removed with its trash button, and Tidy up lays it all out again. A clicked card opens in a
 * panel on the right, so the map stays where it is. Where the cards sit is
 * remembered in this browser; the links themselves are the cards' own.
 */
export function RelationsModal({
  projectId,
  tasks,
  onClose,
  onOpenCard,
  renderCard,
  onCreate,
  onLink,
  onUnlink,
}: {
  projectId: string;
  tasks: Task[];
  onClose: () => void;
  /** Without `renderCard`: what a click on a card does instead of opening the side panel. */
  onOpenCard?: (id: string) => void;
  /**
   * The card's detail for the side panel; `close` empties the panel and
   * `open` switches it to another card (a related card clicked inside it).
   */
  renderCard?: (id: string, close: () => void, open: (id: string) => void) => ReactNode;
  /** Create a card in Backlog; resolves to it, or null when that failed. Without it, cards cannot be made here. */
  onCreate?: (title: string) => Promise<Task | null>;
  /** Make `from` read `to` as context. Resolves to an error message when it cannot. */
  onLink: (from: string, to: string) => string | null;
  onUnlink: (from: string, to: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [positions, setPositions] = useState<Positions>(() => placeMissing(tasks, loadPositions(projectId)));
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  /** The link whose trash button is showing. It lingers a moment so the pointer can reach it. */
  const [trashFor, setTrashFor] = useState<string | null>(null);
  const hideTimer = useRef<number | null>(null);
  const showTrash = (key: string) => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = null;
    setHoverEdge(key);
    setTrashFor(key);
  };
  const hideTrash = () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      setHoverEdge(null);
      setTrashFor(null);
    }, 350);
  };
  useEffect(() => () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
  }, []);
  const [notice, setNotice] = useState<string | null>(null);
  /** The card shown in the side panel. */
  const [openCard, setOpenCard] = useState<string | null>(null);
  const open = useCallback(
    (id: string) => (renderCard ? setOpenCard(id) : onOpenCard?.(id)),
    [renderCard, onOpenCard],
  );
  const closeCard = useCallback(() => setOpenCard(null), []);
  const [tidying, setTidying] = useState(false);
  /** The card moved last stays on top, so a card dropped onto another is not hidden under it. */
  const [front, setFront] = useState<string | null>(null);
  /**
   * A card being made here: where it will sit, and the card that will read it
   * when it came from a link dropped on empty space.
   */
  const [draft, setDraft] = useState<{ at: Point; linkFrom: string | null } | null>(null);
  /** Where cards made here go, until they arrive from the board. */
  const placed = useRef<Positions>({});

  // cards added or removed while the view is open
  useEffect(() => {
    setPositions((current) => {
      const next = placeMissing(tasks, { ...current, ...placed.current }, scroller.current?.clientWidth);
      for (const t of tasks) delete placed.current[t.id];
      const same =
        Object.keys(next).length === Object.keys(current).length && tasks.every((t) => current[t.id] === next[t.id]);
      return same ? current : next;
    });
  }, [tasks]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // innermost first: a link being drawn, a card being named, the side panel, then the view itself
      if (gesture) setGesture(null);
      else if (draft) setDraft(null);
      else if (openCard) setOpenCard(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, gesture, openCard, draft]);

  // a card deleted while it is open in the panel
  useEffect(() => {
    if (openCard && !tasks.some((t) => t.id === openCard)) setOpenCard(null);
  }, [tasks, openCard]);

  const edges = useMemo(() => edgesOf(tasks), [tasks]);
  // a removed link takes its trash button with it, even with the pointer still on the spot
  useEffect(() => {
    if (trashFor && !edges.some((e) => e.kind === 'related' && `${e.from}>${e.to}` === trashFor)) {
      setTrashFor(null);
      setHoverEdge(null);
    }
  }, [edges, trashFor]);
  /** Links already removed here but not yet gone from the board: no trash button for those. */
  const [removing, setRemoving] = useState<Set<string>>(() => new Set());
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const size = canvasSize(positions);

  /** A pointer position in canvas pixels, scroll included. */
  const toCanvas = useCallback((e: { clientX: number; clientY: number }): Point => {
    const box = scroller.current!.getBoundingClientRect();
    const z = zoomRef.current;
    return {
      x: (e.clientX - box.left + scroller.current!.scrollLeft) / z,
      y: (e.clientY - box.top + scroller.current!.scrollTop) / z,
    };
  }, []);

  /*
   * The map opens zoomed so all of it fits the window: every card and every
   * arrow in view without scrolling. Zoom in and out from there.
   */
  const [zoom, setZoomState] = useState(1);
  const zoomRef = useRef(1);
  const setZoom = (z: number) => {
    zoomRef.current = clampZoom(z);
    setZoomState(zoomRef.current);
  };
  const fit = (of: Positions = positions) => {
    const box = scroller.current;
    if (!box || !box.clientWidth || !box.clientHeight) return;
    setZoom(fitZoom(of, box.clientWidth, box.clientHeight));
    box.scrollTo?.({ left: 0, top: 0 });
  };
  // once, when the view opens and the window size is known
  useLayoutEffect(() => {
    const box = scroller.current;
    // nothing arranged yet on this board: lay it out for this window, not a guessed width
    if (box?.clientWidth && box.clientHeight && !Object.keys(loadPositions(projectId)).length) {
      const laid = tidyToFit(tasks, box.clientWidth, box.clientHeight);
      setPositions(laid);
      fit(laid);
      return;
    }
    fit();
  }, []);
  // Ctrl/⌘ + scroll zooms, the way maps do; plain scrolling still scrolls
  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom(zoomRef.current * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    };
    box.addEventListener('wheel', onWheel, { passive: false });
    return () => box.removeEventListener('wheel', onWheel);
  }, []);

  const keep = (next: Positions) => {
    setPositions(next);
    savePositions(projectId, next);
  };

  const tidy = () => {
    setTidying(true);
    const box = scroller.current;
    const next = box?.clientWidth && box.clientHeight ? tidyToFit(tasks, box.clientWidth, box.clientHeight) : tidyLayout(tasks);
    keep(next);
    fit(next);
    window.setTimeout(() => setTidying(false), 400);
  };

  // While a gesture runs, follow the pointer anywhere on the page, not just over the canvas.
  useEffect(() => {
    if (!gesture) return;
    const onMove = (e: PointerEvent) => {
      const at = toCanvas(e);
      if (gesture.kind === 'move') {
        const moved = gesture.moved || Math.hypot(at.x - gesture.start.x, at.y - gesture.start.y) > CLICK_SLOP;
        if (moved !== gesture.moved) setGesture({ ...gesture, moved });
        if (!moved) return;
        setPositions((p) => ({
          ...p,
          [gesture.id]: { x: Math.max(0, at.x - gesture.offset.x), y: Math.max(0, at.y - gesture.offset.y) },
        }));
      } else {
        const under = document.elementFromPoint?.(e.clientX, e.clientY)?.closest<HTMLElement>('[data-node]');
        const over = under && under.dataset.node !== gesture.from ? under.dataset.node! : null;
        setGesture({ ...gesture, at, over });
      }
    };
    const onUp = () => {
      if (gesture.kind === 'move') {
        if (gesture.moved) {
          setPositions((p) => (savePositions(projectId, p), p));
          setFront(gesture.id);
        }
        else open(gesture.id);
      } else if (gesture.over) {
        const problem = onLink(gesture.from, gesture.over);
        setNotice(problem);
      } else if (onCreate && positions[gesture.from] && awayFrom(positions[gesture.from], gesture.at)) {
        // dropped on empty space: make a new card there, linked from this one
        setDraft({ at: { x: Math.max(0, gesture.at.x - NODE_W / 2), y: Math.max(0, gesture.at.y - NODE_H / 2) }, linkFrom: gesture.from });
      }
      setGesture(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [gesture, toCanvas, projectId, open, onLink, onCreate, positions]);

  /** Name a new card where it will go, then make it, place it and link it. */
  const createCard = async (title: string) => {
    const at = draft;
    setDraft(null);
    if (!at || !onCreate || !title.trim()) return;
    const task = await onCreate(title.trim());
    if (!task) return;
    placed.current[task.id] = at.at;
    setPositions((p) => {
      const next = { ...p, [task.id]: at.at };
      savePositions(projectId, next);
      return next;
    });
    setFront(task.id);
    if (at.linkFrom) setNotice(onLink(at.linkFrom, task.id));
  };

  /** Keep a full-size box that is drawn over the zoomed map inside the visible part of it. */
  const inView = (p: Point): Point => {
    const box = scroller.current;
    if (!box || !box.clientWidth) return p;
    return {
      x: Math.max(box.scrollLeft + 8, Math.min(p.x, box.scrollLeft + box.clientWidth - NODE_W - 12)),
      y: Math.max(box.scrollTop + 8, Math.min(p.y, box.scrollTop + box.clientHeight - NODE_H - 12)),
    };
  };

  /** A free spot in the part of the map on screen, for a card made with the button. */
  const visibleSpot = (): Point => {
    const box = scroller.current;
    const z = zoomRef.current;
    const left = (box?.scrollLeft ?? 0) / z + 40;
    const top = (box?.scrollTop ?? 0) / z + 40;
    const taken = (x: number, y: number) =>
      Object.values(positions).some((p) => Math.abs(p.x - x) < NODE_W && Math.abs(p.y - y) < NODE_H + 8);
    for (let y = top; y < top + 1200; y += NODE_H + 28) {
      for (let x = left; x < left + Math.max(NODE_W, (box?.clientWidth ?? 900) / z - NODE_W - 80); x += NODE_W + 28) {
        if (!taken(x, y)) return { x, y };
      }
    }
    return { x: left, y: canvasSize(positions).height };
  };

  /** A link's straight arrow as an SVG path, and its middle for the trash button. */
  const shapeOf = (a: Point, b: Point | { point: Point }) => {
    const { start, end, mid } = arrow(a, b);
    return { d: `M${start.x} ${start.y} L${end.x} ${end.y}`, mid };
  };

  const lit = (e: Edge) => hoverNode !== null && (e.from === hoverNode || e.to === hoverNode);
  const linked = useMemo(() => {
    if (!hoverNode) return null;
    const ids = new Set([hoverNode]);
    for (const e of edges) if (e.from === hoverNode || e.to === hoverNode) (ids.add(e.from), ids.add(e.to));
    return ids;
  }, [hoverNode, edges]);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4 sm:p-6" role="dialog" aria-modal="true" aria-label="Relations">
      <div className="pk-scrim absolute inset-0" onClick={onClose} />

      <div className="relative flex h-[88vh] w-full max-w-[1400px] flex-col overflow-hidden rounded-2xl border border-white/[0.07] bg-[var(--color-surface-1)] pk-panel">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--color-line)] px-5 py-3.5">
          <h2 className="text-[15px] font-semibold tracking-tight text-zinc-100">Relations</h2>
          <p className="hidden text-[11px] text-zinc-600 md:block">
            Double-click empty space for a new card · drag a card to move it · drag from its <span className="text-sky-300">●</span> onto another card to link them ·
            hover a link and click its trash button to remove it · click a card to open it on the right
          </p>
          <div className="ml-auto flex items-center gap-3">
            <Legend />
            <div className="flex items-center rounded-lg border border-white/[0.08]" role="group" aria-label="Zoom">
              <button
                onClick={() => setZoom(zoom / 1.2)}
                disabled={zoom <= MIN_ZOOM}
                className="px-2 py-1.5 text-[12px] text-zinc-400 hover:text-zinc-100 disabled:opacity-30"
                aria-label="Zoom out"
              >
                −
              </button>
              <button
                onClick={() => fit()}
                className="min-w-[48px] border-x border-white/[0.08] px-1.5 py-1.5 font-mono text-[11px] text-zinc-300 hover:text-zinc-100"
                title="Fit the whole map in the window"
                aria-label="Zoom to fit"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                onClick={() => setZoom(zoom * 1.2)}
                disabled={zoom >= MAX_ZOOM}
                className="px-2 py-1.5 text-[12px] text-zinc-400 hover:text-zinc-100 disabled:opacity-30"
                aria-label="Zoom in"
              >
                +
              </button>
            </div>
            {onCreate && (
              <button
                onClick={() => setDraft({ at: visibleSpot(), linkFrom: null })}
                className="pk-press rounded-lg border border-white/[0.08] px-3 py-1.5 text-[12px] font-medium text-zinc-200 transition hover:bg-white/[0.06]"
              >
                + New card
              </button>
            )}
            <button
              onClick={tidy}
              className="pk-press rounded-lg border border-white/[0.08] px-3 py-1.5 text-[12px] font-medium text-zinc-200 transition hover:bg-white/[0.06]"
            >
              Tidy up
            </button>
            <button onClick={onClose} className="rounded-md p-1 text-zinc-500 hover:bg-white/5 hover:text-zinc-200" aria-label="Close">
              <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </header>

        {notice && (
          <div className="flex items-start gap-3 border-b border-amber-900/40 bg-amber-950/30 px-5 py-2 text-[12px] text-amber-200">
            <span className="min-w-0 flex-1">{notice}</span>
            <button onClick={() => setNotice(null)} className="shrink-0 text-amber-300 hover:text-amber-100">
              Dismiss
            </button>
          </div>
        )}

        <div className="flex min-h-0 flex-1">
        <div
          ref={scroller}
          className={cx('relative min-w-0 flex-1 overflow-auto', gesture && 'select-none')}
          onDoubleClick={(e) => {
            // anywhere empty, also outside the map when it is zoomed out; a card or an arrow means something else
            if (!onCreate || (e.target as Element).closest('[data-node],[data-edge],button,input')) return;
            const at = toCanvas(e);
            setDraft({ at: { x: Math.max(0, at.x - NODE_W / 2), y: Math.max(0, at.y - NODE_H / 2) }, linkFrom: null });
          }}
        >
          {!tasks.length && <p className="p-6 text-sm text-zinc-600 italic">No cards on this board yet.</p>}
          {/* the scaled map, inside a box of its scaled size so scrolling matches what is drawn */}
          <div className="relative" style={{ width: Math.max(size.width, 100) * zoom, height: Math.max(size.height, 100) * zoom }}>
          {draft && (
            // drawn outside the zoom, so the title is readable however far the map is zoomed out
            <NewCard
              at={inView({ x: draft.at.x * zoom, y: draft.at.y * zoom })}
              linkFrom={draft.linkFrom ? byId.get(draft.linkFrom) ?? null : null}
              onDone={createCard}
              onCancel={() => setDraft(null)}
            />
          )}
          <div
            className="relative origin-top-left"
            style={{ width: Math.max(size.width, 100), height: Math.max(size.height, 100), transform: `scale(${zoom})` }}
            data-zoom={zoom}
          >
            <svg className="absolute inset-0" width={size.width} height={size.height} aria-hidden="true">
              <defs>
                {(['idle', 'lit', 'derived', 'draft'] as const).map((tone) => (
                  <marker key={tone} id={`pk-arrow-${tone}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M0 0L10 5L0 10z" className={ARROW_FILL[tone]} />
                  </marker>
                ))}
              </defs>
              {edges.map((e) => {
                const a = positions[e.from];
                const b = positions[e.to];
                if (!a || !b) return null;
                const key = `${e.from}>${e.to}`;
                const { d } = shapeOf(a, b);
                const hot = hoverEdge === key || lit(e);
                const tone = e.kind === 'derived' ? 'derived' : hot ? 'lit' : 'idle';
                return (
                  <g key={key} className={cx('transition-opacity', linked && !lit(e) && 'opacity-25')}>
                    <path
                      d={d}
                      fill="none"
                      className={cx(LINE_STROKE[tone], 'transition-[stroke]')}
                      strokeWidth={hot ? 2.25 : 1.75}
                      strokeLinecap="round"
                      strokeDasharray={e.kind === 'derived' ? '5 4' : undefined}
                      markerEnd={`url(#pk-arrow-${tone})`}
                    />
                    {e.kind === 'related' && (
                      // a wide invisible stroke, so hovering the arrow is easy
                      <path
                        d={d}
                        fill="none"
                        stroke="transparent"
                        strokeWidth={16}
                        style={{ pointerEvents: 'stroke' }}
                        data-edge={key}
                        onPointerEnter={() => !removing.has(key) && showTrash(key)}
                        onPointerLeave={hideTrash}
                      >
                        <title>
                          #{byId.get(e.from)?.number} reads #{byId.get(e.to)?.number} as context
                        </title>
                      </path>
                    )}
                  </g>
                );
              })}
              {gesture?.kind === 'link' && positions[gesture.from] && (
                <path
                  d={shapeOf(positions[gesture.from], gesture.over ? positions[gesture.over] : { point: gesture.at }).d}
                  fill="none"
                  className={LINE_STROKE.draft}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeDasharray="4 3"
                  markerEnd="url(#pk-arrow-draft)"
                />
              )}
            </svg>

            {trashFor && !gesture && !removing.has(trashFor) && (() => {
              const [from, to] = trashFor.split('>');
              const a = positions[from];
              const b = positions[to];
              if (!a || !b) return null;
              const { mid } = shapeOf(a, b);
              return (
                <button
                  onPointerEnter={() => showTrash(trashFor)}
                  onPointerLeave={hideTrash}
                  onClick={() => {
                    setTrashFor(null);
                    setHoverEdge(null);
                    setRemoving((r) => new Set(r).add(trashFor));
                    onUnlink(from, to);
                  }}
                  aria-label={`Remove the link from #${byId.get(from)?.number} to #${byId.get(to)?.number}`}
                  title="Remove this link"
                  className="pk-press absolute z-30 flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-red-400/40 bg-[var(--color-surface-2)] text-red-300 shadow-lg transition hover:border-red-400 hover:bg-red-500/20 hover:text-red-200"
                  style={{ left: mid.x, top: mid.y }}
                >
                  <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                    <path d="M2.5 4.5h11M6.5 4.5V3h3v1.5M4 4.5l.7 8.5h6.6l.7-8.5M6.8 7v4M9.2 7v4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              );
            })()}

            {tasks.map((task) => {
              const p = positions[task.id];
              if (!p) return null;
              const accent = ACCENT[task.column];
              const dragging = gesture?.kind === 'move' && gesture.id === task.id && gesture.moved;
              const target = gesture?.kind === 'link' && gesture.over === task.id;
              return (
                <div
                  key={task.id}
                  data-node={task.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`#${task.number} ${task.title}`}
                  onKeyDown={(e) => e.key === 'Enter' && open(task.id)}
                  onPointerEnter={() => setHoverNode(task.id)}
                  onPointerLeave={() => setHoverNode((h) => (h === task.id ? null : h))}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    const at = toCanvas(e);
                    setGesture({ kind: 'move', id: task.id, offset: { x: at.x - p.x, y: at.y - p.y }, start: at, moved: false });
                  }}
                  className={cx(
                    'group absolute flex cursor-grab flex-col justify-between rounded-lg border bg-[var(--color-surface-2)] px-3 py-2 shadow-sm',
                    dragging ? 'z-20 cursor-grabbing border-sky-400/50 shadow-xl' : front === task.id ? 'z-[15]' : 'z-10',
                    target
                      ? 'border-sky-400 ring-2 ring-sky-400/30'
                      : openCard === task.id
                        ? 'border-sky-400/70 ring-1 ring-sky-400/40'
                        : 'border-white/[0.08] hover:border-white/[0.16]',
                    tidying && !dragging && 'transition-[left,top] duration-300 ease-out',
                    linked && !linked.has(task.id) && 'opacity-40',
                    task.column === 'done' && 'opacity-80',
                  )}
                  style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
                >
                  <span className="flex items-center gap-1.5 text-[10px] text-zinc-500">
                    <span className={cx('size-1.5 shrink-0 rounded-full', accent.dot)} />
                    <span className={accent.text}>{COLUMN_LABELS[task.column]}</span>
                    {task.type && <span>· {TYPE_LABELS[task.type]}</span>}
                    <span className="ml-auto font-mono text-zinc-600">#{task.number}</span>
                  </span>
                  <span className="line-clamp-2 text-[12px] leading-snug text-zinc-200">{task.title}</span>

                  <span
                    role="button"
                    aria-label={`Link #${task.number} to another card`}
                    title="Drag onto another card: this card will read it as context"
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.preventDefault();
                      e.stopPropagation();
                      setNotice(null);
                      setGesture({ kind: 'link', from: task.id, at: toCanvas(e), over: null });
                    }}
                    className={cx(
                      'absolute top-1/2 -right-[7px] size-3.5 -translate-y-1/2 cursor-crosshair rounded-full border-2 border-[var(--color-surface-1)] bg-sky-400 transition',
                      gesture?.kind === 'link' && gesture.from === task.id ? 'scale-125 opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100',
                    )}
                  />
                </div>
              );
            })}
          </div>
          </div>
        </div>

        {openCard && renderCard && (
          <div className="pk-drawer w-[min(560px,48%)] shrink-0 border-l border-white/[0.07]">
            {renderCard(openCard, closeCard, setOpenCard)}
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

/** The pointer is clearly outside the card a link started from, so a drop there is on empty space. */
function awayFrom(box: Point, at: Point): boolean {
  return at.x < box.x - 24 || at.x > box.x + NODE_W + 24 || at.y < box.y - 24 || at.y > box.y + NODE_H + 24;
}

/** A card being named, in the spot it will take. Enter makes it, Esc or leaving it empty does not. */
function NewCard({
  at,
  linkFrom,
  onDone,
  onCancel,
}: {
  at: Point;
  linkFrom: Task | null;
  onDone: (title: string) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save && title.trim()) onDone(title);
    else onCancel();
  };
  return (
    <div
      className="absolute z-30 flex flex-col justify-center gap-1 rounded-lg border border-sky-400/60 bg-[var(--color-surface-2)] px-3 py-2 shadow-xl ring-2 ring-sky-400/20"
      style={{ left: at.x, top: at.y, width: NODE_W, minHeight: NODE_H }}
    >
      <span className="text-[10px] text-zinc-500">
        New card in Backlog{linkFrom ? ` · read by #${linkFrom.number}` : ''}
      </span>
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') finish(true);
          if (e.key === 'Escape') {
            e.stopPropagation();
            finish(false);
          }
        }}
        onBlur={() => finish(true)}
        placeholder="Title, then Enter"
        aria-label="New card title"
        className="w-full bg-transparent text-[12px] text-zinc-100 outline-none placeholder:text-zinc-600"
      />
    </div>
  );
}

const LINE_STROKE = {
  idle: 'stroke-zinc-500',
  lit: 'stroke-sky-300',
  derived: 'stroke-violet-400/80',
  draft: 'stroke-sky-400',
} as const;

const ARROW_FILL = {
  idle: 'fill-zinc-500',
  lit: 'fill-sky-300',
  derived: 'fill-violet-400/80',
  draft: 'fill-sky-400',
} as const;

function Legend() {
  return (
    <span className="hidden items-center gap-3 text-[10.5px] text-zinc-500 lg:flex">
      <span className="flex items-center gap-1.5">
        <svg width="26" height="8" aria-hidden="true">
          <line x1="0" y1="4" x2="20" y2="4" className="stroke-zinc-500" strokeWidth="1.5" />
          <path d="M19 0L26 4L19 8z" className="fill-zinc-500" />
        </svg>
        reads as context
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="26" height="8" aria-hidden="true">
          <line x1="0" y1="4" x2="20" y2="4" className="stroke-violet-400/80" strokeWidth="1.5" strokeDasharray="4 3" />
          <path d="M19 0L26 4L19 8z" className="fill-violet-400/80" />
        </svg>
        derived from
      </span>
    </span>
  );
}
