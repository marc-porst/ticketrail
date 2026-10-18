import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/core/store.ts';
import { MAX_RELATED, normalizeTask } from '../src/core/task.ts';
import { nextCommand } from '../src/cli/commands/work.ts';
import { RELATED_FIELD_LIMIT } from '../src/cli/commands/attach.ts';
import { RelatedCards } from '../web/src/components/RelatedCards.tsx';

let root: string;
let store: Store;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-related-'));
  store = Store.init(root);
});

afterEach(() => {
  cleanup();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('related cards: model', () => {
  it('loads older files with no links and cleans what it finds', () => {
    expect(normalizeTask({ id: 't_a' }, 't_a').related).toEqual([]);
    const ids = Array.from({ length: MAX_RELATED + 3 }, (_, i) => `t_${i}`);
    const task = normalizeTask({ id: 't_a', related: ['t_a', 't_b', 't_b', 7, ...ids] }, 't_a');
    expect(task.related[0]).toBe('t_b');
    expect(task.related).not.toContain('t_a');
    expect(task.related).toHaveLength(MAX_RELATED);
  });
});

describe('related cards: store', () => {
  it('links and unlinks, dropping unknown ids and noting each change', () => {
    const a = store.create({ title: 'a' });
    const b = store.create({ title: 'b' });
    const c = store.create({ title: 'c' });

    let updated = store.patch(c.id, { related: [a.id, 't_missing', b.id, c.id] });
    expect(updated.related).toEqual([a.id, b.id]);
    expect(updated.activity.at(-1)?.text).toBe(`Linked #${a.number}, #${b.number}.`);

    updated = store.patch(c.id, { related: [b.id] });
    expect(updated.related).toEqual([b.id]);
    expect(updated.activity.at(-1)?.text).toBe(`Unlinked #${a.number}.`);

    expect(store.referencedBy(b.id).map((t) => t.id)).toEqual([c.id]);
  });

  it('resolves links plus derivedFrom once, skipping deleted cards', () => {
    const spike = store.create({ title: 'spike' });
    const other = store.create({ title: 'other' });
    const gone = store.create({ title: 'gone' });
    const task = store.create({ title: 'work', derivedFrom: spike.id, related: [spike.id, other.id, gone.id] });
    fs.rmSync(store.taskFile(gone.id));
    expect(store.relatedOf(store.get(task.id)!).map((t) => t.id)).toEqual([spike.id, other.id]);
  });

  it('finds a card by #number', () => {
    const a = store.create({ title: 'a' });
    expect(store.find(`#${a.number}`)?.id).toBe(a.id);
    expect(store.find(String(a.number))?.id).toBe(a.id);
  });
});

describe('related cards: next', () => {
  it('hands Claude the related cards with plan and result, long fields cut', async () => {
    const context = store.create({ title: 'PDF export', description: 'x'.repeat(RELATED_FIELD_LIMIT + 50) });
    store.patch(context.id, { plan: '## The plan' });
    const work = store.create({ title: 'Fix margins', related: [context.id] });
    store.move(work.id, 'implement');

    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => (out.push(String(chunk)), true));
    try {
      await nextCommand(store, { flags: {}, positional: [] } as any);
    } finally {
      spy.mockRestore();
    }

    const json = JSON.parse(out.join(''));
    expect(json.task.id).toBe(work.id);
    expect(json.relatedNote).toMatch(/1 related card/);
    expect(json.relatedCards).toHaveLength(1);
    expect(json.relatedCards[0]).toMatchObject({ id: context.id, plan: '## The plan', relation: 'related' });
    expect(json.relatedCards[0].description).toMatch(/truncated, run show/);
  });

  it('says nothing about related cards when there are none', async () => {
    const work = store.create({ title: 'alone' });
    store.move(work.id, 'implement');
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => (out.push(String(chunk)), true));
    try {
      await nextCommand(store, { flags: {}, positional: [] } as any);
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(out.join(''))).not.toHaveProperty('relatedCards');
  });
});

describe('related cards: tab', () => {
  it('lists links and backlinks, adds through the picker and removes with ×', () => {
    const a = store.create({ title: 'Design the schema' });
    const b = store.create({ title: 'Write the migration' });
    const c = store.create({ title: 'Seed the data', related: [a.id] });
    const d = store.create({ title: 'Load test', related: [c.id] });
    const all = store.list();
    const task = all.find((t) => t.id === c.id)!;

    const onChange = vi.fn();
    const onOpenCard = vi.fn();
    render(<RelatedCards task={task} allTasks={all} onChange={onChange} onOpenCard={onOpenCard} />);

    expect(screen.getByText('Design the schema')).toBeTruthy();
    expect(screen.getByText('Referenced by')).toBeTruthy();
    expect(screen.getByText('Load test')).toBeTruthy();

    fireEvent.click(screen.getByText('Load test'));
    expect(onOpenCard).toHaveBeenCalledWith(d.id);

    const input = screen.getByLabelText('Add related card');
    fireEvent.change(input, { target: { value: 'migration' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith([a.id, b.id]);

    fireEvent.click(screen.getByLabelText(`Unlink #${a.number}`));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});
