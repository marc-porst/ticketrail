import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeTask, type Task } from '../src/core/task.ts';
import {
  NODE_H,
  NODE_W,
  arrow,
  edgesOf,
  loadPositions,
  placeMissing,
  fitZoom,
  savePositions,
  tidyLayout,
  tidyToFit,
} from '../web/src/lib/graph.ts';
import { RelationsModal } from '../web/src/components/RelationsModal.tsx';

const card = (n: number, extra: object = {}): Task =>
  normalizeTask({ id: `t_${n}`, number: n, title: `Card ${n}`, column: 'backlog', ...extra }, `t_${n}`);

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('relations layout', () => {
  it('draws related links and derived-from links, never to cards that are not shown', () => {
    const tasks = [card(1, { related: ['t_2', 't_gone'] }), card(2), card(3, { derivedFrom: 't_1' })];
    expect(edgesOf(tasks)).toEqual([
      { from: 't_1', to: 't_2', kind: 'related' },
      { from: 't_3', to: 't_1', kind: 'derived' },
    ]);
  });

  it('lays a chain out left to right, and lone cards in a grid underneath', () => {
    const tasks = [card(1, { related: ['t_2'] }), card(2, { related: ['t_3'] }), card(3), card(4), card(5)];
    const p = tidyLayout(tasks, 1100);
    expect(p.t_1.x).toBeLessThan(p.t_2.x);
    expect(p.t_2.x).toBeLessThan(p.t_3.x);
    expect(p.t_1.y).toBe(p.t_2.y);
    const chainBottom = Math.max(p.t_1.y, p.t_2.y, p.t_3.y) + NODE_H;
    expect(p.t_4.y).toBeGreaterThan(chainBottom);
    expect(p.t_4.y).toBe(p.t_5.y);
  });

  it('wraps a long chain onto the next band instead of one very wide row', () => {
    const tasks = Array.from({ length: 8 }, (_, i) => card(i + 1, i < 7 ? { related: [`t_${i + 2}`] } : {}));
    const p = tidyLayout(tasks, 1100); // three columns fit 1100 px
    const xs = new Set(Object.values(p).map((q) => q.x));
    expect(xs.size).toBe(3);
    // the chain still reads left to right within a band, and later bands sit lower
    expect(p.t_1.x).toBeLessThan(p.t_2.x);
    expect(p.t_4.y).toBeGreaterThan(p.t_1.y);
    expect(p.t_4.x).toBe(p.t_1.x);
    const spots = new Set(Object.values(p).map((q) => `${q.x},${q.y}`));
    expect(spots.size).toBe(8);
  });

  it('tidies up for the window: picks the layout width that fits it at the largest zoom', () => {
    const chain = Array.from({ length: 12 }, (_, i) => card(i + 1, i < 11 ? { related: [`t_${i + 2}`] } : {}));
    const loose = Array.from({ length: 30 }, (_, i) => card(100 + i));
    const tasks = [...chain, ...loose];
    const best = tidyToFit(tasks, 1390, 660);
    const zoom = fitZoom(best, 1390, 660);
    for (const w of [1390, 1390 * 3, 1390 * 6]) expect(zoom).toBeGreaterThanOrEqual(fitZoom(tidyLayout(tasks, w), 1390, 660));
    expect(zoom).toBeGreaterThan(0.45);
  });

  it('survives a cycle and never stacks two cards on the same spot', () => {
    const tasks = [card(1, { related: ['t_2'] }), card(2, { related: ['t_3'] }), card(3, { related: ['t_1'] }), card(4, { related: ['t_1'] })];
    const p = tidyLayout(tasks);
    const spots = new Set(Object.values(p).map((q) => `${q.x},${q.y}`));
    expect(spots.size).toBe(4);
  });

  it('keeps arranged cards where they are and finds room for new ones below', () => {
    const tasks = [card(1), card(2), card(3)];
    const saved = { t_1: { x: 500, y: 300 }, t_2: { x: 40, y: 40 } };
    const p = placeMissing(tasks, saved);
    expect(p.t_1).toEqual({ x: 500, y: 300 });
    expect(p.t_3.y).toBeGreaterThan(300 + NODE_H);
    // a card no longer on the board is dropped
    expect(Object.keys(placeMissing([card(2)], saved))).toEqual(['t_2']);
  });

  it('draws a straight arrow from the edge of one card to just short of the other', () => {
    const { start, end, mid } = arrow({ x: 0, y: 0 }, { x: 400, y: 0 });
    expect(start).toEqual({ x: NODE_W, y: NODE_H / 2 });
    expect(end).toEqual({ x: 400 - 3, y: NODE_H / 2 });
    expect(mid).toEqual({ x: (NODE_W + 397) / 2, y: NODE_H / 2 });
  });

  it('runs top to bottom when the cards are stacked', () => {
    const { start, end } = arrow({ x: 0, y: 0 }, { x: 0, y: 300 });
    expect(start).toEqual({ x: NODE_W / 2, y: NODE_H });
    expect(end).toEqual({ x: NODE_W / 2, y: 300 - 3 });
  });

  it('ends at the pointer while a link is being drawn', () => {
    expect(arrow({ x: 0, y: 0 }, { point: { x: 500, y: 90 } }).end).toEqual({ x: 500, y: 90 });
  });

  it('remembers positions per project and ignores junk', () => {
    savePositions('p1', { t_1: { x: 1, y: 2 } });
    expect(loadPositions('p1')).toEqual({ t_1: { x: 1, y: 2 } });
    expect(loadPositions('p2')).toEqual({});
    localStorage.setItem('pk:relations:p3', '{"t_1":{"x":"no"}, "t_2": null}');
    expect(loadPositions('p3')).toEqual({});
  });
});

describe('relations view', () => {
  const view = (tasks: Task[], handlers: Partial<Parameters<typeof RelationsModal>[0]> = {}) =>
    render(
      <RelationsModal
        projectId="p"
        tasks={tasks}
        onClose={vi.fn()}
        onOpenCard={vi.fn()}
        onLink={vi.fn(() => null)}
        onUnlink={vi.fn()}
        {...handlers}
      />,
    );

  it('shows every card and an arrow for each link', () => {
    const { container } = view([card(1, { related: ['t_2'] }), card(2), card(3, { derivedFrom: 't_1' })]);
    for (const n of [1, 2, 3]) expect(screen.getByRole('button', { name: `#${n} Card ${n}` })).toBeTruthy();
    expect(container.querySelectorAll('path[marker-end]')).toHaveLength(2);
  });

  it('removes a link only through the trash button that hovering its cable shows', () => {
    const onUnlink = vi.fn();
    const { container } = view([card(1, { related: ['t_2'] }), card(2)], { onUnlink });
    const wire = container.querySelector('[data-edge="t_1>t_2"]')!;
    // a click on the cable itself does nothing
    fireEvent.click(wire);
    expect(onUnlink).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Remove the link/ })).toBeNull();

    fireEvent.pointerEnter(wire);
    fireEvent.click(screen.getByRole('button', { name: 'Remove the link from #1 to #2' }));
    expect(onUnlink).toHaveBeenCalledWith('t_1', 't_2');
  });

  it('does not bring the trash button back for a link that is being removed', () => {
    const tasks = [card(1, { related: ['t_2'] }), card(2)];
    const { container, rerender } = view(tasks);
    const wire = container.querySelector('[data-edge="t_1>t_2"]')!;
    fireEvent.pointerEnter(wire);
    fireEvent.click(screen.getByRole('button', { name: /Remove the link/ }));
    // the board has not caught up yet and the pointer is still on the cable
    fireEvent.pointerEnter(wire);
    expect(screen.queryByRole('button', { name: /Remove the link/ })).toBeNull();
    // then the link is gone from the board
    rerender(
      <RelationsModal projectId="p" tasks={[card(1), card(2)]} onClose={vi.fn()} onOpenCard={vi.fn()} onLink={vi.fn(() => null)} onUnlink={vi.fn()} />,
    );
    expect(container.querySelector('[data-edge]')).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove the link/ })).toBeNull();
  });

  it('hides the trash button again once the pointer has left the cable', () => {
    vi.useFakeTimers();
    try {
      const { container } = view([card(1, { related: ['t_2'] }), card(2)]);
      const wire = container.querySelector('[data-edge="t_1>t_2"]')!;
      fireEvent.pointerEnter(wire);
      fireEvent.pointerLeave(wire);
      // still there for a moment, so the pointer can get to it
      expect(screen.getByRole('button', { name: /Remove the link/ })).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(screen.queryByRole('button', { name: /Remove the link/ })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('links two cards when a line is drawn from one handle onto another card', () => {
    const onLink = vi.fn(() => null);
    view([card(1), card(2)], { onLink });
    const target = screen.getByRole('button', { name: '#2 Card 2' });
    document.elementFromPoint = vi.fn(() => target);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Link #1 to another card' }), { button: 0, clientX: 5, clientY: 5 });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 40 }));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup', { clientX: 300, clientY: 40 }));
    });
    expect(onLink).toHaveBeenCalledWith('t_1', 't_2');
  });

  it('shows why a link could not be made', () => {
    view([card(1), card(2)], { onLink: () => 'These cards are already linked.' });
    document.elementFromPoint = vi.fn(() => screen.getByRole('button', { name: '#2 Card 2' }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Link #1 to another card' }), { button: 0 });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 40 }));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup'));
    });
    expect(screen.getByText('These cards are already linked.')).toBeTruthy();
  });

  it('opens a card on a click that is not a drag', () => {
    const onOpenCard = vi.fn();
    view([card(1)], { onOpenCard });
    fireEvent.pointerDown(screen.getByRole('button', { name: '#1 Card 1' }), { button: 0, clientX: 10, clientY: 10 });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup'));
    });
    expect(onOpenCard).toHaveBeenCalledWith('t_1');
  });

  it('moves a dragged card, keeps it on top and remembers where it went', () => {
    const onOpenCard = vi.fn();
    view([card(1), card(2)], { onOpenCard });
    const node = screen.getByRole('button', { name: '#1 Card 1' });
    const before = { left: node.style.left, top: node.style.top };
    fireEvent.pointerDown(node, { button: 0, clientX: 10, clientY: 10 });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 210, clientY: 160 }));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup'));
    });
    expect(onOpenCard).not.toHaveBeenCalled();
    expect({ left: node.style.left, top: node.style.top }).not.toEqual(before);
    expect(node.className).toContain('z-[15]');
    expect(loadPositions('p').t_1).toEqual({ x: parseFloat(node.style.left), y: parseFloat(node.style.top) });
  });

  it('opens a clicked card in a panel inside the view, and Esc closes the panel before the view', () => {
    const onClose = vi.fn();
    const renderCard = vi.fn((id: string, close: () => void, openOther: (id: string) => void) => (
      <div>
        <p>Detail of {id}</p>
        <button onClick={close}>close panel</button>
        <button onClick={() => openOther('t_2')}>go to 2</button>
      </div>
    ));
    view([card(1, { related: ['t_2'] }), card(2)], { onClose, renderCard, onOpenCard: undefined });
    const node = screen.getByRole('button', { name: '#1 Card 1' });
    fireEvent.pointerDown(node, { button: 0, clientX: 10, clientY: 10 });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup'));
    });
    expect(screen.getByText('Detail of t_1')).toBeTruthy();
    // the map is still there, with the open card marked
    expect(screen.getByRole('button', { name: '#2 Card 2' })).toBeTruthy();
    expect(node.className).toContain('ring-sky-400/40');

    fireEvent.click(screen.getByText('go to 2'));
    expect(screen.getByText('Detail of t_2')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText(/Detail of/)).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('makes a new card from the button, where it can be seen', async () => {
    const created = card(9, { title: 'Fresh idea' });
    const onCreate = vi.fn(async () => created);
    view([card(1)], { onCreate });
    fireEvent.click(screen.getByRole('button', { name: '+ New card' }));
    const input = screen.getByRole('textbox', { name: 'New card title' });
    fireEvent.change(input, { target: { value: 'Fresh idea' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(onCreate).toHaveBeenCalledWith('Fresh idea');
    expect(loadPositions('p').t_9).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'New card title' })).toBeNull();
  });

  it('makes a new card where empty space is double-clicked, and Esc or an empty title makes none', async () => {
    const onCreate = vi.fn(async () => card(9));
    const { container } = view([card(1)], { onCreate });
    const canvas = container.querySelector('[data-node]')!.parentElement!;
    fireEvent.doubleClick(canvas, { clientX: 600, clientY: 400 });
    const input = screen.getByRole('textbox', { name: 'New card title' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'New card title' })).toBeNull();

    fireEvent.doubleClick(canvas, { clientX: 600, clientY: 400 });
    fireEvent.blur(screen.getByRole('textbox', { name: 'New card title' }));
    expect(onCreate).not.toHaveBeenCalled();

    // a double-click on a card is not a request for a new one
    fireEvent.doubleClick(screen.getByRole('button', { name: '#1 Card 1' }));
    expect(screen.queryByRole('textbox', { name: 'New card title' })).toBeNull();
  });

  it('makes a new linked card when a link is dropped on empty space', async () => {
    const onCreate = vi.fn(async () => card(9, { title: 'Follow-up' }));
    const onLink = vi.fn(() => null);
    view([card(1)], { onCreate, onLink });
    document.elementFromPoint = vi.fn(() => null);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Link #1 to another card' }), { button: 0, clientX: 210, clientY: 72 });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 700, clientY: 400 }));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup'));
    });
    expect(screen.getByText('New card in Backlog · read by #1')).toBeTruthy();
    const input = screen.getByRole('textbox', { name: 'New card title' });
    fireEvent.change(input, { target: { value: 'Follow-up' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(onCreate).toHaveBeenCalledWith('Follow-up');
    expect(onLink).toHaveBeenCalledWith('t_1', 't_9');
  });

  it('zooms in and out, and maps the pointer through the zoom', () => {
    const onCreate = vi.fn(async () => null);
    const { container } = view([card(1)], { onCreate });
    const fitButton = screen.getByRole('button', { name: 'Zoom to fit' });
    expect(fitButton.textContent).toBe('100%');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(fitButton.textContent).toBe('120%');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(fitButton.textContent).toBe('83%');
    const map = container.querySelector('[data-zoom]') as HTMLElement;
    expect(map.style.transform).toBe('scale(0.83)');
    // a double-click at 415 px on screen is at 500 px on the map, also outside the drawn map
    fireEvent.doubleClick(map.parentElement!.parentElement!, { clientX: 415, clientY: 415 });
    // the naming box is drawn unzoomed, at that map spot times the zoom
    const draft = screen.getByRole('textbox', { name: 'New card title' }).parentElement as HTMLElement;
    expect(parseFloat(draft.style.left)).toBeCloseTo((500 - NODE_W / 2) * 0.83, 0);
    // never past the limits
    for (let i = 0; i < 20; i++) fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(fitButton.textContent).toBe('30%');
  });

  it('tidies up into a layout it remembers', () => {
    view([card(1, { related: ['t_2'] }), card(2)]);
    savePositions('p', {});
    fireEvent.click(screen.getByRole('button', { name: 'Tidy up' }));
    const saved = loadPositions('p');
    expect(saved.t_1.x).toBeLessThan(saved.t_2.x);
  });
});
