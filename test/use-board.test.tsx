import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyBoardChange, useBoard } from '../web/src/lib/useBoard.ts';

const task = (id: string, column: string, extra: Record<string, unknown> = {}) => ({
  id,
  number: Number(id.slice(1)),
  title: id,
  description: '',
  column,
  order: 'a',
  labels: [],
  attachments: [],
  activity: [],
  messages: [],
  related: [],
  createdAt: '2026-10-17T00:00:00.000Z',
  updatedAt: '2026-10-17T00:00:00.000Z',
  ...extra,
});

let listeners: Record<string, (event: MessageEvent) => void>;
let boardOnServer: any[];

const emit = (type: string, data: unknown) =>
  act(() => listeners[type]!(new MessageEvent(type, { data: JSON.stringify(data) })));

const columnOf = (result: { current: ReturnType<typeof useBoard> }, id: string) =>
  result.current.snapshot?.tasks.find((t) => t.id === id)?.column;

beforeEach(() => {
  listeners = {};
  boardOnServer = [];
  vi.stubGlobal(
    'EventSource',
    class {
      onerror: (() => void) | null = null;
      addEventListener(type: string, fn: (event: MessageEvent) => void) {
        listeners[type] = fn;
      }
      close() {}
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ columns: [], folders: [], tasks: boardOnServer }) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

async function connected() {
  const hook = renderHook(() => useBoard('p1'));
  await waitFor(() => expect(listeners.snapshot).toBeDefined());
  await emit('snapshot', { columns: [], folders: [], tasks: [task('t1', 'in-progress'), task('t2', 'implement')] });
  return hook;
}

describe('board updates', () => {
  it('applies a change idempotently', () => {
    const before = [task('t1', 'in-progress')] as any;
    const change = { type: 'updated' as const, id: 't1', task: task('t1', 'done') as any };
    const once = applyBoardChange(before, change);
    expect(applyBoardChange(once, change)).toEqual(once);
    expect(applyBoardChange(once, { type: 'deleted', id: 't1' })).toEqual([]);
  });

  // The bug: Claude finished a card while you were dragging another; the
  // second held update was built from the pre-drag board and erased the first.
  it('keeps every update that arrives during a drag, not just the last one', async () => {
    const { result } = await connected();

    act(() => result.current.pause(true));
    await emit('board', { type: 'updated', id: 't1', task: task('t1', 'done') });
    await emit('board', { type: 'updated', id: 't2', task: task('t2', 'in-progress') });
    // held back while dragging
    expect(columnOf(result, 't1')).toBe('in-progress');

    act(() => result.current.pause(false));
    expect(columnOf(result, 't1')).toBe('done');
    expect(columnOf(result, 't2')).toBe('in-progress');
  });

  it('re-reads the board when the tab becomes visible again', async () => {
    const { result } = await connected();
    boardOnServer = [task('t1', 'done'), task('t2', 'implement')];

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(columnOf(result, 't1')).toBe('done'));
  });
});
