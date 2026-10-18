import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../../core/store.ts';
import { formatBytes, mimeForExtension } from '../../core/files.ts';
import type { Attachment, Task } from '../../core/task.ts';
import { flagBool, type Args } from '../args.ts';
import { printJson } from '../io.ts';

/**
 * Attachments are stored with a relative id so the board stays portable, but
 * Claude needs a real path to open one. Resolve it only on the way out.
 */
export function withPaths(store: Store, task: Task) {
  return {
    ...task,
    attachments: task.attachments.map((a) => ({ ...a, path: store.filePath(a) })),
  };
}

/** Longest a related card's description, plan or result may run in `next`. */
export const RELATED_FIELD_LIMIT = 8000;

function clip(text: string | null, id: string): string | null {
  if (text === null || text.length <= RELATED_FIELD_LIMIT) return text;
  return `${text.slice(0, RELATED_FIELD_LIMIT)}\n…(truncated, run show ${id})`;
}

/**
 * The related cards Claude reads with the one it claimed. One level deep, no
 * chat, long fields cut: context for this card, not work of their own.
 */
export function relatedContext(store: Store, task: Task) {
  return store.relatedOf(task).map((r) => ({
    id: r.id,
    number: r.number,
    title: r.title,
    column: r.column,
    type: r.type,
    labels: r.labels,
    relation: task.related.includes(r.id) ? 'related' : 'derivedFrom',
    archived: r.archived,
    inProgress: r.column === 'in-progress',
    description: clip(r.description, r.id),
    plan: clip(r.plan, r.id),
    result: clip(r.result, r.id),
    attachments: r.attachments.map((a) => ({ ...a, path: store.filePath(a) })),
  }));
}

export function attachCommand(store: Store, args: Args, positional: string[]): void {
  const [id, ...files] = positional;
  if (!id || !files.length) {
    throw new Error('Usage: ticketrail attach <id> <file> [more files...] [--as-user]');
  }

  const added: Attachment[] = [];
  for (const file of files) {
    if (!fs.existsSync(file)) throw new Error(`No such file: ${file}`);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) throw new Error(`${file} is a directory`);

    const { attachment } = store.attach(id, {
      name: path.basename(file),
      mime: mimeForExtension(path.extname(file)),
      data: fs.readFileSync(file),
      addedBy: flagBool(args, 'as-user') ? 'user' : 'claude',
    });
    added.push(attachment);
    console.log(`attached ${attachment.name} (${formatBytes(attachment.size)}) -> ${attachment.id}`);
  }
}

export function filesCommand(store: Store, positional: string[]): void {
  const [id] = positional;
  const task = id ? store.get(id) : null;
  if (!task) throw new Error('Usage: ticketrail files <id>');
  printJson(withPaths(store, task).attachments);
}

export function detachCommand(store: Store, positional: string[]): void {
  const [id, fileId] = positional;
  if (!id || !fileId) throw new Error('Usage: ticketrail detach <id> <fileId>');
  store.detach(id, fileId);
  console.log(`removed ${fileId}`);
}
