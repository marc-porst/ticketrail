import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/core/store.ts';
import { displayName, safeExtension } from '../src/core/files.ts';

let root: string;
let store: Store;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-files-'));
  store = Store.init(root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const png = Buffer.from('89504e470d0a1a0a', 'hex');

describe('attachments', () => {
  it('writes the bytes into .ticketrail/files and records the id on the task', () => {
    const task = store.create({ title: 'has a screenshot' });
    const { attachment } = store.attach(task.id, { name: 'bug.png', mime: 'image/png', data: png });

    expect(attachment.id).toMatch(/^f_[a-z0-9]+\.png$/);
    expect(fs.readFileSync(path.join(root, '.ticketrail', 'files', attachment.id))).toEqual(png);

    const reloaded = new Store(root).get(task.id)!;
    expect(reloaded.attachments).toHaveLength(1);
    expect(reloaded.attachments[0]).toMatchObject({ name: 'bug.png', mime: 'image/png', size: png.length });
  });

  it('keeps the stored id portable and resolves a path only on demand', () => {
    const task = store.create({ title: 'portable' });
    const { attachment } = store.attach(task.id, { name: 'a.png', mime: 'image/png', data: png });

    const raw = JSON.parse(fs.readFileSync(path.join(root, '.ticketrail', 'tasks', `${task.id}.json`), 'utf8'));
    expect(JSON.stringify(raw)).not.toContain(root); // no absolute paths committed to the board
    expect(store.filePath(attachment)).toBe(path.join(root, '.ticketrail', 'files', attachment.id));
  });

  it('logs the attachment in the activity feed', () => {
    const task = store.create({ title: 'logged' });
    const after = store.attach(task.id, { name: 'shot.png', mime: 'image/png', data: png, addedBy: 'user' }).task;
    expect(after.activity.at(-1)!.text).toBe('Attached shot.png');
    expect(after.activity.at(-1)!.kind).toBe('file');
  });

  it('deletes the file and the record together', () => {
    const task = store.create({ title: 'removable' });
    const { attachment } = store.attach(task.id, { name: 'x.png', mime: 'image/png', data: png });
    const file = store.filePath(attachment);

    const after = store.detach(task.id, attachment.id);
    expect(after.attachments).toHaveLength(0);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('survives several attachments on one card', () => {
    const task = store.create({ title: 'many' });
    for (const name of ['a.png', 'b.log', 'c.pdf']) {
      store.attach(task.id, { name, mime: 'application/octet-stream', data: Buffer.from(name) });
    }
    expect(store.get(task.id)!.attachments.map((a) => a.name)).toEqual(['a.png', 'b.log', 'c.pdf']);
  });

  it('refuses to let a hostile filename escape the files directory', () => {
    const task = store.create({ title: 'hostile' });
    const { attachment } = store.attach(task.id, {
      name: '../../../../etc/passwd',
      mime: 'text/plain',
      data: Buffer.from('nope'),
    });
    expect(attachment.id).not.toContain('/');
    expect(attachment.name).not.toContain('/');
    expect(fs.existsSync(path.join(root, '.ticketrail', 'files', attachment.id))).toBe(true);
  });

  it('derives an extension from the MIME type when the name has none', () => {
    expect(safeExtension('screenshot', 'image/png')).toBe('png');
    expect(safeExtension('report.PDF', 'application/pdf')).toBe('pdf');
    expect(safeExtension('', 'application/octet-stream')).toBe('');
    expect(displayName('', 'fallback')).toBe('fallback');
  });
});
