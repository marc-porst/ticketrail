import fs from 'node:fs';
import path from 'node:path';

const STALE_MS = 10_000;
const RETRY_MS = 15;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * A cross-process mutex built on mkdir, which is atomic on every platform we
 * care about. Both the server and the CLI serialise their writes through it,
 * so the board never loses an update when Claude and the browser act at once.
 */
export function withLock<T>(lockPath: string, fn: () => T, timeoutMs = 5000): T {
  const start = Date.now();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > STALE_MS) {
          fs.rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // lock vanished between calls; try again
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for the board lock (${lockPath})`);
      }
      sleepSync(RETRY_MS);
    }
  }

  try {
    return fn();
  } finally {
    try {
      fs.rmSync(lockPath, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}
