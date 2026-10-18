import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envVar } from './paths.ts';

/**
 * How much of a transcript to read. Claude Code appends to these all session
 * and they reach tens of megabytes, so the last assistant record is found by
 * seeking to the end rather than by parsing the file.
 */
const TAIL_BYTES = 256 * 1024;

/** A model value Claude Code writes for records that had no real completion. */
const SYNTHETIC = '<synthetic>';

function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
}

/**
 * The transcript Claude Code is writing for this session. It lives under a
 * directory named after the project, but the slug rule is undocumented, so the
 * file is found by its name -- the session id -- which is exact.
 */
export function findTranscript(sessionId: string, home = claudeHome()): string | null {
  if (!sessionId) return null;
  const projects = path.join(home, 'projects');
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const file = path.join(projects, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * The model of the most recent assistant turn: what the API actually answered
 * with, rather than what a worker says about itself.
 *
 * Subagent turns are interleaved into the same file and may run on a different
 * model, so they are skipped -- the worker's own turns are never sidechains.
 */
export function modelFromTranscript(file: string): string | null {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return null;
  }

  const start = Math.max(0, size - TAIL_BYTES);
  let text: string;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }

  const lines = text.split('\n');
  // Reading from an offset cuts the first line in half; it is never valid JSON.
  if (start > 0) lines.shift();

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // a half-written last line, or something we do not understand
    }
    if (record?.type !== 'assistant' || record.isSidechain === true) continue;
    const model = record.message?.model;
    if (typeof model === 'string' && model && model !== SYNTHETIC) return model;
  }
  return null;
}

/**
 * Which model is driving this process. An explicit answer wins, then what the
 * API actually answered with, then what was merely requested.
 */
export function resolveModel(explicit?: string): string | null {
  const direct = explicit ?? envVar('MODEL');
  if (direct) return direct;

  const sessionId = process.env.CLAUDE_CODE_SESSION_ID ?? '';
  const transcript = findTranscript(sessionId);
  if (transcript) {
    const model = modelFromTranscript(transcript);
    if (model) return model;
  }

  // Set when a model was pinned in settings. It may be an alias ("opus")
  // rather than a concrete id, which is why it ranks below the transcript.
  return process.env.ANTHROPIC_MODEL || null;
}

/** `claude-opus-5` -> `Opus 5`. Anything unfamiliar is shown as it is. */
export function modelLabel(model: string): string {
  const bare = model.replace(/\[[^\]]*\]$/, ''); // a context-window suffix
  if (!bare.startsWith('claude-')) return model;

  const parts = bare.slice('claude-'.length).split('-');
  const family = parts.shift();
  if (!family) return model;

  // A trailing snapshot date is noise: claude-haiku-4-5-20251001 -> Haiku 4.5
  if (parts.length && /^\d{8}$/.test(parts[parts.length - 1])) parts.pop();
  if (!parts.every((p) => /^\d+$/.test(p))) return model;

  const name = family.charAt(0).toUpperCase() + family.slice(1);
  return parts.length ? `${name} ${parts.join('.')}` : name;
}
