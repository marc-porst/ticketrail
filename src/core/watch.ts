import { EventEmitter } from 'node:events';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { Store } from './store.ts';
import type { Task } from './task.ts';
import type { Folder } from './folder.ts';

export type BoardEvent =
  | { type: 'created' | 'updated'; id: string; task: Task }
  | { type: 'deleted'; id: string }
  | { type: 'folders'; folders: Folder[] };

/**
 * Watches the task folder. Whoever wrote the file -- the server, the CLI, or
 * a human with an editor -- everyone else finds out.
 */
export class BoardWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  /** folders.json sits beside tasks/, so it gets a shallow watcher of its own. */
  private dataWatcher: FSWatcher | null = null;
  private readonly store: Store;
  private started = false;

  constructor(store: Store) {
    super();
    this.store = store;
    this.setMaxListeners(0);
  }

  start(): this {
    if (this.started) return this;
    this.started = true;
    this.watcher = chokidar.watch(this.store.paths.tasks, {
      ignoreInitial: true,
      ignored: (file) => path.basename(file).startsWith('.'),
      awaitWriteFinish: { stabilityThreshold: 20, pollInterval: 10 },
    });
    this.watcher
      .on('add', (file) => this.emitFor('created', file))
      .on('change', (file) => this.emitFor('updated', file))
      .on('unlink', (file) => {
        const id = path.basename(file, '.json');
        this.emit('board', { type: 'deleted', id } satisfies BoardEvent);
      });
    const data = path.resolve(this.store.paths.data);
    this.dataWatcher = chokidar.watch(data, {
      ignoreInitial: true,
      depth: 0,
      // .ticketrail is itself a dot-directory: skip the dotfiles inside it, not the root
      ignored: (file) => path.resolve(file) !== data && path.basename(file).startsWith('.'),
      awaitWriteFinish: { stabilityThreshold: 20, pollInterval: 10 },
    });
    const foldersChanged = (file: string) => {
      if (path.resolve(file) !== path.resolve(this.store.paths.folders)) return;
      this.emit('board', { type: 'folders', folders: this.store.folders() } satisfies BoardEvent);
    };
    this.dataWatcher.on('add', foldersChanged).on('change', foldersChanged).on('unlink', foldersChanged);
    return this;
  }

  private emitFor(type: 'created' | 'updated', file: string): void {
    if (!file.endsWith('.json')) return;
    const id = path.basename(file, '.json');
    const task = this.store.get(id);
    if (!task) return;
    this.emit('board', { type, id, task } satisfies BoardEvent);
  }

  async stop(): Promise<void> {
    this.started = false;
    await Promise.all([this.watcher?.close(), this.dataWatcher?.close()]);
    this.watcher = null;
    this.dataWatcher = null;
  }
}

/**
 * Resolve as soon as `probe` returns something truthy, or with null when the
 * timeout expires; `Infinity` waits for as long as it takes. Backed by the
 * file watcher, with a slow poll as a safety net for filesystems where events
 * get dropped (network mounts, some VMs).
 */
export function waitFor<T>(store: Store, probe: () => T | null, timeoutMs: number): Promise<T | null> {
  const immediate = probe();
  if (immediate) return Promise.resolve(immediate);
  if (timeoutMs <= 0) return Promise.resolve(null);

  return new Promise<T | null>((resolve) => {
    const watcher = new BoardWatcher(store).start();
    let settled = false;

    const finish = (value: T | null) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      if (timer) clearTimeout(timer);
      void watcher.stop();
      resolve(value);
    };

    const check = () => {
      if (settled) return;
      let value: T | null = null;
      try {
        value = probe();
      } catch {
        value = null;
      }
      if (value) finish(value);
    };

    watcher.on('board', check);
    const poll = setInterval(check, 2000);
    // setTimeout fires at once for anything past 2^31-1 ms, so "no limit" sets no timer at all
    const timer = Number.isFinite(timeoutMs) ? setTimeout(() => finish(null), timeoutMs) : null;
  });
}
