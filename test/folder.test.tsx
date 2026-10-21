import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/core/store.ts';
import { BoardWatcher } from '../src/core/watch.ts';
import { laneOrder, normalizeFolders, type Folder } from '../src/core/folder.ts';
import { COLUMN_HINTS, COLUMN_LABELS } from '../src/core/task.ts';
import { resolveDrop, folderDropId } from '../web/src/lib/drop.ts';
import { ColumnView } from '../web/src/components/ColumnView.tsx';
import { useCollapsed } from '../web/src/lib/useCollapsed.ts';
import type { Task } from '../src/core/task.ts';

let root: string;
let store: Store;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-folder-'));
  store = Store.init(root);
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  fs.rmSync(root, { recursive: true, force: true });
});

const folder = (id: string, order: string): Folder => ({ id, name: id, color: 'sky', order, createdAt: '' });
const card = (id: string, order: string, f: string | null = null, column: Task['column'] = 'implement') =>
  ({ id, order, number: 1, folder: f, column, title: id }) as Task;

describe('lane order', () => {
  it('puts unfiled cards first, then each folder in folder order', () => {
    const folders = [folder('b', 'm'), folder('a', 'c')];
    const tasks = [card('x', 'a', 'b'), card('y', 'z'), card('z', 'b', 'a'), card('w', 'c', 'gone')];
    expect(laneOrder(tasks, normalizeFolders(folders)).map((t) => t.id)).toEqual(['w', 'y', 'z', 'x']);
  });

  it('reads folders.json tolerantly', () => {
    expect(normalizeFolders(null)).toEqual([]);
    const read = normalizeFolders({ folders: [{ id: 'd1', name: '  UI   polish ', color: 'nope' }, { name: 'no id' }] });
    expect(read).toHaveLength(1);
    expect(read[0]).toMatchObject({ id: 'd1', name: 'UI polish', color: 'slate' });
  });
});

describe('folders in the store', () => {
  it('works without any folders at all', () => {
    expect(store.folders()).toEqual([]);
    expect(store.create({ title: 'plain' }).folder).toBeNull();
  });

  it('creates, renames, recolours and reorders folders', () => {
    const a = store.createFolder({ name: 'Auth' });
    const b = store.createFolder({ name: 'UI' });
    expect(() => store.createFolder({ name: 'auth' })).toThrow(/already a folder/);
    expect(() => store.createFolder({ name: '  ' })).toThrow(/needs a name/);

    store.updateFolder(a.id, { name: 'Auth rework', color: 'rose' });
    store.updateFolder(b.id, { before: null, after: store.folders()[0].order });
    expect(store.folders().map((f) => f.name)).toEqual(['UI', 'Auth rework']);
    expect(store.findFolder('auth REWORK')?.color).toBe('rose');
  });

  it('files a card, refuses an unknown folder, and unfiles on delete', () => {
    const f = store.createFolder({ name: 'Auth' });
    const task = store.create({ title: 'login', folder: f.id });
    expect(task.folder).toBe(f.id);
    expect(() => store.patch(task.id, { folder: 'd_nope' })).toThrow(/No folder/);

    store.deleteFolder(f.id);
    expect(store.folders()).toEqual([]);
    const after = store.get(task.id)!;
    expect(after.folder).toBeNull();
    expect(after.activity.at(-1)?.text).toMatch(/was deleted/);
  });

  it('claims the top card as the lane shows it, not the lowest key', () => {
    const f = store.createFolder({ name: 'Later' });
    const filed = store.create({ title: 'filed', folder: f.id });
    store.move(filed.id, 'implement');
    const plain = store.create({ title: 'plain' });
    store.move(plain.id, 'implement', filed.order, null); // key below the filed card
    expect(store.get(plain.id)!.order > store.get(filed.id)!.order).toBe(true);
    expect(store.claimNext()?.id).toBe(plain.id);
  });
});

describe('folder live updates', () => {
  // .ticketrail is a dot-directory; a too-eager ignore rule once silenced this
  it('broadcasts the new list when folders.json changes', async () => {
    const watcher = new BoardWatcher(store).start();
    try {
      const event = new Promise<any>((resolve) => watcher.on('board', (e) => e.type === 'folders' && resolve(e)));
      await new Promise((r) => setTimeout(r, 300));
      store.createFolder({ name: 'Live' });
      const received = await Promise.race([event, new Promise((r) => setTimeout(() => r(null), 3000))]);
      expect(received?.folders.map((f: Folder) => f.name)).toEqual(['Live']);
    } finally {
      await watcher.stop();
    }
  });
});

describe('dropping with folders', () => {
  const folders = [folder('f1', 'g'), folder('f2', 'n')];
  const board = [card('a', 'g'), card('b', 'g', 'f1'), card('c', 'n', 'f1'), card('d', 'g', 'f2'), card('x', 'n', null, 'backlog')];

  it('files a card dropped on a folder header at the bottom of that group', () => {
    expect(resolveDrop(board, 'x', folderDropId('implement', 'f1'), folders)).toEqual({
      column: 'implement',
      before: 'n',
      after: null,
      folder: 'f1',
    });
  });

  it('takes the folder of the card it is dropped above', () => {
    expect(resolveDrop(board, 'a', 'card:d', folders)).toEqual({ column: 'implement', before: null, after: 'g', folder: 'f2' });
    expect(resolveDrop(board, 'b', 'card:a', folders)?.folder).toBeNull();
  });

  it('keeps its folder when dropped on a lane body', () => {
    expect(resolveDrop(board, 'c', 'col:done', folders)).toEqual({ column: 'done', before: null, after: null, folder: 'f1' });
  });
});

function Lane({ tasks, folders }: { tasks: Task[]; folders: Folder[] }) {
  const collapsed = useCollapsed('p1');
  return (
    <DndContext>
      <ColumnView
        meta={{ id: 'implement', label: COLUMN_LABELS.implement, hint: COLUMN_HINTS.implement }}
        tasks={laneOrder(tasks, folders)}
        overCardId={null}
        folders={folders}
        collapsed={collapsed}
        onOpen={() => {}}
      />
    </DndContext>
  );
}

describe('folder groups in a lane', () => {
  const make = () => {
    const f = store.createFolder({ name: 'Auth rework' });
    store.create({ title: 'Loose card', column: 'implement' });
    const inside = store.create({ title: 'Rotate tokens', column: 'implement', folder: f.id });
    store.ask(inside.id, 'Which key store?');
    // ask() parks it on User Input; put it back in the lane under test
    store.patch(inside.id, { column: 'implement' });
    return { tasks: store.list(), folders: store.folders() };
  };

  it('collapses a group but still says a card inside is waiting, and remembers it', () => {
    const { tasks, folders } = make();
    const { unmount } = render(<Lane tasks={tasks} folders={folders} />);
    expect(screen.getByText('Loose card')).toBeTruthy();
    expect(screen.getByText('Rotate tokens')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Collapse folder Auth rework'));
    expect(screen.queryByText('Rotate tokens')).toBeNull();
    expect(screen.getByText('1 waiting')).toBeTruthy();

    unmount();
    render(<Lane tasks={tasks} folders={folders} />);
    expect(screen.queryByText('Rotate tokens')).toBeNull();
    fireEvent.click(screen.getByText('Expand all'));
    expect(screen.getByText('Rotate tokens')).toBeTruthy();
  });

  it('draws no folder chrome on a board without folders', () => {
    store.create({ title: 'Just a card', column: 'implement' });
    render(<Lane tasks={store.list()} folders={[]} />);
    expect(screen.getByText('Just a card')).toBeTruthy();
    expect(screen.queryByText('Collapse all')).toBeNull();
  });
});
