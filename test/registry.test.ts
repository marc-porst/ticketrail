import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/core/store.ts';
import { initBoard } from '../src/core/board-init.ts';
import {
  addProject,
  describeProjects,
  findProject,
  listProjects,
  projectId,
  removeProject,
} from '../src/core/registry.ts';

let home: string;
let alpha: string;
let beta: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-home-'));
  process.env.TICKETRAIL_HOME = home;
  alpha = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-alpha-'));
  beta = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-beta-'));
  Store.init(alpha);
  Store.init(beta);
});

afterEach(() => {
  delete process.env.TICKETRAIL_HOME;
  for (const dir of [home, alpha, beta]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('project registry', () => {
  it('starts empty and records what is added', () => {
    expect(listProjects()).toEqual([]);
    addProject(alpha);
    expect(listProjects().map((p) => p.path)).toEqual([path.resolve(alpha)]);
  });

  it('is idempotent, however the path is spelled', () => {
    const first = addProject(alpha);
    const again = addProject(alpha + path.sep);
    const nested = addProject(path.join(alpha, '.', ''));
    expect(again.id).toBe(first.id);
    expect(nested.id).toBe(first.id);
    expect(listProjects()).toHaveLength(1);
  });

  it('gives the same id through a symlink', () => {
    const link = path.join(os.tmpdir(), `pk-link-${Date.now()}`);
    fs.symlinkSync(alpha, link);
    try {
      expect(projectId(link)).toBe(projectId(alpha));
    } finally {
      fs.unlinkSync(link); // rmSync refuses a symlink pointing at a directory
    }
  });

  it('finds a project by id or by path, and removes it', () => {
    const record = addProject(alpha);
    expect(findProject(record.id)?.path).toBe(record.path);
    expect(findProject(alpha)?.id).toBe(record.id);
    expect(removeProject(record.id)?.id).toBe(record.id);
    expect(findProject(record.id)).toBeNull();
    expect(removeProject('nope')).toBeNull();
  });

  it('summarises each board without mixing them up', () => {
    const a = new Store(alpha);
    const queued = a.create({ title: 'queued' });
    a.move(queued.id, 'implement');
    const asking = a.create({ title: 'asking' });
    a.move(asking.id, 'implement');
    a.claimNext();
    a.claimNext();
    a.ask(asking.id, 'which one?');

    new Store(beta).create({ title: 'just a draft' });

    addProject(alpha);
    addProject(beta);
    const views = describeProjects();
    const viewA = views.find((v) => v.path === path.resolve(alpha))!;
    const viewB = views.find((v) => v.path === path.resolve(beta))!;

    expect(viewA.summary.blocked).toBe(1);
    // the one that asked left In Progress for User Input
    expect(viewA.summary.inProgress).toBe(1);
    expect(viewA.summary.total).toBe(2);
    expect(viewB.summary.blocked).toBe(0);
    expect(viewB.summary.total).toBe(1);
    expect(viewA.workers).toEqual({ waiting: 0, lastSeen: null, workers: [] });
  });

  it('reports a vanished project as missing instead of dropping it', () => {
    addProject(alpha);
    fs.rmSync(path.join(alpha, '.ticketrail'), { recursive: true, force: true });

    const [view] = describeProjects();
    expect(view.missing).toBe(true);
    expect(view.name).toBe(path.basename(alpha));
    // still listed, so it can be removed deliberately
    expect(listProjects()).toHaveLength(1);
  });

  it('survives a corrupt registry file', () => {
    fs.writeFileSync(path.join(home, 'projects.json'), '{ not json');
    expect(listProjects()).toEqual([]);
    expect(addProject(alpha).path).toBe(path.resolve(alpha));
  });

  it('initBoard creates a board, registers it, and leaves an existing one alone', () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-init-'));
    try {
      const first = initBoard(fresh);
      expect(first.fresh).toBe(true);
      expect(fs.existsSync(path.join(fresh, '.ticketrail', 'config.json'))).toBe(true);
      expect(listProjects().map((p) => p.path)).toContain(path.resolve(fresh));

      const seeded = new Store(fresh).list();
      expect(seeded).toHaveLength(1);

      // running it again must not re-seed the welcome card or reset the title
      new Store(fresh).saveConfig({ ...new Store(fresh).config(), title: 'Chosen Name' });
      const again = initBoard(fresh);
      expect(again.fresh).toBe(false);
      expect(again.name).toBe('Chosen Name');
      expect(new Store(fresh).list()).toHaveLength(1);
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });
});
