import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = '.ticketrail';
/** Boards made before the rename to Ticketrail. Still read in place until moved. */
export const LEGACY_DATA_DIR = '.promptkanban';

/** The board's data directory in `root`: `.ticketrail`, unless only a legacy `.promptkanban` exists. */
export function dataDirName(root: string): string {
  if (!fs.existsSync(path.join(root, DATA_DIR)) && fs.existsSync(path.join(root, LEGACY_DATA_DIR))) {
    return LEGACY_DATA_DIR;
  }
  return DATA_DIR;
}

/** First of the new-style, then the pre-rename environment variable. */
export function envVar(name: string): string | undefined {
  return process.env[`TICKETRAIL_${name}`] ?? process.env[`PROMPTKANBAN_${name}`]; // legacy
}

export interface Paths {
  root: string;
  data: string;
  tasks: string;
  files: string;
  locks: string;
  runtime: string;
  /** Heartbeats of the workers currently waiting on this board. */
  workers: string;
  config: string;
  folders: string;
  boardLock: string;
  serverInfo: string;
}

export function pathsFor(root: string): Paths {
  const data = path.join(root, dataDirName(root));
  return {
    root,
    data,
    tasks: path.join(data, 'tasks'),
    files: path.join(data, 'files'),
    locks: path.join(data, '.locks'),
    runtime: path.join(data, '.runtime'),
    workers: path.join(data, '.runtime', 'workers'),
    config: path.join(data, 'config.json'),
    folders: path.join(data, 'folders.json'),
    boardLock: path.join(data, '.locks', 'board.lock'),
    serverInfo: path.join(data, '.runtime', 'server.json'),
  };
}

export function hasBoard(dir: string): boolean {
  return fs.existsSync(path.join(dir, dataDirName(dir), 'config.json'));
}

/** A linked git worktree: where it is, which branch it has out, and the main checkout it belongs to. */
export interface Worktree {
  path: string;
  branch: string | null;
  main: string;
}

/**
 * Is `dir` the top of a linked git worktree? Its `.git` is a file pointing into
 * the main repository's `.git/worktrees/<name>`, so this needs no git binary.
 */
export function linkedWorktree(dir: string): Worktree | null {
  try {
    const dotGit = path.join(dir, '.git');
    if (!fs.statSync(dotGit).isFile()) return null;
    const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!match) return null;
    const gitdir = path.resolve(dir, match[1].trim());
    const common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim());
    if (path.basename(common) !== '.git') return null;
    const head = fs.readFileSync(path.join(gitdir, 'HEAD'), 'utf8').trim();
    const branch = /^ref: refs\/heads\/(.+)$/.exec(head)?.[1] ?? null;
    return { path: dir, branch, main: path.dirname(common) };
  } catch {
    return null;
  }
}

/**
 * Walk upwards looking for an initialised board. `TICKETRAIL_ROOT` wins
 * outright. Inside a linked git worktree the board is the main checkout's:
 * the worktree holds its own committed copy of .ticketrail, and a worker
 * there must claim from the same board as everyone else.
 */
export function findRoot(start: string = process.cwd()): string | null {
  const forced = envVar('ROOT');
  if (forced) return hasBoard(forced) ? path.resolve(forced) : null;

  let dir = path.resolve(start);
  for (;;) {
    const worktree = linkedWorktree(dir);
    if (worktree && hasBoard(worktree.main)) return worktree.main;
    if (hasBoard(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The linked worktree `start` is in, if any. */
export function findWorktree(start: string = process.cwd()): Worktree | null {
  let dir = path.resolve(start);
  for (;;) {
    const worktree = linkedWorktree(dir);
    if (worktree) return worktree;
    if (fs.existsSync(path.join(dir, '.git'))) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function requireRoot(start?: string): string {
  const root = findRoot(start);
  if (!root) {
    throw new Error(
      `No Ticketrail board found in this directory or any parent.\nRun "ticketrail init" first (or /ticketrail-start in Claude Code).`,
    );
  }
  return root;
}
