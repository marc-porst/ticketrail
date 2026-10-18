import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/core/store.ts';
import { waitFor } from '../src/core/watch.ts';
import { waitCommand } from '../src/cli/commands/work.ts';
import { workerPresence } from '../src/core/presence.ts';

let root: string;
let store: Store;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-wait-'));
  store = Store.init(root);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Run `wait` and capture what it prints. */
function runWait(flags: Record<string, string> = {}) {
  const out: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => (out.push(String(chunk)), true));
  const done = waitCommand(store, { flags, positional: [] } as any).then(() => JSON.parse(out.join('')));
  return done;
}

const settled = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

describe('wait', () => {
  it('wakes when a card reaches Plan or Implement, and leaves it there', async () => {
    const result = runWait({ timeout: '10' });
    const card = store.create({ title: 'later', column: 'backlog' });
    expect(await settled(result, 400)).toBe(false); // Backlog does not count

    store.move(card.id, 'plan');
    expect(await result).toEqual({ status: 'ready', implement: 0, plan: 1 });
    expect(store.get(card.id)?.column).toBe('plan'); // not claimed
  });

  it('answers at once when work is already queued', async () => {
    store.create({ title: 'queued', column: 'implement' });
    expect(await runWait()).toEqual({ status: 'ready', implement: 1, plan: 0 });
  });

  it('times out with a positive timeout', async () => {
    expect(await runWait({ timeout: '1' })).toEqual({ status: 'timeout' });
  });

  it('waits without limit for --timeout 0', async () => {
    const result = runWait({ timeout: '0' });
    expect(await settled(result, 400)).toBe(false);
    store.create({ title: 'finally', column: 'implement' });
    expect((await result).status).toBe('ready');
  });

  it('shows up as a waiting worker until it wakes', async () => {
    const result = runWait({ timeout: '0' });
    expect(workerPresence(store).waiting).toBe(1);
    store.create({ title: 'work', column: 'plan' });
    await result;
    expect(workerPresence(store)).toMatchObject({ waiting: 0 });
    expect(workerPresence(store).lastSeen).not.toBeNull();
  });
});

describe('waitFor', () => {
  it('treats Infinity as no limit rather than firing at once', async () => {
    let value: string | null = null;
    const result = waitFor(store, () => value, Infinity);
    expect(await settled(result, 300)).toBe(false);
    value = 'go';
    store.create({ title: 'nudge the watcher' });
    expect(await result).toBe('go');
  });
});
