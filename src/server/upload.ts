import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { MAX_ATTACHMENT_BYTES } from '../core/files.ts';

/**
 * Stream a raw request body to a file. The browser posts the File object
 * directly as the body, with the name in a header — no multipart parsing, no
 * base64 inflation, and a 5MB screenshot never sits in memory.
 */
export async function streamToFile(req: IncomingMessage, destination: string): Promise<number> {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const out = fs.createWriteStream(destination);
  let size = 0;

  try {
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_ATTACHMENT_BYTES) throw new Error('That file is too large (limit 25 MB)');
      if (!out.write(chunk)) {
        await new Promise<void>((resolve) => out.once('drain', () => resolve()));
      }
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    fs.rmSync(destination, { force: true });
    throw err;
  }

  if (size === 0) {
    fs.rmSync(destination, { force: true });
    throw new Error('That file is empty');
  }
  return size;
}
