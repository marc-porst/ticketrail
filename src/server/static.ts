import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** The built UI lives next to the bundled CLI in dist/web. */
export function resolveWebRoot(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, 'web'), // dist/cli.js -> dist/web
    path.join(here, '..', 'dist', 'web'), // src/server/*.ts (tsx dev) -> ../../dist/web
    path.join(here, '..', '..', 'dist', 'web'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return path.resolve(dir);
  }
  return null;
}

/** Serve a file from the built UI, falling back to index.html for SPA routes. */
export function serveStatic(webRoot: string, pathname: string, res: ServerResponse): boolean {
  const rel = pathname.replace(/^\/+/, '') || 'index.html';
  let file = path.resolve(webRoot, rel);
  if (!file.startsWith(webRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(webRoot, 'index.html');
  }
  if (!fs.existsSync(file)) return false;

  const ext = path.extname(file);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
  });
  fs.createReadStream(file).pipe(res);
  return true;
}
