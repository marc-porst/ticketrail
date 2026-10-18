import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/core/store.ts';
import { normalizeLabels, normalizeTask } from '../src/core/task.ts';

let root: string;
let store: Store;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-types-'));
  store = Store.init(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('card types', () => {
  it('reads a card written before types existed as untyped', () => {
    const task = normalizeTask({ id: 't_old', title: 'ancient', column: 'backlog' }, 't_old');
    expect(task.type).toBeNull();
    expect(task.derivedFrom).toBeNull();
    expect(task.labels).toEqual([]);
  });

  it('stores a type on create and changes it on patch', () => {
    const task = store.create({ title: 'crash on save', type: 'bug' });
    expect(task.type).toBe('bug');
    expect(store.patch(task.id, { type: 'feature' }).type).toBe('feature');
    expect(store.patch(task.id, { type: null }).type).toBeNull();
  });

  it('keeps investigations and questions out of Implement', () => {
    for (const type of ['investigation', 'question'] as const) {
      const task = store.create({ title: type, type });
      expect(() => store.move(task.id, 'implement')).toThrow(/never writes code/);
      expect(store.get(task.id)!.column).toBe('backlog');
      // Plan is still open to them: that is where both get worked.
      expect(store.move(task.id, 'plan').column).toBe('plan');
    }
  });

  it('lets feature and bug cards reach Implement', () => {
    for (const type of ['feature', 'bug'] as const) {
      const task = store.create({ title: type, type });
      expect(store.move(task.id, 'implement').column).toBe('implement');
    }
  });
});

describe('deriveImplementation', () => {
  const planned = (plan = '# Findings\n\nUse a queue.') => {
    const task = store.create({ title: 'how should uploads work?', type: 'investigation', labels: ['backend'] });
    store.move(task.id, 'plan');
    store.claimNext();
    return store.savePlan(task.id, plan);
  };

  it('spawns a Feature card that carries the plan into Implement', () => {
    const source = planned();
    const derived = store.deriveImplementation(source.id);

    expect(derived.type).toBe('feature');
    expect(derived.column).toBe('implement');
    expect(derived.plan).toBe(source.plan);
    expect(derived.labels).toEqual(['backend']);
    expect(derived.derivedFrom).toBe(source.id);
    expect(derived.description).toContain(`#${source.number}`);
    // it lands on top, which is where the next worker looks
    expect(store.claimNext()!.id).toBe(derived.id);
  });

  it('leaves the investigation in Planned and notes the spawn on both cards', () => {
    const source = planned();
    const derived = store.deriveImplementation(source.id);

    const after = store.get(source.id)!;
    expect(after.column).toBe('planned');
    expect(after.activity.some((a) => a.text.includes(`#${derived.number}`))).toBe(true);
    expect(store.get(derived.id)!.activity.some((a) => a.text.includes(`#${source.number}`))).toBe(true);
  });

  it('refuses a card that is not an investigation, or one with no plan', () => {
    const feature = store.create({ title: 'plain', type: 'feature' });
    expect(() => store.deriveImplementation(feature.id)).toThrow(/Only an Investigation/);

    const unplanned = store.create({ title: 'no plan yet', type: 'investigation' });
    expect(() => store.deriveImplementation(unplanned.id)).toThrow(/no plan yet/);
  });
});

describe('labels', () => {
  it('trims, collapses whitespace and drops empties', () => {
    expect(normalizeLabels(['  api  ', 'two   words', '', '   '])).toEqual(['api', 'two words']);
  });

  it('de-duplicates case-insensitively but keeps the case that was typed', () => {
    expect(normalizeLabels(['API', 'api', 'Api'])).toEqual(['API']);
  });

  it('caps the count and the length of each one', () => {
    expect(normalizeLabels(Array.from({ length: 20 }, (_, i) => `l${i}`))).toHaveLength(8);
    expect(normalizeLabels(['x'.repeat(80)])[0]).toHaveLength(32);
  });

  it('ignores anything that is not an array of strings', () => {
    expect(normalizeLabels(undefined)).toEqual([]);
    expect(normalizeLabels(['ok', 3, null])).toEqual(['ok']);
  });

  it('normalises through create and patch', () => {
    const task = store.create({ title: 'labelled', labels: ['  Backend ', 'backend', 'ui'] });
    expect(task.labels).toEqual(['Backend', 'ui']);
    expect(store.patch(task.id, { labels: ['  one  ', 'one'] }).labels).toEqual(['one']);
  });
});
