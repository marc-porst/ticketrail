import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/core/store.ts';
import { checkCommand, doneCommand, logCommand, planCommand } from '../src/cli/commands/work.ts';
import { parseArgs } from '../src/cli/args.ts';

let root: string;
let store: Store;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-news-'));
  store = Store.init(root);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Everything a command writes, stdout and console.log alike. */
function capture(fn: () => void): string {
  let out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => ((out += String(chunk)), true));
  vi.spyOn(console, 'log').mockImplementation((...args) => void (out += args.join(' ') + '\n'));
  try {
    fn();
  } finally {
    vi.restoreAllMocks();
  }
  return out;
}

function running(title = 'work') {
  const task = store.create({ title });
  store.move(task.id, 'implement');
  return store.claimNext()!;
}

/** Make sure "after the claim" is later than the claim, even on a fast machine. */
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('changes while a card is in progress', () => {
  it('locks type, agent and worker, but not the rest', () => {
    const task = running();
    expect(() => store.patch(task.id, { type: 'bug' })).toThrow(/its type cannot change now/);
    expect(() => store.patch(task.id, { agent: 'reviewer' })).toThrow(/its agent cannot change now/);
    expect(() => store.patch(task.id, { worker: 'fe' })).toThrow(/its worker cannot change now/);
    // sending the value it already has is not a change
    expect(store.patch(task.id, { type: null }).type).toBeNull();
    expect(store.patch(task.id, { title: 'renamed', labels: ['x'] }).title).toBe('renamed');

    store.finish(task.id, 'ok');
    expect(store.patch(task.id, { type: 'bug' }).type).toBe('bug');
  });

  it('hands notes and files the user added mid-run to check, once', async () => {
    const queued = store.create({ title: 'work' });
    store.message(queued.id, 'a note left before the run is part of the brief, not news', 'user');
    await tick();
    store.move(queued.id, 'implement');
    const task = store.claimNext()!;
    expect(JSON.parse(capture(() => checkCommand(store, [task.id]))).news).toBeUndefined();

    await tick();
    store.message(task.id, 'Use the blue colour', 'user');
    store.attach(task.id, { name: 'mock.png', mime: 'image/png', data: Buffer.from('x'), addedBy: 'user' });
    const checked = JSON.parse(capture(() => checkCommand(store, [task.id])));
    expect(checked.status).toBe('ok');
    expect(checked.news.messages.map((m: any) => m.text)).toEqual(['Use the blue colour']);
    expect(checked.news.files[0]).toMatchObject({ name: 'mock.png', mime: 'image/png' });
    expect(fs.existsSync(checked.news.files[0].path)).toBe(true);

    // told once
    expect(JSON.parse(capture(() => checkCommand(store, [task.id]))).news).toBeUndefined();
  });

  it('tells the worker at its next log', async () => {
    const task = running();
    await tick();
    store.message(task.id, 'Also handle the empty state', 'user');
    const out = capture(() => logCommand(store, parseArgs([]), [task.id, 'built the list']));
    expect(out).toMatch(/logged to #1/);
    expect(out).toMatch(/NEW FROM THE USER[\s\S]*Also handle the empty state/);
    expect(capture(() => logCommand(store, parseArgs([]), [task.id, 'next step']))).not.toMatch(/NEW FROM THE USER/);
  });

  it('does not count an answer to Claude\'s own question as news', async () => {
    const task = running();
    await tick();
    store.ask(task.id, 'Blue or red?');
    store.message(task.id, 'Blue', 'user');
    expect(JSON.parse(capture(() => checkCommand(store, [task.id]))).news).toBeUndefined();
  });

  it('stops done and plan once when there is unread news, then lets them through', async () => {
    const task = running();
    await tick();
    store.message(task.id, 'Wait, rename the button too', 'user');
    expect(() => capture(() => doneCommand(store, parseArgs(['--text', 'shipped']), [task.id]))).toThrow(
      /rename the button too[\s\S]*Not finished yet/,
    );
    expect(store.get(task.id)!.column).toBe('in-progress');
    capture(() => doneCommand(store, parseArgs(['--text', 'shipped, button renamed']), [task.id]));
    expect(store.get(task.id)!.column).toBe('done');

    const planning = store.create({ title: 'plan it' });
    store.move(planning.id, 'plan');
    store.claimNext();
    await tick();
    store.attach(planning.id, { name: 'notes.txt', mime: 'text/plain', data: Buffer.from('x'), addedBy: 'user' });
    expect(() => capture(() => planCommand(store, parseArgs(['--text', '# Plan']), [planning.id]))).toThrow(/notes\.txt/);
    capture(() => planCommand(store, parseArgs(['--text', '# Plan']), [planning.id]));
    expect(store.get(planning.id)!.column).toBe('planned');
  });
});
