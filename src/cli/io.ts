import fs from 'node:fs';
import { flagString, type Args } from './args.ts';

export function readStdin(): string {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Text for commands that take prose: --file <path> (or "-" for stdin),
 * --text "...", the remaining positional arguments, or piped stdin.
 */
export function textInput(args: Args, positional: string[], fileFlags: string[] = ['file']): string {
  const file = flagString(args, ...fileFlags);
  if (file === '-') return readStdin().trim();
  if (file) return fs.readFileSync(file, 'utf8').trim();

  const text = flagString(args, 'text');
  if (text) return text.trim();

  if (positional.length) return positional.join(' ').trim();
  if (!process.stdin.isTTY) return readStdin().trim();
  return '';
}

export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}
