import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/core/store.ts';
import { describeFilter, matchesFilter, parseFilter } from '../src/core/filter.ts';
import { findRoot, findWorktree } from '../src/core/paths.ts';
import { workerPresence } from '../src/core/presence.ts';
import { codeChanged, nextCommand, waitCommand } from '../src/cli/commands/work.ts';
import { parseArgs } from '../src/cli/args.ts';

let root: string;
let store: Store;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pk-workers-')));
  store = Store.init(root);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TICKETRAIL_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

async function run(command: typeof nextCommand, argv: string[]) {
  let out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  try {
    await command(store, parseArgs(argv));
  } finally {
    vi.restoreAllMocks();
  }
  return JSON.parse(out);
}

describe('work filters', () => {
  it('ORs values of one kind and ANDs different kinds', () => {
    const ui = store.createFolder({ name: 'UI' });
    const filter = parseFilter(['label:frontend,label:css', 'type:bug'], store.folders());
    const card = (labels: string[], type: any) => ({ ...store.create({ title: 'x', labels }), type });
    expect(matchesFilter(card(['CSS'], 'bug'), filter)).toBe(true);
    expect(matchesFilter(card(['frontend'], 'feature'), filter)).toBe(false);
    expect(matchesFilter(card(['backend'], 'bug'), filter)).toBe(false);

    const byFolder = parseFilter(['folder:ui', 'agent:none'], store.folders());
    expect(byFolder.folders).toEqual([ui.id]);
    expect(describeFilter(byFolder, store.folders())).toBe('agent:none,folder:UI');
  });

  it('refuses a filter it cannot read', () => {
    expect(() => parseFilter(['colour:red'], [])).toThrow(/Cannot read the filter/);
    expect(() => parseFilter(['type:epic'], [])).toThrow(/Unknown type/);
    expect(() => parseFilter(['folder:nope'], [])).toThrow(/No folder "nope"/);
  });
});

describe('named workers', () => {
  it('claims only matching cards and records who claimed them', async () => {
    const back = store.create({ title: 'api', labels: ['backend'] });
    const front = store.create({ title: 'button', labels: ['frontend'] });
    store.move(back.id, 'implement');
    store.move(front.id, 'implement');

    const fe = await run(nextCommand, ['--worker', 'fe', '--only', 'label:frontend']);
    expect(fe.task.id).toBe(front.id);
    expect(fe.worker).toBe('fe');
    expect(store.get(front.id)!.claimedBy).toBe('fe');
    expect(store.get(front.id)!.activity.at(-1)?.text).toBe('Claude started implementing (worker fe).');

    // nothing else for fe, but the backend card is still there for someone else
    expect((await run(nextCommand, ['--worker', 'fe', '--only', 'label:frontend'])).status).toBe('none');
    const any = await run(nextCommand, []);
    expect(any.task.id).toBe(back.id);
    expect(store.get(back.id)!.claimedBy).toBeNull();
  });

  it('is not woken by cards it would not take', async () => {
    const back = store.create({ title: 'api', labels: ['backend'] });
    store.move(back.id, 'plan');
    expect(await run(waitCommand, ['--only', 'label:frontend', '--timeout', '1'])).toEqual({ status: 'timeout' });
    expect(await run(waitCommand, ['--only', 'label:backend', '--timeout', '1'])).toEqual({ status: 'ready', implement: 0, plan: 1 });
  }, 10_000);

  it('gives a card sent to a worker to that worker only, whatever the filters say', async () => {
    const card = store.create({ title: 'docs', labels: ['backend'], worker: 'fe' });
    store.move(card.id, 'implement');
    expect(store.get(card.id)!.worker).toBe('fe');

    // unnamed, another name, and even a matching filter on another worker: all pass it by
    expect((await run(nextCommand, [])).status).toBe('none');
    expect((await run(nextCommand, ['--worker', 'be', '--only', 'label:backend'])).status).toBe('none');
    expect(await run(waitCommand, ['--worker', 'be', '--only', 'label:backend', '--timeout', '1'])).toEqual({ status: 'timeout' });

    // fe takes it although its own filter would not
    expect(await run(waitCommand, ['--worker', 'fe', '--only', 'label:frontend', '--timeout', '1'])).toMatchObject({ status: 'ready' });
    const fe = await run(nextCommand, ['--worker', 'fe', '--only', 'label:frontend']);
    expect(fe.task.id).toBe(card.id);
    expect(fe.task.claimedBy).toBe('fe');
  }, 10_000);

  it('notes sending and unsending, and refuses a bad name', () => {
    const card = store.create({ title: 'x' });
    expect(store.patch(card.id, { worker: 'fe' }).activity.at(-1)?.text).toBe('Sent to worker fe.');
    expect(store.patch(card.id, { worker: null }).activity.at(-1)?.text).toBe('Any worker may take it.');
    expect(() => store.patch(card.id, { worker: 'a b' })).toThrow(/not a usable worker name/);
  });

  it('rejects an unusable worker name', async () => {
    await expect(run(nextCommand, ['--worker', 'a b/c'])).rejects.toThrow(/not a usable worker name/);
  });

  it('reports no waiting workers by name when nobody waits', () => {
    expect(workerPresence(store).workers).toEqual([]);
  });
});

describe('a rebuilt CLI', () => {
  it('is noticed by a process that started before it', () => {
    const script = path.join(root, 'cli.js');
    fs.writeFileSync(script, '// v1');
    const changed = codeChanged(script);
    expect(changed()).toBe(false);
    fs.utimesSync(script, new Date(), new Date(Date.now() + 5000));
    expect(changed()).toBe(true);
    // no script to watch (or a vanished one) never claims a change
    expect(codeChanged(path.join(root, 'missing.js'))()).toBe(false);
  });
});

describe('git worktrees', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
      cwd,
      stdio: 'ignore',
    });

  it('uses the main checkout board from a linked worktree and reports the branch', () => {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'add', '.ticketrail');
    git(root, 'commit', '-q', '-m', 'board');
    const wt = path.join(root, '..', `${path.basename(root)}-fe`);
    git(root, 'worktree', 'add', '-q', '-b', 'fe-work', wt);
    try {
      // the worktree has its own committed copy of the board, which must not win
      expect(fs.existsSync(path.join(wt, '.ticketrail', 'config.json'))).toBe(true);
      fs.mkdirSync(path.join(wt, 'src'));
      expect(findRoot(path.join(wt, 'src'))).toBe(root);
      expect(findWorktree(path.join(wt, 'src'))).toEqual({ path: fs.realpathSync(wt), branch: 'fe-work', main: root });
      expect(findWorktree(root)).toBeNull();
      expect(findRoot(root)).toBe(root);
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });

  it('lets TICKETRAIL_ROOT point anywhere', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-elsewhere-'));
    process.env.TICKETRAIL_ROOT = root;
    try {
      expect(findRoot(other)).toBe(path.resolve(root));
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
