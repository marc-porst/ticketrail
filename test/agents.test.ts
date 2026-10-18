import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentsDir,
  createAgent,
  deleteAgent,
  listAgents,
  readAgent,
  writeAgent,
} from '../src/core/agents.ts';
import { Store } from '../src/core/store.ts';
import { normalizeTask } from '../src/core/task.ts';
import { nextCommand } from '../src/cli/commands/work.ts';
import { assignCommand } from '../src/cli/commands/board.ts';
import { parseArgs } from '../src/cli/args.ts';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-agents-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('agent files', () => {
  it('creates an agent from a starter and lists it', () => {
    const made = createAgent(root, { name: 'reviewer', template: 'reviewer' });
    expect(made.path).toBe(path.join(agentsDir(root), 'reviewer.md'));
    expect(made.frontmatter.name).toBe('reviewer');
    expect(made.description).toMatch(/Reviews code changes/);
    expect(made.body).toMatch(/careful code reviewer/);
    expect(listAgents(root).map((a) => a.name)).toEqual(['reviewer']);
  });

  it('reads the pinned model from the frontmatter', () => {
    fs.mkdirSync(agentsDir(root), { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir(root), 'tester.md'),
      '---\nname: tester\ndescription: Runs tests\nmodel: haiku\n---\nTest it.\n',
    );
    expect(listAgents(root)).toEqual([expect.objectContaining({ name: 'tester', description: 'Runs tests', model: 'haiku' })]);
  });

  it('refuses bad names, duplicates and a missing description', () => {
    expect(() => createAgent(root, { name: '../evil', description: 'x' })).toThrow(/not a valid agent name/);
    expect(() => createAgent(root, { name: 'empty', description: '' })).toThrow(/needs a description/);
    createAgent(root, { name: 'docs', description: 'Writes docs' });
    expect(() => createAgent(root, { name: 'docs', description: 'again' })).toThrow(/already exists/);
  });

  it('saves with a version check and deletes', () => {
    const made = createAgent(root, { name: 'docs', description: 'Writes docs' });
    const saved = writeAgent(root, 'docs', made.raw + 'More.\n', made.version);
    expect(saved.raw).toMatch(/More\.\n$/);
    expect(() => writeAgent(root, 'docs', 'stale', made.version)).toThrow(/changed on disk/);
    expect(deleteAgent(root, 'docs')).toEqual({ removed: 'docs' });
    expect(listAgents(root)).toEqual([]);
    expect(() => readAgent(root, 'docs')).toThrow(/No agent/);
  });

  it('shows a symlinked agent but never writes or deletes it', () => {
    const elsewhere = path.join(root, 'shared.md');
    fs.writeFileSync(elsewhere, '---\nname: shared\ndescription: Shared\n---\nHi\n');
    fs.mkdirSync(agentsDir(root), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(agentsDir(root), 'shared.md'));
    expect(readAgent(root, 'shared').readonly).toBe(true);
    expect(() => writeAgent(root, 'shared', 'x')).toThrow(/symlink/);
    expect(() => deleteAgent(root, 'shared')).toThrow(/symlink/);
  });
});

describe('cards with an agent', () => {
  let store: Store;
  beforeEach(() => {
    store = Store.init(root);
  });

  const captureNext = async () => {
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    await nextCommand(store, parseArgs([]));
    vi.restoreAllMocks();
    return JSON.parse(out);
  };

  it('stores, notes and clears the agent', () => {
    const task = store.create({ title: 'review it', agent: 'reviewer' });
    expect(task.agent).toBe('reviewer');
    const cleared = store.patch(task.id, { agent: null });
    expect(cleared.agent).toBeNull();
    expect(cleared.activity.at(-1)?.text).toBe('No longer assigned to an agent.');
    expect(() => store.patch(task.id, { agent: 'Not Valid' })).toThrow(/not a valid agent name/);
    expect(normalizeTask({ title: 'old card' }, 't_x').agent).toBeNull();
  });

  it('assign only accepts agents the project has', () => {
    const task = store.create({ title: 'x' });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(() => assignCommand(store, [task.id, 'reviewer'])).toThrow(/No agent "reviewer"/);
    createAgent(root, { name: 'reviewer', template: 'reviewer' });
    assignCommand(store, [task.id, 'reviewer']);
    expect(store.get(task.id)!.agent).toBe('reviewer');
  });

  it('tells the worker to delegate a card with an agent', async () => {
    createAgent(root, { name: 'reviewer', template: 'reviewer' });
    const task = store.create({ title: 'review it', agent: 'reviewer' });
    store.move(task.id, 'implement');

    const claimed = await captureNext();
    expect(claimed.status).toBe('claimed');
    expect(claimed.agent).toEqual(expect.objectContaining({ name: 'reviewer' }));
    expect(claimed.guidance).toMatch(/subagent_type "reviewer"/);
    expect(claimed.guidance).toMatch(/ticketrail done <id>/);
  });

  it('hands a card back when its agent is gone, and claims the next one', async () => {
    const orphan = store.create({ title: 'orphan', agent: 'ghost' });
    const plain = store.create({ title: 'plain', position: 'bottom' });
    store.move(plain.id, 'implement');
    store.move(orphan.id, 'implement');

    const claimed = await captureNext();
    expect(claimed.task.id).toBe(plain.id);
    expect(claimed.agent).toBeUndefined();
    const back = store.get(orphan.id)!;
    expect(back.column).toBe('user-input');
    expect(back.messages.at(-1)?.text).toMatch(/ghost\.md does not exist/);
  });
});
