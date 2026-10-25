import type { Task } from './types.ts';

/** A card's box in the relations view, in canvas pixels. */
export const NODE_W = 210;
export const NODE_H = 64;
const GAP_X = 110;
const GAP_Y = 28;
const MARGIN = 40;
/** Space between one group of linked cards and the next. */
const GROUP_GAP = 56;

export interface Point {
  x: number;
  y: number;
}

export type Positions = Record<string, Point>;

/**
 * An arrow in the view. `related` is stored on the card that reads the other
 * one as context, so the arrow points from that card to the one it reads;
 * `derived` points from a card to the investigation it was spawned from.
 */
export interface Edge {
  from: string;
  to: string;
  kind: 'related' | 'derived';
}

export function edgesOf(tasks: Task[]): Edge[] {
  const ids = new Set(tasks.map((t) => t.id));
  const edges: Edge[] = [];
  for (const t of tasks) {
    for (const r of t.related ?? []) if (ids.has(r)) edges.push({ from: t.id, to: r, kind: 'related' });
    if (t.derivedFrom && ids.has(t.derivedFrom) && !(t.related ?? []).includes(t.derivedFrom)) {
      edges.push({ from: t.id, to: t.derivedFrom, kind: 'derived' });
    }
  }
  return edges;
}

/** Groups of cards joined by any arrow, biggest first; lone cards are left out. */
function components(ids: string[], edges: Edge[]): string[][] {
  const next = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
  for (const e of edges) {
    next.get(e.from)?.add(e.to);
    next.get(e.to)?.add(e.from);
  }
  const seen = new Set<string>();
  const groups: string[][] = [];
  for (const id of ids) {
    if (seen.has(id) || !next.get(id)?.size) continue;
    const group: string[] = [];
    const stack = [id];
    seen.add(id);
    while (stack.length) {
      const at = stack.pop()!;
      group.push(at);
      for (const n of next.get(at) ?? []) if (!seen.has(n)) (seen.add(n), stack.push(n));
    }
    groups.push(group);
  }
  return groups.sort((a, b) => b.length - a.length);
}

/**
 * Columns within one group: a card sits one column left of every card it
 * points at, so arrows run left to right. Cycles are cut where they close.
 */
function layers(group: string[], edges: Edge[]): string[][] {
  const out = new Map<string, string[]>(group.map((id) => [id, []]));
  for (const e of edges) if (out.has(e.from) && out.has(e.to)) out.get(e.from)!.push(e.to);

  // depth = the longest path of arrows below a card; a card nothing points at from below is depth 0
  const depth = new Map<string, number>();
  const onPath = new Set<string>();
  const visit = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (onPath.has(id)) return 0; // a cycle: treat the back edge as absent
    onPath.add(id);
    let d = 0;
    for (const n of out.get(id)!) d = Math.max(d, visit(n) + 1);
    onPath.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const id of group) visit(id);

  const max = Math.max(...depth.values());
  const columns: string[][] = Array.from({ length: max + 1 }, () => []);
  // deepest on the left: the card that reads the most context starts the chain
  for (const id of group) columns[max - depth.get(id)!].push(id);
  return columns;
}

/** Reorder each column by the average row of its neighbours, a few sweeps, to uncross arrows. */
function untangle(columns: string[][], edges: Edge[]): void {
  const near = new Map<string, string[]>();
  for (const e of edges) {
    near.set(e.from, [...(near.get(e.from) ?? []), e.to]);
    near.set(e.to, [...(near.get(e.to) ?? []), e.from]);
  }
  const rowOf = () => {
    const row = new Map<string, number>();
    columns.forEach((col) => col.forEach((id, i) => row.set(id, i)));
    return row;
  };
  for (let sweep = 0; sweep < 4; sweep++) {
    const order = sweep % 2 === 0 ? columns.slice(1) : columns.slice(0, -1).reverse();
    for (const col of order) {
      const row = rowOf();
      const score = (id: string) => {
        const rows = (near.get(id) ?? []).map((n) => row.get(n)).filter((r): r is number => r !== undefined);
        return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : (row.get(id) ?? 0);
      };
      const scored = new Map(col.map((id) => [id, score(id)]));
      col.sort((a, b) => scored.get(a)! - scored.get(b)!);
    }
  }
}

/**
 * A tidy arrangement: each group of linked cards laid out left to right in
 * columns, groups stacked from the biggest down, and cards with no links in a
 * grid underneath. A group with more columns than fit `width` wraps onto the
 * next band, like a line of text, so a long chain does not force the whole
 * map to be zoomed far out. Cards are taken in board order, so the result is
 * stable.
 */
export function tidyLayout(tasks: Task[], width = 1100): Positions {
  const ids = tasks.map((t) => t.id);
  const edges = edgesOf(tasks);
  const positions: Positions = {};
  let top = MARGIN;

  for (const group of components(ids, edges)) {
    const columns = layers(group, edges);
    untangle(columns, edges);
    const perBand = Math.max(2, Math.floor((width - MARGIN * 2 + GAP_X) / (NODE_W + GAP_X)));
    for (let first = 0; first < columns.length; first += perBand) {
      const band = columns.slice(first, first + perBand);
      const tallest = Math.max(...band.map((c) => c.length));
      band.forEach((col, x) => {
        // centre shorter columns against the tallest one
        const offset = ((tallest - col.length) * (NODE_H + GAP_Y)) / 2;
        col.forEach((id, y) => {
          positions[id] = { x: MARGIN + x * (NODE_W + GAP_X), y: top + offset + y * (NODE_H + GAP_Y) };
        });
      });
      // a wrapped band sits a little closer than the next group does
      top += tallest * (NODE_H + GAP_Y) - GAP_Y + (first + perBand < columns.length ? GAP_Y * 2 : GROUP_GAP);
    }
  }

  const loose = ids.filter((id) => !positions[id]);
  const perRow = Math.max(1, Math.floor((width - MARGIN * 2 + GAP_Y) / (NODE_W + GAP_Y)));
  loose.forEach((id, i) => {
    positions[id] = {
      x: MARGIN + (i % perRow) * (NODE_W + GAP_Y),
      y: top + Math.floor(i / perRow) * (NODE_H + GAP_Y),
    };
  });
  return positions;
}

/**
 * The zoom at which `positions` fit a window of `width` × `height`, at most
 * 1, rounded down so the map never ends up a pixel too big.
 */
export function fitZoom(positions: Positions, width: number, height: number): number {
  const whole = canvasSize(positions);
  return Math.floor(Math.min(1, width / whole.width, height / whole.height) * 100) / 100;
}

/**
 * Tidy up for a window of `width` × `height`: lay the map out at a few
 * widths and keep the one that fits the window at the largest zoom. Too
 * narrow and a tall map has to be shrunk; too wide and a long one does.
 */
export function tidyToFit(tasks: Task[], width: number, height: number): Positions {
  let best: Positions | null = null;
  let bestZoom = -1;
  for (const stretch of [1, 1.25, 1.6, 2, 2.6, 3.4]) {
    const layout = tidyLayout(tasks, width * stretch);
    const zoom = fitZoom(layout, width, height);
    // prefer the narrower layout on a tie: less to scan from side to side
    if (zoom > bestZoom + 0.005) {
      best = layout;
      bestZoom = zoom;
    }
  }
  return best ?? tidyLayout(tasks, width);
}

/**
 * Keep the positions the user arranged, and find a free spot below them for
 * any card that has none yet (new since the view was last opened).
 */
export function placeMissing(tasks: Task[], saved: Positions, width = 1100): Positions {
  const known = tasks.filter((t) => saved[t.id]);
  if (!known.length) return tidyLayout(tasks, width);
  const positions: Positions = {};
  for (const t of known) positions[t.id] = saved[t.id];
  const missing = tasks.filter((t) => !saved[t.id]);
  if (!missing.length) return positions;
  const bottom = Math.max(...known.map((t) => saved[t.id].y)) + NODE_H + GROUP_GAP;
  const perRow = Math.max(1, Math.floor((width - MARGIN * 2 + GAP_Y) / (NODE_W + GAP_Y)));
  missing.forEach((t, i) => {
    positions[t.id] = { x: MARGIN + (i % perRow) * (NODE_W + GAP_Y), y: bottom + Math.floor(i / perRow) * (NODE_H + GAP_Y) };
  });
  return positions;
}

/** Where the line from the centre of `a` towards the centre of `b` leaves box `a`. */
export function exitPoint(a: Point, b: Point, pad = 0): Point {
  const cx = a.x + NODE_W / 2;
  const cy = a.y + NODE_H / 2;
  const dx = b.x + NODE_W / 2 - cx;
  const dy = b.y + NODE_H / 2 - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const hw = NODE_W / 2 + pad;
  const hh = NODE_H / 2 + pad;
  const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  return { x: cx + dx * t, y: cy + dy * t };
}

/**
 * The straight arrow between two cards: from the edge of `a` to just short
 * of the edge of `b`, so the arrowhead stays visible. While a link is being
 * drawn, `b` is the pointer rather than a card.
 */
export function arrow(a: Point, b: Point | { point: Point }): { start: Point; end: Point; mid: Point } {
  const target = 'point' in b ? { x: b.point.x - NODE_W / 2, y: b.point.y - NODE_H / 2 } : b;
  const start = exitPoint(a, target);
  const end = 'point' in b ? b.point : exitPoint(b, a, 3);
  return { start, end, mid: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 } };
}

/** The canvas size that holds every card with a margin to spare. */
export function canvasSize(positions: Positions): { width: number; height: number } {
  let width = 0;
  let height = 0;
  for (const p of Object.values(positions)) {
    width = Math.max(width, p.x + NODE_W);
    height = Math.max(height, p.y + NODE_H);
  }
  return { width: width + MARGIN * 3, height: height + MARGIN * 3 };
}

const keyFor = (projectId: string) => `pk:relations:${projectId}`;

/** Card positions from an earlier visit. This browser only: it is how you look at the board. */
export function loadPositions(projectId: string): Positions {
  try {
    const raw = JSON.parse(localStorage.getItem(keyFor(projectId)) ?? '{}');
    const out: Positions = {};
    for (const [id, p] of Object.entries(raw ?? {})) {
      const { x, y } = (p ?? {}) as Partial<Point>;
      if (Number.isFinite(x) && Number.isFinite(y)) out[id] = { x: x!, y: y! };
    }
    return out;
  } catch {
    return {};
  }
}

export function savePositions(projectId: string, positions: Positions): void {
  try {
    localStorage.setItem(keyFor(projectId), JSON.stringify(positions));
  } catch {
    /* private window or full storage: the layout just is not remembered */
  }
}
