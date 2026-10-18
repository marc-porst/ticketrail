import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/core/store.ts';
import { HEARTBEAT_MS, STALE_MS, startHeartbeat, touchWorker, workerPresence } from '../src/core/presence.ts';
import { describeIndicator, hasWorker, READY_GRACE_MS, STALLED_MS } from '../web/src/lib/workers.ts';
import type { Task } from '../src/core/task.ts';

let root: string;
let store: Store;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-presence-'));
  store = Store.init(root);
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

const beatFile = () => path.join(store.paths.workers, `${process.pid}.json`);

describe('worker heartbeat', () => {
  it('announces a waiting worker and takes it back on stop', () => {
    expect(workerPresence(store)).toEqual({ waiting: 0, lastSeen: null, workers: [] });
    const stop = startHeartbeat(store);
    expect(fs.existsSync(beatFile())).toBe(true);
    expect(workerPresence(store).waiting).toBe(1);
    stop();
    expect(fs.existsSync(beatFile())).toBe(false);
    expect(workerPresence(store).waiting).toBe(0);
  });

  it('says who is waiting and for which cards', () => {
    const stop = startHeartbeat(store, { name: 'fe', filter: 'label:frontend' });
    expect(workerPresence(store).workers).toEqual([
      { pid: process.pid, name: 'fe', filter: 'label:frontend', since: expect.any(String) },
    ]);
    stop();
  });

  it('refreshes seenAt while it waits', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const stop = startHeartbeat(store);
    const first = JSON.parse(fs.readFileSync(beatFile(), 'utf8')).seenAt;
    vi.advanceTimersByTime(HEARTBEAT_MS);
    const second = JSON.parse(fs.readFileSync(beatFile(), 'utf8')).seenAt;
    expect(Date.parse(second) - Date.parse(first)).toBe(HEARTBEAT_MS);
    stop();
  });

  it('ignores and removes a heartbeat that went stale', () => {
    const stop = startHeartbeat(store);
    const later = Date.now() + STALE_MS + 1000;
    expect(workerPresence(store, later).waiting).toBe(0);
    expect(fs.existsSync(beatFile())).toBe(false);
    stop();
  });

  it('ignores a fresh heartbeat whose process is gone', () => {
    const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
    fs.mkdirSync(store.paths.workers, { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(store.paths.workers, `${dead}.json`), JSON.stringify({ pid: dead, startedAt: now, seenAt: now }));
    expect(workerPresence(store).waiting).toBe(0);
  });

  it('remembers when a worker last ran a command', () => {
    touchWorker(store);
    const { waiting, lastSeen } = workerPresence(store);
    expect(waiting).toBe(0);
    expect(Date.now() - Date.parse(lastSeen!)).toBeLessThan(5000);
  });
});

describe('header indicator', () => {
  const now = Date.parse('2026-10-17T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const working = [{ number: 7, column: 'in-progress' } as Task];

  it('reports the connection before anything else', () => {
    expect(describeIndicator('offline', { waiting: 1, lastSeen: null }, [], now).label).toBe('offline');
    expect(describeIndicator('connecting', undefined, [], now).label).toBe('connecting');
  });

  it('falls back to "live" for a server that does not report workers', () => {
    expect(describeIndicator('live', undefined, working, now).label).toBe('live');
  });

  it('is grey with no worker, green while one waits', () => {
    expect(describeIndicator('live', { waiting: 0, lastSeen: null }, [], now)).toMatchObject({ tone: 'grey', label: 'no worker' });
    expect(describeIndicator('live', { waiting: 1, lastSeen: ago(0) }, [], now)).toMatchObject({ tone: 'green', label: 'worker ready' });
    // between cards: no heartbeat yet, but it just ran a command
    expect(describeIndicator('live', { waiting: 0, lastSeen: ago(5000) }, [], now).label).toBe('worker ready');
    expect(describeIndicator('live', { waiting: 0, lastSeen: ago(READY_GRACE_MS + 1) }, [], now).label).toBe('no worker');
  });

  it('says working while a card runs, and stalled once the worker has gone quiet', () => {
    expect(describeIndicator('live', { waiting: 0, lastSeen: ago(60_000) }, working, now)).toMatchObject({
      label: 'working',
      pulse: true,
      title: 'Claude is on #7',
    });
    expect(describeIndicator('live', { waiting: 0, lastSeen: ago(STALLED_MS + 1) }, working, now)).toMatchObject({
      tone: 'amber',
      label: 'stalled?',
    });
    expect(describeIndicator('live', { waiting: 0, lastSeen: null }, working, now).label).toBe('stalled?');
  });
});

describe('space switcher dot', () => {
  const now = Date.parse('2026-10-17T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it('is green while a worker waits or has just run, red otherwise', () => {
    expect(hasWorker(undefined, 0, now)).toBe(false);
    expect(hasWorker({ waiting: 0, lastSeen: null }, 0, now)).toBe(false);
    expect(hasWorker({ waiting: 1, lastSeen: null }, 0, now)).toBe(true);
    expect(hasWorker({ waiting: 0, lastSeen: ago(5000) }, 0, now)).toBe(true);
    expect(hasWorker({ waiting: 0, lastSeen: ago(READY_GRACE_MS + 1) }, 0, now)).toBe(false);
  });

  it('keeps a worker on a running card green until it stalls', () => {
    expect(hasWorker({ waiting: 0, lastSeen: ago(60_000) }, 1, now)).toBe(true);
    expect(hasWorker({ waiting: 0, lastSeen: ago(STALLED_MS + 1) }, 1, now)).toBe(false);
  });
});
