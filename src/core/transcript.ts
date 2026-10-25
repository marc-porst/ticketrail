import fs from 'node:fs';
import path from 'node:path';

/**
 * What the Session tab shows: the worker's terminal, rebuilt from the Claude
 * Code transcript. Claude's own words, every tool call, and what came back.
 * Thinking, system reminders and the prompts the worker was given stay out.
 */
export interface SessionEntry {
  /** Stable across reads of the same bytes, so the browser can key and merge on it. */
  id: string;
  at: string;
  kind: 'text' | 'tool' | 'result';
  /** `text`: Claude's message, markdown. */
  text?: string;
  /** `tool` / `result`: the tool's name, as Claude Code calls it. */
  tool?: string;
  /** `tool` / `result`: pairs a result with its call. */
  toolId?: string;
  /** `tool`: one line about what the call does. */
  summary?: string;
  /** `tool`: the full command or pattern, when the summary is a description of it. */
  detail?: string;
  /** `result`: what came back, cut to MAX_OUTPUT. */
  output?: string;
  /** `result`: how many lines were cut off the output. */
  more?: number;
  error?: boolean;
  /** Written by a subagent the worker delegated to. */
  subagent?: boolean;
  /** For a subagent's entry: the toolId of the Agent call that started it. */
  parent?: string;
}

export interface TranscriptRead {
  records: any[];
  /** Byte offset to resume from: just past the last complete line read. */
  next: number;
  /** True when the range was longer than maxBytes and its start was skipped. */
  clipped: boolean;
}

/**
 * The most a single read pulls in. Transcripts reach tens of megabytes, and a
 * single request record can be over 100 KB, so this is generous on purpose.
 */
export const MAX_READ_BYTES = 8 * 1024 * 1024;
/** Tool output beyond this is cut; the terminal folds it too. */
export const MAX_OUTPUT = 4000;
const MAX_SUMMARY = 160;

/**
 * Parse the complete lines of `file` between `from` and `to` (or the end of
 * the file, while a run is still going). A half-written last line is left for
 * the next read, which resumes at `next`.
 */
export function readTranscript(
  file: string,
  from: number,
  to: number | null,
  maxBytes = MAX_READ_BYTES,
): TranscriptRead {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { records: [], next: from, clipped: false };
  }
  const end = Math.min(to ?? size, size);
  if (end <= from) return { records: [], next: from, clipped: false };

  const start = Math.max(from, end - maxBytes);
  const clipped = start > from;
  let buf: Buffer;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { records: [], next: from, clipped: false };
  }

  // Starting mid-file cuts the first line in half; it is never valid JSON.
  const first = clipped ? buf.indexOf(0x0a) + 1 : 0;
  const last = buf.lastIndexOf(0x0a);
  if (last < first) return { records: [], next: clipped ? start : from, clipped };

  const records: any[] = [];
  let offset = start + first;
  for (const line of buf.subarray(first, last + 1).toString('utf8').split('\n')) {
    const at = offset;
    offset += Buffer.byteLength(line, 'utf8') + 1;
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      // the byte offset makes an id that survives re-reading the same range
      if (record && typeof record === 'object') records.push({ ...record, __offset: at });
    } catch {
      /* something we do not understand */
    }
  }
  return { records, next: start + last + 1, clipped };
}

function oneLine(text: string, max = MAX_SUMMARY): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function relative(file: string, root?: string): string {
  if (!root || !path.isAbsolute(file)) return file;
  const rel = path.relative(root, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file;
}

/** One line about a tool call, the way the terminal would title it. */
export function describeTool(name: string, input: any, root?: string): { summary: string; detail?: string } {
  const str = (key: string) => (typeof input?.[key] === 'string' ? (input[key] as string) : '');
  switch (name) {
    case 'Bash': {
      const command = str('command');
      const description = str('description');
      return description ? { summary: oneLine(description), detail: command } : { summary: oneLine(command) };
    }
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { summary: relative(str('file_path') || str('notebook_path'), root) };
    case 'Grep':
    case 'Glob': {
      const where = str('path');
      return { summary: oneLine(where ? `${str('pattern')} in ${relative(where, root)}` : str('pattern')) };
    }
    case 'Agent':
    case 'Task':
      return { summary: oneLine(str('description') || str('prompt')), detail: str('prompt') || undefined };
    case 'WebFetch':
      return { summary: str('url') };
    case 'WebSearch':
      return { summary: oneLine(str('query')) };
    case 'Skill':
      return { summary: str('skill') };
    case 'TodoWrite':
      return { summary: 'Updated the to-do list' };
    default: {
      const first = Object.values(input ?? {}).find((v) => typeof v === 'string') as string | undefined;
      return { summary: first ? oneLine(first) : '' };
    }
  }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: any) => (block?.type === 'text' ? String(block.text ?? '') : block?.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

function cut(text: string): { output: string; more?: number } {
  if (text.length <= MAX_OUTPUT) return { output: text };
  const kept = text.slice(0, MAX_OUTPUT);
  const more = text.slice(MAX_OUTPUT).split('\n').length - (text[MAX_OUTPUT - 1] === '\n' ? 0 : 1);
  return { output: kept, more: Math.max(1, more) };
}

/**
 * Turn transcript records into what the Session tab lists. Tool names are
 * remembered across calls through `names`, so a result read in a later chunk
 * than its call still knows which tool it belongs to.
 */
export function toSessionEntries(
  records: any[],
  options: { root?: string; names?: Map<string, string> } = {},
): SessionEntry[] {
  const names = options.names ?? new Map<string, string>();
  const entries: SessionEntry[] = [];
  for (const record of records) {
    if (record?.isMeta) continue;
    const content = record?.message?.content;
    if (!Array.isArray(content)) continue; // a plain string is a prompt, not output
    const at = typeof record.timestamp === 'string' ? record.timestamp : new Date().toISOString();
    const base = `${record.__offset ?? record.uuid ?? entries.length}`;
    const subagent = record.isSidechain === true ? { subagent: true } : {};

    content.forEach((block: any, i: number) => {
      const id = `${base}:${i}`;
      if (record.type === 'assistant') {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          entries.push({ id, at, kind: 'text', text: block.text, ...subagent });
        } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
          if (typeof block.id === 'string') names.set(block.id, block.name);
          const { summary, detail } = describeTool(block.name, block.input, options.root);
          entries.push({
            id,
            at,
            kind: 'tool',
            tool: block.name,
            ...(typeof block.id === 'string' ? { toolId: block.id } : {}),
            summary,
            ...(detail && detail !== summary ? { detail } : {}),
            ...subagent,
          });
        }
      } else if (record.type === 'user' && block?.type === 'tool_result') {
        const toolId = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined;
        const tool = toolId ? names.get(toolId) : undefined;
        entries.push({
          id,
          at,
          kind: 'result',
          ...(tool ? { tool } : {}),
          ...(toolId ? { toolId } : {}),
          ...cut(resultText(block.content)),
          ...(block.is_error === true ? { error: true } : {}),
          ...subagent,
        });
      }
    });
  }
  return entries;
}

/**
 * A transcript path the server may read: a .jsonl under the Claude home's
 * projects folder. A task file is plain JSON anyone can edit, so the path in
 * it is never trusted on its own.
 */
export function isTranscriptPath(file: string, home: string): boolean {
  if (!path.isAbsolute(file) || path.extname(file) !== '.jsonl') return false;
  let real: string;
  let projects: string;
  try {
    real = fs.realpathSync(file);
    projects = fs.realpathSync(path.join(home, 'projects'));
  } catch {
    return false;
  }
  const rel = path.relative(projects, real);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Tools that hand work to a subagent. `Task` is what older Claude Code called it. */
const AGENT_TOOLS = new Set(['Agent', 'Task']);

/** Most entries one subagent contributes; long reviews can run to hundreds of steps. */
export const MAX_SUBAGENT_ENTRIES = 1000;

/**
 * Where Claude Code writes the subagents of a session: their steps are not in
 * the main transcript but in `<session>/subagents/agent-<id>.jsonl`, each with a
 * `.meta.json` naming the Agent call (`toolUseId`) that started it.
 */
export function subagentDir(transcript: string): string {
  return path.join(path.dirname(transcript), path.basename(transcript, '.jsonl'), 'subagents');
}

/**
 * Reads one run of a session: the worker's own range of its transcript, plus
 * the subagents it started in that range, whose steps are tagged with the
 * Agent call they belong to. Call `read()` again to get only what is new.
 */
export class SessionReader {
  /** The main transcript's offset to resume from. */
  next: number;
  /** Some of the run's start was not read. */
  clipped = false;
  private readonly names = new Map<string, string>();
  /** Agent calls seen so far, in the worker's run and inside its subagents. */
  private readonly calls = new Set<string>();
  /** Subagent transcripts being followed, by file. */
  private readonly agents = new Map<string, { offset: number; parent: string; agent: string; count: number }>();
  /** meta.json files already matched, so they are parsed once. */
  private readonly matched = new Set<string>();

  constructor(
    readonly transcript: string,
    from: number,
    private readonly root?: string,
    private readonly maxBytes = MAX_READ_BYTES,
  ) {
    this.next = from;
  }

  /** Everything new since the last read, up to `to` in the main transcript (or its end). */
  read(to: number | null): SessionEntry[] {
    const main = readTranscript(this.transcript, this.next, to, this.maxBytes);
    if (main.clipped) this.clipped = true;
    this.next = main.next;
    const out = this.track(toSessionEntries(main.records, { root: this.root, names: this.names }));
    if (this.calls.size) out.push(...this.readAgents());
    return out;
  }

  private track(entries: SessionEntry[]): SessionEntry[] {
    for (const e of entries) {
      if (e.kind === 'tool' && e.toolId && e.tool && AGENT_TOOLS.has(e.tool)) this.calls.add(e.toolId);
    }
    return entries;
  }

  private readAgents(): SessionEntry[] {
    const dir = subagentDir(this.transcript);
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      return [];
    }
    // a subagent's meta can appear after its first lines, so unmatched ones are looked at every read
    this.match(dir, files);

    const out: SessionEntry[] = [];
    // nested subagents are found as their parents' Agent calls are read, so loop until nothing new
    for (let round = 0; round < 4; round++) {
      let found = false;
      for (const [file, state] of this.agents) {
        const read = readTranscript(file, state.offset, null, this.maxBytes);
        state.offset = read.next;
        const entries = toSessionEntries(read.records, { root: this.root, names: this.names });
        if (!entries.length) continue;
        found = true;
        this.track(entries);
        for (const e of entries) {
          if (state.count >= MAX_SUBAGENT_ENTRIES) break;
          state.count++;
          out.push({ ...e, id: `${state.agent}:${e.id}`, subagent: true, parent: e.parent ?? state.parent });
        }
      }
      if (!found) break;
      const before = this.agents.size;
      this.match(dir, files);
      if (this.agents.size === before) break;
    }
    return out;
  }

  /** Start following every subagent whose Agent call this run made. */
  private match(dir: string, files: string[]): void {
    for (const name of files) {
      if (!name.endsWith('.meta.json') || this.matched.has(name)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (typeof meta?.toolUseId !== 'string' || !this.calls.has(meta.toolUseId)) continue;
        const agent = name.slice(0, -'.meta.json'.length);
        this.matched.add(name);
        this.agents.set(path.join(dir, `${agent}.jsonl`), { offset: 0, parent: meta.toolUseId, agent, count: 0 });
      } catch {
        /* next time */
      }
    }
  }
}

/**
 * The last `max` of the worker's own entries, with every subagent step that
 * belongs to an Agent call still in view. Steps never outlive their call.
 */
export function lastEntries(entries: SessionEntry[], max: number): { entries: SessionEntry[]; cut: boolean } {
  const own = entries.filter((e) => !e.parent);
  if (own.length <= max) return { entries, cut: false };
  const kept = new Set(own.slice(-max).map((e) => e.id));
  const calls = new Set(own.slice(-max).flatMap((e) => (e.toolId ? [e.toolId] : [])));
  // nested calls stay too, as long as their own parent is kept
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of entries) {
      if (e.parent && calls.has(e.parent) && e.kind === 'tool' && e.toolId && !calls.has(e.toolId)) {
        calls.add(e.toolId);
        grew = true;
      }
    }
  }
  return { entries: entries.filter((e) => kept.has(e.id) || (e.parent !== undefined && calls.has(e.parent))), cut: true };
}
