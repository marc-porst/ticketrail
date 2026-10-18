import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { envVar, findRoot, pathsFor } from '../src/core/paths.ts';
import { Store } from '../src/core/store.ts';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-paths-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.TICKETRAIL_MODEL;
  delete process.env.PROMPTKANBAN_MODEL;
});

describe('data directory', () => {
  it('creates new boards in .ticketrail', () => {
    Store.init(root);
    expect(fs.existsSync(path.join(root, '.ticketrail', 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.promptkanban'))).toBe(false);
  });

  it('keeps reading a board made before the rename in place', () => {
    const legacy = path.join(root, '.promptkanban');
    fs.mkdirSync(path.join(legacy, 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'config.json'), JSON.stringify({ version: 1, port: 4321, title: 'Old' }));

    expect(findRoot(root)).not.toBeNull();
    expect(pathsFor(root).data).toBe(legacy);

    const task = Store.init(root).create({ title: 'still works' });
    expect(fs.existsSync(path.join(legacy, 'tasks', `${task.id}.json`))).toBe(true);
    expect(fs.existsSync(path.join(root, '.ticketrail'))).toBe(false);
  });

  it('prefers .ticketrail once it exists', () => {
    fs.mkdirSync(path.join(root, '.promptkanban'));
    fs.mkdirSync(path.join(root, '.ticketrail'));
    expect(pathsFor(root).data).toBe(path.join(root, '.ticketrail'));
  });
});

describe('environment variables', () => {
  it('falls back to the PROMPTKANBAN_ names', () => {
    process.env.PROMPTKANBAN_MODEL = 'old';
    expect(envVar('MODEL')).toBe('old');
    process.env.TICKETRAIL_MODEL = 'new';
    expect(envVar('MODEL')).toBe('new');
  });
});
