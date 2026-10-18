import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withLock } from './lock.ts';
import { workerPresence, type WorkerPresence } from './presence.ts';
import { envVar, hasBoard } from './paths.ts';
import { Store } from './store.ts';
import { pendingQuestion, type Column } from './task.ts';

export interface ProjectRecord {
  id: string;
  path: string;
  addedAt: string;
}

export interface ProjectSummary {
  queued: number;
  inProgress: number;
  blocked: number;
  done: number;
  total: number;
}

export interface ProjectView extends ProjectRecord {
  name: string;
  shortPath: string;
  /** The directory is gone, or is no longer a board. */
  missing: boolean;
  summary: ProjectSummary;
  /** Who is working that board; absent when the board is missing. */
  workers?: WorkerPresence;
}

/** Overridable so tests never touch the real home directory. */
export function registryHome(): string {
  return envVar('HOME') ?? path.join(os.homedir(), '.ticketrail');
}

function registryFile(): string {
  const file = path.join(registryHome(), 'projects.json');
  // Carry the project list over from before the rename to Ticketrail, once.
  const legacy = path.join(os.homedir(), '.promptkanban', 'projects.json');
  if (!envVar('HOME') && !fs.existsSync(file) && fs.existsSync(legacy)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(legacy, file);
  }
  return file;
}

/**
 * Resolve symlinks and trailing slashes so the same project always hashes to
 * the same id, however it was typed on the command line.
 */
function canonical(root: string): string {
  const absolute = path.resolve(root);
  try {
    return fs.realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export function projectId(root: string): string {
  return crypto.createHash('sha256').update(canonical(root)).digest('hex').slice(0, 8);
}

export function isBoard(root: string): boolean {
  return hasBoard(root);
}

export function shortenPath(root: string): string {
  const home = os.homedir();
  return root.startsWith(home) ? root.replace(home, '~') : root;
}

function readRecords(): ProjectRecord[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(registryFile(), 'utf8'));
  } catch {
    return [];
  }
  const list = Array.isArray((raw as any)?.projects) ? (raw as any).projects : [];
  const seen = new Set<string>();
  const records: ProjectRecord[] = [];
  for (const entry of list) {
    if (typeof entry?.path !== 'string') continue;
    const id = projectId(entry.path);
    if (seen.has(id)) continue;
    seen.add(id);
    records.push({
      id,
      path: path.resolve(entry.path),
      addedAt: typeof entry.addedAt === 'string' ? entry.addedAt : new Date().toISOString(),
    });
  }
  return records;
}

function writeRecords(records: ProjectRecord[]): void {
  const home = registryHome();
  fs.mkdirSync(home, { recursive: true });
  const file = registryFile();
  const tmp = path.join(home, `.tmp-projects-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ projects: records }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function lockPath(): string {
  return path.join(registryHome(), '.registry.lock');
}

export function listProjects(): ProjectRecord[] {
  return readRecords().sort((a, b) => path.basename(a.path).localeCompare(path.basename(b.path)));
}

export function findProject(idOrPath: string): ProjectRecord | null {
  const records = readRecords();
  return records.find((r) => r.id === idOrPath) ?? records.find((r) => r.id === projectId(idOrPath)) ?? null;
}

/** Idempotent: registering a project twice is a no-op, not a duplicate. */
export function addProject(root: string): ProjectRecord {
  const resolved = path.resolve(root);
  return withLock(lockPath(), () => {
    const records = readRecords();
    const existing = records.find((r) => r.id === projectId(resolved));
    if (existing) return existing;
    const record: ProjectRecord = {
      id: projectId(resolved),
      path: resolved,
      addedAt: new Date().toISOString(),
    };
    writeRecords([...records, record]);
    return record;
  });
}

export function removeProject(idOrPath: string): ProjectRecord | null {
  return withLock(lockPath(), () => {
    const records = readRecords();
    const target = records.find((r) => r.id === idOrPath) ?? records.find((r) => r.id === projectId(idOrPath));
    if (!target) return null;
    writeRecords(records.filter((r) => r.id !== target.id));
    return target;
  });
}

const QUEUE: Column[] = ['plan', 'implement'];

/** Name, state and health of one project, for the switcher and the CLI. */
export function describeProject(record: ProjectRecord): ProjectView {
  const base = {
    ...record,
    shortPath: shortenPath(record.path),
    summary: { queued: 0, inProgress: 0, blocked: 0, done: 0, total: 0 },
  };

  if (!isBoard(record.path)) {
    return { ...base, name: path.basename(record.path), missing: true };
  }

  const store = new Store(record.path);
  const tasks = store.list();
  return {
    ...base,
    name: store.projectName(),
    missing: false,
    summary: {
      queued: tasks.filter((t) => QUEUE.includes(t.column)).length,
      inProgress: tasks.filter((t) => t.column === 'in-progress').length,
      blocked: tasks.filter((t) => pendingQuestion(t)).length,
      done: tasks.filter((t) => t.column === 'done').length,
      total: tasks.length,
    },
    workers: workerPresence(store),
  };
}

export function describeProjects(): ProjectView[] {
  return listProjects().map(describeProject);
}
