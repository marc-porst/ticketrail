import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/core/store.ts';
import { COLUMN_HINTS, COLUMN_LABELS } from '../src/core/task.ts';
import { ColumnView } from '../web/src/components/ColumnView.tsx';
import { useDensity } from '../web/src/lib/useDensity.ts';
import { useCollapsed } from '../web/src/lib/useCollapsed.ts';
import type { Task } from '../src/core/task.ts';

let root: string;
let store: Store;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-density-'));
  store = Store.init(root);
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  fs.rmSync(root, { recursive: true, force: true });
});

function Lane({ tasks, compact, limit }: { tasks: Task[]; compact?: boolean; limit?: number }) {
  return (
    <DndContext>
      <ColumnView
        meta={{ id: 'done', label: COLUMN_LABELS.done, hint: COLUMN_HINTS.done }}
        tasks={tasks}
        overCardId={null}
        compact={compact}
        limit={limit}
        onOpen={() => {}}
      />
    </DndContext>
  );
}

const many = (n: number) => Array.from({ length: n }, (_, i) => store.create({ title: `Shipped ${i + 1}`, column: 'done' }));

describe('card density', () => {
  it('is comfortable by default and remembers compact in this browser', () => {
    const { result } = renderHook(() => useDensity());
    expect(result.current[0]).toBe('comfortable');

    act(() => result.current[1]('compact'));
    expect(result.current[0]).toBe('compact');
    expect(renderHook(() => useDensity()).result.current[0]).toBe('compact');

    act(() => result.current[1]('comfortable'));
    expect(localStorage.getItem('pk:density')).toBeNull();
  });

  it('drops the lane hint and the per-card details in compact mode', () => {
    many(1);
    const { rerender } = render(<Lane tasks={store.list()} />);
    expect(screen.getByText(COLUMN_HINTS.done)).toBeTruthy();

    rerender(<Lane tasks={store.list()} compact />);
    expect(screen.queryByText(COLUMN_HINTS.done)).toBeNull();
    expect(screen.getByText('Shipped 1')).toBeTruthy();
  });
});

describe('done lane limit', () => {
  it('folds older cards away and shows them on request', () => {
    many(9);
    render(<Lane tasks={store.list()} limit={6} />);
    expect(screen.getAllByText(/^Shipped \d+$/)).toHaveLength(6);

    fireEvent.click(screen.getByText('Show 3 older cards'));
    expect(screen.getAllByText(/^Shipped \d+$/)).toHaveLength(9);

    fireEvent.click(screen.getByText('Show fewer'));
    expect(screen.getAllByText(/^Shipped \d+$/)).toHaveLength(6);
  });

  it('shows no toggle when the lane fits', () => {
    many(6);
    render(<Lane tasks={store.list()} limit={6} />);
    expect(screen.queryByText(/older card/)).toBeNull();
  });
});

describe('folding a lane', () => {
  function FoldableLane({ tasks }: { tasks: Task[] }) {
    const collapsed = useCollapsed('p1');
    return (
      <DndContext>
        <ColumnView
          meta={{ id: 'done', label: COLUMN_LABELS.done, hint: COLUMN_HINTS.done }}
          tasks={tasks}
          overCardId={null}
          collapsed={collapsed}
          onOpen={() => {}}
        />
      </DndContext>
    );
  }

  it('folds to a rail without cards, keeps the count, and is remembered', () => {
    many(2);
    const { unmount } = render(<FoldableLane tasks={store.list()} />);
    expect(screen.getByText('Shipped 1')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Fold lane Done'));
    expect(screen.queryByText('Shipped 1')).toBeNull();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy();

    unmount();
    render(<FoldableLane tasks={store.list()} />);
    expect(screen.queryByText('Shipped 1')).toBeNull();
    fireEvent.click(screen.getByLabelText('Expand lane Done'));
    expect(screen.getByText('Shipped 1')).toBeTruthy();
  });
});
