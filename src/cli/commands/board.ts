import fs from 'node:fs';
import type { Store } from '../../core/store.ts';
import {
  COLUMN_LABELS,
  COLUMNS,
  isColumn,
  isTaskType,
  pendingQuestion,
  TASK_TYPES,
  TYPE_LABELS,
  type Column,
  type Task,
  type TaskType,
} from '../../core/task.ts';
import { FOLDER_COLORS, isFolderColor } from '../../core/folder.ts';
import { flagBool, flagList, flagString, type Args } from '../args.ts';
import { printJson, textInput } from '../io.ts';
import { withPaths } from './attach.ts';
import { agentExists, isAgentName, listAgents } from '../../core/agents.ts';

export function addCommand(store: Store, args: Args, positional: string[]): void {
  const title = positional.join(' ').trim() || flagString(args, 'title') || '';
  if (!title) {
    throw new Error(
      'Usage: ticketrail add "card title" [--description "..."] [--column backlog] [--type feature] [--label x] [--related 12,14]',
    );
  }

  const descriptionFile = flagString(args, 'description-file');
  const description = descriptionFile
    ? descriptionFile === '-'
      ? textInput(args, [], ['description-file'])
      : fs.readFileSync(descriptionFile, 'utf8')
    : (flagString(args, 'description') ?? '');

  const column = flagString(args, 'column');
  if (column && !isColumn(column)) throw new Error(`Unknown column "${column}". One of: ${COLUMNS.join(', ')}`);

  const task = store.create({
    title,
    description,
    column: (column as Column) ?? 'backlog',
    position: flagBool(args, 'bottom') ? 'bottom' : 'top',
    type: readType(args),
    labels: flagList(args, 'label'),
    related: flagList(args, 'related').flatMap((r) => r.split(',')).map((r) => store.find(r.trim())?.id ?? ''),
    folder: readFolder(store, args),
    agent: readAgentFlag(store, args),
    worker: flagString(args, 'for') ?? null,
  });
  console.log(`#${task.number} "${task.title}" -> ${COLUMN_LABELS[task.column]}  (${task.id})`);
}

/** `--agent <name>`, which must exist in .claude/agents/. */
function readAgentFlag(store: Store, args: Args): string | null {
  const name = flagString(args, 'agent');
  if (name === undefined) return null;
  return requireAgent(store, name);
}

function requireAgent(store: Store, name: string): string {
  if (!isAgentName(name)) throw new Error(`"${name}" is not a valid agent name`);
  if (!agentExists(store.root, name)) {
    const known = listAgents(store.root).map((a) => a.name);
    throw new Error(`No agent "${name}" in .claude/agents/.${known.length ? ` Known: ${known.join(', ')}` : ''}`);
  }
  return name;
}

/** `assign <card> <agent|none>`: hand a card to a project agent, or take it back. */
export function assignCommand(store: Store, positional: string[]): void {
  const [ref, target] = positional;
  if (!ref || !target) throw new Error('Usage: ticketrail assign <card id or #number> <agent name|none>');
  const task = store.find(ref);
  if (!task) throw new Error(`No task with id "${ref}"`);
  const agent = target === 'none' ? null : requireAgent(store, target);
  const updated = store.patch(task.id, { agent });
  console.log(`#${updated.number} ${agent ? `-> agent "${agent}"` : 'is no longer assigned to an agent'}`);
}

/** `send <card> <worker|none>`: only that named worker may claim the card. */
export function sendCommand(store: Store, positional: string[]): void {
  const [ref, target] = positional;
  if (!ref || !target) throw new Error('Usage: ticketrail send <card id or #number> <worker name|none>');
  const task = store.find(ref);
  if (!task) throw new Error(`No task with id "${ref}"`);
  const updated = store.patch(task.id, { worker: target === 'none' ? null : target });
  console.log(`#${updated.number} ${updated.worker ? `-> worker "${updated.worker}" only` : 'can be taken by any worker'}`);
}

/** The project's agents as JSON. */
export function agentsCommand(store: Store): void {
  printJson(listAgents(store.root));
}

/** `--folder <name or id>`, which must already exist. */
function readFolder(store: Store, args: Args): string | null {
  const ref = flagString(args, 'folder');
  if (ref === undefined) return null;
  const folder = store.findFolder(ref);
  if (!folder) throw new Error(`No folder "${ref}". Create it with: ticketrail folder add "${ref}"`);
  return folder.id;
}

/** `--type` with validation, shared by add and the type flag on other commands. */
function readType(args: Args): TaskType | null {
  const value = flagString(args, 'type');
  if (value === undefined) return null;
  if (!isTaskType(value)) throw new Error(`Unknown type "${value}". One of: ${TASK_TYPES.join(', ')}`);
  return value;
}

export function labelCommand(store: Store, args: Args, positional: string[]): void {
  const [id] = positional;
  const add = flagList(args, 'add');
  const remove = flagList(args, 'remove');
  if (!id || (!add.length && !remove.length)) {
    throw new Error('Usage: ticketrail label <id> [--add <label>]... [--remove <label>]...');
  }
  const task = store.get(id);
  if (!task) throw new Error(`No task with id "${id}"`);

  const dropped = new Set(remove.map((l) => l.trim().toLowerCase()));
  const kept = task.labels.filter((l) => !dropped.has(l.toLowerCase()));
  const updated = store.patch(id, { labels: [...kept, ...add] });
  console.log(`#${updated.number} labels: ${updated.labels.join(', ') || '(none)'}`);
}

export function deriveCommand(store: Store, positional: string[]): void {
  const [id] = positional;
  if (!id) throw new Error('Usage: ticketrail derive <id>   (spawn a Feature card from an investigation)');
  const task = store.deriveImplementation(id);
  console.log(`#${task.number} "${task.title}" -> ${COLUMN_LABELS[task.column]}  (${task.id})`);
}

export function showCommand(store: Store, positional: string[]): void {
  const [id] = positional;
  if (!id) throw new Error('Usage: ticketrail show <id>');
  const task = store.find(id);
  if (!task) throw new Error(`No task with id "${id}"`);
  const summary = (t: Task) => ({ id: t.id, number: t.number, title: t.title, column: t.column });
  printJson({
    ...withPaths(store, task),
    ...(task.folder ? { folderName: store.findFolder(task.folder)?.name ?? null } : {}),
    relatedCards: store.relatedOf(task).map(summary),
    referencedBy: store.referencedBy(task.id).map(summary),
  });
}

/** `relate <id> <other>...` links cards; `unrelate` removes the links. Ids or #numbers. */
export function relateCommand(store: Store, positional: string[], unlink = false): void {
  const [ref, ...others] = positional;
  const verb = unlink ? 'unrelate' : 'relate';
  if (!ref || !others.length) throw new Error(`Usage: ticketrail ${verb} <id> <other id or #number>...`);
  const task = store.find(ref);
  if (!task) throw new Error(`No task with id "${ref}"`);
  const ids = others.map((o) => {
    const found = store.find(o);
    if (!found) throw new Error(`No task with id "${o}"`);
    return found.id;
  });
  const related = unlink ? task.related.filter((r) => !ids.includes(r)) : [...task.related, ...ids];
  const updated = store.patch(task.id, { related });
  const numbers = store.relatedOf({ ...updated, derivedFrom: null }).map((t) => `#${t.number}`);
  console.log(`#${updated.number} related: ${numbers.join(', ') || '(none)'}`);
}

export function listCommand(store: Store, args: Args): void {
  const column = flagString(args, 'column');
  if (column && !isColumn(column)) throw new Error(`Unknown column "${column}". One of: ${COLUMNS.join(', ')}`);
  const type = flagString(args, 'type');
  if (type && !isTaskType(type)) throw new Error(`Unknown type "${type}". One of: ${TASK_TYPES.join(', ')}`);
  const wanted = flagList(args, 'label').map((l) => l.toLowerCase());
  const folder = flagString(args, 'folder') !== undefined ? readFolder(store, args) : undefined;

  const tasks = store.list().filter(
    (t) =>
      (!column || t.column === column) &&
      (folder === undefined || t.folder === folder) &&
      (!type || t.type === type) &&
      (!wanted.length || wanted.every((w) => t.labels.some((l) => l.toLowerCase() === w))),
  );
  printJson(
    tasks.map(({ activity, messages, ...rest }) => ({
      ...rest,
      activityCount: activity.length,
      messageCount: messages.length,
    })),
  );
}

export function moveCommand(store: Store, positional: string[]): void {
  const [id, column] = positional;
  if (!id || !isColumn(column)) {
    throw new Error(`Usage: ticketrail move <id> <${COLUMNS.join('|')}>`);
  }
  const task = store.move(id, column);
  console.log(`#${task.number} "${task.title}" -> ${COLUMN_LABELS[task.column]}`);
}

export function statusCommand(store: Store): void {
  const tasks = store.list();
  const server = fs.existsSync(store.paths.serverInfo)
    ? (JSON.parse(fs.readFileSync(store.paths.serverInfo, 'utf8')) as { url: string; pid: number })
    : null;

  console.log(`Ticketrail · ${store.root}`);
  console.log(server ? `  server ${server.url} (pid ${server.pid})` : '  server not running — ticketrail serve');
  console.log('');

  for (const column of COLUMNS) {
    const inColumn = tasks.filter((t) => t.column === column);
    if (!inColumn.length) continue;
    console.log(`  ${COLUMN_LABELS[column]} (${inColumn.length})`);
    for (const task of inColumn) {
      const waiting = pendingQuestion(task) ? '  ← needs your answer' : '';
      const tags = [task.type ? TYPE_LABELS[task.type] : null, ...task.labels].filter(Boolean);
      const suffix = tags.length ? `  [${tags.join(', ')}]` : '';
      console.log(`    #${task.number}  ${task.title}${suffix}${waiting}`);
    }
  }
  if (!tasks.length) console.log('  the board is empty');
}

/** `folders`: every folder on the board, with how many cards each holds. */
export function foldersCommand(store: Store): void {
  const tasks = store.list();
  printJson(store.folders().map((f) => ({ ...f, cards: tasks.filter((t) => t.folder === f.id).length })));
}

/** `folder add|rename|color|remove ...` */
export function folderCommand(store: Store, args: Args, positional: string[]): void {
  const [action, ref, ...rest] = positional;
  const usage =
    'Usage: ticketrail folder add "name" [--color sky] | rename <folder> "new name" | color <folder> <colour> | remove <folder>';
  const resolve = () => {
    const found = ref ? store.findFolder(ref) : null;
    if (!found) throw new Error(ref ? `No folder "${ref}"` : usage);
    return found;
  };
  switch (action) {
    case 'add': {
      const name = [ref, ...rest].filter(Boolean).join(' ');
      if (!name) throw new Error(usage);
      const color = flagString(args, 'color');
      if (color && !isFolderColor(color)) throw new Error(`Unknown colour "${color}". One of: ${FOLDER_COLORS.join(', ')}`);
      const folder = store.createFolder({ name, color: color as any });
      return console.log(`folder "${folder.name}" created  (${folder.id})`);
    }
    case 'rename': {
      const folder = store.updateFolder(resolve().id, { name: rest.join(' ') });
      return console.log(`folder renamed to "${folder.name}"`);
    }
    case 'color': {
      const [color] = rest;
      if (!isFolderColor(color)) throw new Error(`Unknown colour "${color}". One of: ${FOLDER_COLORS.join(', ')}`);
      const folder = store.updateFolder(resolve().id, { color });
      return console.log(`folder "${folder.name}" is now ${folder.color}`);
    }
    case 'remove': {
      const folder = resolve();
      store.deleteFolder(folder.id);
      return console.log(`folder "${folder.name}" removed; its cards are kept, unfiled`);
    }
    default:
      throw new Error(usage);
  }
}

/** `file <card> <folder|none>`: put a card in a folder, or take it out. */
export function fileCommand(store: Store, positional: string[]): void {
  const [ref, ...rest] = positional;
  const target = rest.join(' ');
  if (!ref || !target) throw new Error('Usage: ticketrail file <card id or #number> <folder name|id|none>');
  const task = store.find(ref);
  if (!task) throw new Error(`No task with id "${ref}"`);
  const folder = target === 'none' ? null : store.findFolder(target);
  if (target !== 'none' && !folder) throw new Error(`No folder "${target}"`);
  const updated = store.patch(task.id, { folder: folder?.id ?? null });
  console.log(`#${updated.number} ${folder ? `-> folder "${folder.name}"` : 'is no longer in a folder'}`);
}
