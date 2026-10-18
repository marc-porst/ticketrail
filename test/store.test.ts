import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/core/store.ts';
import { pendingQuestion } from '../src/core/task.ts';

let root: string;
let store: Store;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-test-'));
  store = Store.init(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('store', () => {
  it('numbers cards and keeps them in the backlog', () => {
    const a = store.create({ title: 'first' });
    const b = store.create({ title: 'second' });
    expect([a.number, b.number]).toEqual([1, 2]);
    expect(a.column).toBe('backlog');
  });

  it('writes one file per task and reads it back', () => {
    const task = store.create({ title: 'persisted', description: 'body' });
    expect(fs.existsSync(path.join(root, '.ticketrail', 'tasks', `${task.id}.json`))).toBe(true);
    expect(new Store(root).get(task.id)?.description).toBe('body');
  });

  it('orders a column by the fractional key', () => {
    const a = store.create({ title: 'a', position: 'bottom' });
    const b = store.create({ title: 'b', position: 'bottom' });
    expect(store.column('backlog').map((t) => t.id)).toEqual([a.id, b.id]);
    store.patch(b.id, { column: 'backlog', before: null, after: a.order });
    expect(store.column('backlog').map((t) => t.id)).toEqual([b.id, a.id]);
  });

  it('claims Implement before Plan, top card first', () => {
    const planned = store.create({ title: 'to plan' });
    const build = store.create({ title: 'to build' });
    store.move(planned.id, 'plan');
    store.move(build.id, 'implement');

    const first = store.claimNext();
    expect(first?.id).toBe(build.id);
    expect(first?.mode).toBe('implement');
    expect(first?.column).toBe('in-progress');

    const second = store.claimNext();
    expect(second?.id).toBe(planned.id);
    expect(second?.mode).toBe('plan');

    expect(store.claimNext()).toBeNull();
  });

  it('never hands the same card to two workers', () => {
    const ids = ['one', 'two', 'three'].map((title) => store.create({ title }).id);
    for (const id of ids) store.move(id, 'implement');

    const claimed = [store.claimNext(), store.claimNext(), store.claimNext(), store.claimNext()];
    const seen = claimed.filter(Boolean).map((t) => t!.id);
    expect(new Set(seen).size).toBe(3);
    expect(claimed[3]).toBeNull();
  });

  it('parks a question on User Input and releases it on the answer', () => {
    const task = store.claimAndAsk();
    expect(task.column).toBe('user-input');
    expect(pendingQuestion(task)).not.toBeNull();

    const { task: answered } = store.message(task.id, 'SQLite please', 'user');
    expect(answered.column).toBe('in-progress');
    expect(pendingQuestion(answered)).toBeNull();
  });

  it('flags a cancellation when the user drags a card out of In Progress', () => {
    const task = store.create({ title: 'busy' });
    store.move(task.id, 'implement');
    const claimed = store.claimNext()!;
    const pulled = store.move(claimed.id, 'backlog');
    expect(pulled.cancelRequested).toBe(true);
  });

  it('moves a finished plan to Planned and a finished build to Done', () => {
    const task = store.create({ title: 'work' });
    store.move(task.id, 'plan');
    const claimed = store.claimNext()!;
    expect(store.savePlan(claimed.id, '# Plan\n1. do it').column).toBe('planned');
    store.move(claimed.id, 'implement');
    store.claimNext();
    expect(store.finish(claimed.id, 'shipped').column).toBe('done');
  });

  it('keeps the earlier result when a card is finished again', () => {
    const task = store.create({ title: 'work' });
    store.move(task.id, 'implement');
    store.claimNext();
    const first = store.finish(task.id, 'first run');
    expect(first.resultHistory).toEqual([]);

    store.move(task.id, 'implement');
    store.claimNext();
    const second = store.finish(task.id, 'second run');
    expect(second.result).toBe('second run');
    const firstDone = first.activity.findLast((a) => a.text === 'Done.')!;
    expect(second.resultHistory).toEqual([{ at: firstDone.at, text: 'first run' }]);
    expect(store.get(task.id)!.resultHistory).toHaveLength(1);
  });
});

declare module '../src/core/store.ts' {
  interface Store {
    claimAndAsk(): import('../src/core/task.ts').Task;
  }
}

Store.prototype.claimAndAsk = function claimAndAsk() {
  const task = this.create({ title: 'needs input' });
  this.move(task.id, 'implement');
  const claimed = this.claimNext()!;
  return this.ask(claimed.id, 'Postgres or SQLite?').task;
};
