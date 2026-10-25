import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/core/store.ts';
import { addProject, projectId } from '../src/core/registry.ts';
import { startServer, type ServerHandle } from '../src/server/server.ts';

let root: string;
let store: Store;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-delete-'));
  store = Store.init(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('deleting a card', () => {
  it('removes its file, its attachments and its saved sessions', () => {
    const card = store.create({ title: 'doomed' });
    const { attachment } = store.attach(card.id, { name: 'shot.png', mime: 'image/png', data: Buffer.from('png'), addedBy: 'user' });
    const sessions = path.join(store.paths.sessions, card.id);
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, 'r1.json'), '{}');

    const result = store.deleteTask(card.id);
    expect(result.deleted).toEqual({ id: card.id, number: card.number, title: 'doomed' });
    expect(fs.existsSync(store.taskFile(card.id))).toBe(false);
    expect(fs.existsSync(store.filePath(attachment))).toBe(false);
    expect(fs.existsSync(sessions)).toBe(false);
    expect(store.get(card.id)).toBeNull();
  });

  it('removes every link to it, and notes that on the cards that had one', () => {
    const doomed = store.create({ title: 'investigation', type: 'investigation', plan: 'p', column: 'planned' });
    const reader = store.create({ title: 'reader', related: [doomed.id] });
    const other = store.create({ title: 'other' });
    const both = store.create({ title: 'both', related: [doomed.id, other.id] });
    const derived = store.deriveImplementation(doomed.id);

    const { unlinked } = store.deleteTask(doomed.id);
    expect(unlinked.sort()).toEqual([reader.number, both.number, derived.number].sort());
    expect(store.get(reader.id)!.related).toEqual([]);
    expect(store.get(both.id)!.related).toEqual([other.id]);
    expect(store.get(derived.id)!.derivedFrom).toBeNull();
    expect(store.get(reader.id)!.activity.at(-1)!.text).toBe(`Unlinked #${doomed.number} (the card was deleted).`);
    // cards that never linked it are left alone
    expect(store.get(other.id)!.activity).toEqual([]);
  });

  it('refuses a card Claude is working on, and an unknown one', () => {
    const card = store.create({ title: 'busy', column: 'implement' });
    store.claimNext();
    expect(() => store.deleteTask(card.id)).toThrow(/working on/);
    expect(fs.existsSync(store.taskFile(card.id))).toBe(true);
    expect(() => store.deleteTask('t_nope')).toThrow(/No task/);
  });

  it('can delete a card that was archived before deleting existed', () => {
    const card = store.create({ title: 'old' });
    const file = store.taskFile(card.id);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), archived: true }));
    store.deleteTask(card.id);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('deleting over HTTP', () => {
  let home: string;
  let server: ServerHandle;

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-home-'));
    process.env.TICKETRAIL_HOME = home;
    addProject(root);
    server = await startServer(store, { port: 0 });
  });

  afterEach(async () => {
    await server.close();
    delete process.env.TICKETRAIL_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('DELETE removes the card instead of archiving it', async () => {
    const card = store.create({ title: 'gone' });
    const reader = store.create({ title: 'reader', related: [card.id] });
    const base = `http://localhost:${server.port}/api/projects/${projectId(root)}`;
    const res = await fetch(`${base}/tasks/${card.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await res.json()).unlinked).toEqual([reader.number]);
    expect(fs.existsSync(store.taskFile(card.id))).toBe(false);
    const board = await (await fetch(`${base}/board`)).json();
    expect(board.tasks.map((t: any) => t.id)).not.toContain(card.id);
    expect((await fetch(`${base}/tasks/${card.id}`, { method: 'DELETE' })).status).toBe(404);
  });
});
