import { describe, expect, it } from 'vitest';
import { dropZone, linkOnDrop, resolveDrop, resolveFolderDrop } from '../web/src/lib/drop.ts';
import { MAX_RELATED } from '../src/core/task.ts';
import type { Task } from '../src/core/task.ts';

const card = (id: string, column: Task['column'], order: string): Task =>
  ({ id, column, order, number: 1, title: id }) as Task;

// Implement holds a, b, c top to bottom; Backlog holds x.
const board = [
  card('a', 'implement', 'g'),
  card('b', 'implement', 'n'),
  card('c', 'implement', 'u'),
  card('x', 'backlog', 'n'),
];

describe('drop placement', () => {
  it('inserts above the card it was dropped on', () => {
    expect(resolveDrop(board, 'x', 'card:b')).toEqual({ column: 'implement', before: 'g', after: 'n', folder: null });
  });

  it('inserts at the very top when dropped on the first card', () => {
    expect(resolveDrop(board, 'x', 'card:a')).toEqual({ column: 'implement', before: null, after: 'g', folder: null });
  });

  it('appends when dropped on the column body', () => {
    expect(resolveDrop(board, 'x', 'col:implement')).toEqual({ column: 'implement', before: 'u', after: null, folder: null });
  });

  it('ignores the dragged card when computing its own neighbours', () => {
    // moving b up onto a must not treat b as its own upper neighbour
    expect(resolveDrop(board, 'b', 'card:a')).toEqual({ column: 'implement', before: null, after: 'g', folder: null });
    // moving a down onto c: neighbours are b and c, not a and c
    expect(resolveDrop(board, 'a', 'card:c')).toEqual({ column: 'implement', before: 'n', after: 'u', folder: null });
  });

  it('lands in an empty column', () => {
    expect(resolveDrop(board, 'x', 'col:done')).toEqual({ column: 'done', before: null, after: null, folder: null });
  });

  it('does nothing when the card is dropped on itself or on nothing', () => {
    expect(resolveDrop(board, 'x', 'card:x')).toBeNull();
    expect(resolveDrop(board, 'x', 'col:backlog')).toBeNull();
    expect(resolveDrop(board, 'nope', 'col:done')).toBeNull();
  });

  it('produces keys that actually sort into the intended position', async () => {
    const { midString } = await import('../src/core/order.ts');
    const drop = resolveDrop(board, 'x', 'card:b')!;
    const key = midString(drop.before ?? '', drop.after ?? '');
    expect(key > 'g').toBe(true); // below a
    expect(key < 'n').toBe(true); // above b
  });
});

describe('drop on a card: reorder or link', () => {
  const rect = { top: 100, height: 80 };

  it('reorders from the top band and links below it', () => {
    expect(dropZone(100, rect)).toBe('before');
    expect(dropZone(127, rect)).toBe('before');
    expect(dropZone(129, rect)).toBe('link');
    expect(dropZone(179, rect)).toBe('link');
  });

  it('keeps a usable reorder band on a very short card', () => {
    expect(dropZone(111, { top: 100, height: 20 })).toBe('before');
  });

  it('adds the dragged card to the target, never the other way round', () => {
    const target = { ...card('t', 'implement', 'n'), related: ['a'] };
    expect(linkOnDrop(target, 'x')).toEqual(['a', 'x']);
  });

  it('does nothing when already linked, dropped on itself, or full', () => {
    const target = { ...card('t', 'implement', 'n'), related: ['x'] };
    expect(linkOnDrop(target, 'x')).toBeNull();
    expect(linkOnDrop(target, 't')).toBeNull();
    const full = { ...target, related: Array.from({ length: MAX_RELATED }, (_, i) => `r${i}`) };
    expect(linkOnDrop(full, 'x')).toBeNull();
  });
});

describe('sorting folders by dragging', () => {
  const folders = [
    { id: 'a', name: 'a', color: 'sky', order: 'g', createdAt: '' },
    { id: 'b', name: 'b', color: 'sky', order: 'n', createdAt: '' },
    { id: 'c', name: 'c', color: 'sky', order: 'u', createdAt: '' },
  ] as const;

  it('lands above the folder it is dropped on', () => {
    expect(resolveFolderDrop(folders as any, 'c', 'a')).toEqual({ before: null, after: 'g' });
    expect(resolveFolderDrop(folders as any, 'a', 'c')).toEqual({ before: 'n', after: 'u' });
  });

  it('goes last when dropped on the lane body', () => {
    expect(resolveFolderDrop(folders as any, 'a', null)).toEqual({ before: 'u', after: null });
  });

  it('does nothing when it would not move', () => {
    expect(resolveFolderDrop(folders as any, 'b', 'b')).toBeNull();
    expect(resolveFolderDrop(folders as any, 'a', 'b')).toBeNull(); // already right above b
    expect(resolveFolderDrop(folders as any, 'c', null)).toBeNull(); // already last
    expect(resolveFolderDrop(folders as any, 'zz', 'a')).toBeNull();
  });
});
