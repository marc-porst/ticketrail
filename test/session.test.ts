import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/core/store.ts';
import { MAX_SESSION_HISTORY, normalizeTask } from '../src/core/task.ts';
import { addProject, projectId } from '../src/core/registry.ts';
import { startServer, type ServerHandle } from '../src/server/server.ts';
import {
  MAX_OUTPUT,
  SessionReader,
  describeTool,
  lastEntries,
  subagentDir,
  isTranscriptPath,
  readTranscript,
  toSessionEntries,
} from '../src/core/transcript.ts';

let root: string;
let claude: string;
let transcript: string;

const line = (record: unknown) => JSON.stringify(record) + '\n';
const at = '2026-10-25T07:00:00.000Z';

const text = (t: string, extra: object = {}) =>
  line({ type: 'assistant', timestamp: at, message: { content: [{ type: 'text', text: t }] }, ...extra });
const call = (id: string, name: string, input: object, extra: object = {}) =>
  line({ type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', id, name, input }] }, ...extra });
const result = (id: string, content: unknown, isError = false) =>
  line({
    type: 'user',
    timestamp: at,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
  });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-session-'));
  claude = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-claude-'));
  fs.mkdirSync(path.join(claude, 'projects', 'proj'), { recursive: true });
  transcript = path.join(claude, 'projects', 'proj', 'abc.jsonl');
  fs.writeFileSync(transcript, '');
  process.env.CLAUDE_CONFIG_DIR = claude;
});

afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(claude, { recursive: true, force: true });
});

describe('transcript reading', () => {
  it('turns text, calls and results into entries and skips everything else', () => {
    fs.writeFileSync(
      transcript,
      line({ type: 'user', timestamp: at, message: { content: '/ticketrail-work' } }) +
        line({ type: 'api-request', timestamp: at }) +
        line({ type: 'assistant', timestamp: at, message: { content: [{ type: 'thinking', thinking: 'hm' }] } }) +
        text('Looking at the store.') +
        call('t1', 'Bash', { command: 'npm test', description: 'Run the tests' }) +
        result('t1', 'all green') +
        call('t2', 'Read', { file_path: path.join(root, 'src/a.ts') }) +
        result('t2', [{ type: 'text', text: 'no such file' }], true) +
        call('t3', 'Grep', { pattern: 'foo' }, { isSidechain: true }) +
        'not json\n' +
        '{"type":"assistant","message":', // half written
    );
    const read = readTranscript(transcript, 0, null);
    const entries = toSessionEntries(read.records, { root });

    expect(entries.map((e) => e.kind)).toEqual(['text', 'tool', 'result', 'tool', 'result', 'tool']);
    expect(entries[0].text).toBe('Looking at the store.');
    expect(entries[1]).toMatchObject({ tool: 'Bash', summary: 'Run the tests', detail: 'npm test', toolId: 't1' });
    expect(entries[2]).toMatchObject({ tool: 'Bash', output: 'all green', toolId: 't1' });
    expect(entries[3].summary).toBe(path.join('src', 'a.ts'));
    expect(entries[4]).toMatchObject({ tool: 'Read', output: 'no such file', error: true });
    expect(entries[5].subagent).toBe(true);
    // the half-written line is left for the next read
    expect(read.next).toBe(fs.statSync(transcript).size - '{"type":"assistant","message":'.length);
  });

  it('reads only its own byte range and resumes where it stopped', () => {
    fs.writeFileSync(transcript, text('an earlier card'));
    const from = fs.statSync(transcript).size;
    fs.appendFileSync(transcript, text('this card'));
    const first = readTranscript(transcript, from, null);
    expect(toSessionEntries(first.records).map((e) => e.text)).toEqual(['this card']);

    fs.appendFileSync(transcript, text('more'));
    const second = readTranscript(transcript, first.next, null);
    expect(toSessionEntries(second.records).map((e) => e.text)).toEqual(['more']);

    // a closed range ignores whatever the session wrote afterwards
    const to = fs.statSync(transcript).size;
    fs.appendFileSync(transcript, text('the next card'));
    const closed = readTranscript(transcript, from, to);
    expect(toSessionEntries(closed.records).map((e) => e.text)).toEqual(['this card', 'more']);
  });

  it('gives the same ids on a re-read, so the browser can merge', () => {
    fs.writeFileSync(transcript, text('one') + text('two'));
    const a = toSessionEntries(readTranscript(transcript, 0, null).records).map((e) => e.id);
    const b = toSessionEntries(readTranscript(transcript, 0, null).records).map((e) => e.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(2);
  });

  it('keeps the tail of a range too big to read and says so', () => {
    for (let i = 0; i < 50; i++) fs.appendFileSync(transcript, text(`line ${i}`));
    const read = readTranscript(transcript, 0, null, 400);
    const entries = toSessionEntries(read.records);
    expect(read.clipped).toBe(true);
    expect(entries.at(-1)?.text).toBe('line 49');
    expect(entries.length).toBeLessThan(50);
  });

  it('cuts long output and counts what it left out', () => {
    const big = Array.from({ length: 2000 }, (_, i) => `row ${i}`).join('\n');
    fs.writeFileSync(transcript, call('t', 'Bash', { command: 'cat big' }) + result('t', big));
    const [, out] = toSessionEntries(readTranscript(transcript, 0, null).records);
    expect(out.output!.length).toBe(MAX_OUTPUT);
    expect(out.more).toBeGreaterThan(1000);
  });

  it('titles common tools the way the terminal does', () => {
    expect(describeTool('Bash', { command: 'ls -la\nmore' }).summary).toBe('ls -la');
    expect(describeTool('Glob', { pattern: '**/*.ts', path: '/r/src' }, '/r').summary).toBe('**/*.ts in src');
    expect(describeTool('Agent', { description: 'Find usages', prompt: 'long' })).toEqual({
      summary: 'Find usages',
      detail: 'long',
    });
    expect(describeTool('Mystery', { thing: 'value' }).summary).toBe('value');
  });

  it('only accepts transcripts inside the Claude projects folder', () => {
    expect(isTranscriptPath(transcript, claude)).toBe(true);
    const outside = path.join(root, 'evil.jsonl');
    fs.writeFileSync(outside, '');
    expect(isTranscriptPath(outside, claude)).toBe(false);
    expect(isTranscriptPath(path.join(claude, 'projects', 'proj', '..', '..', 'x.jsonl'), claude)).toBe(false);
    expect(isTranscriptPath('/etc/passwd', claude)).toBe(false);
  });
});

describe('subagents', () => {
  /** A subagent as Claude Code writes it: its own transcript, and a meta naming the Agent call. */
  const subagent = (agent: string, toolUseId: string, body: string) => {
    const dir = subagentDir(transcript);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${agent}.meta.json`), JSON.stringify({ toolUseId, description: 'x' }));
    fs.writeFileSync(path.join(dir, `${agent}.jsonl`), body);
    return path.join(dir, `${agent}.jsonl`);
  };
  const prompt = line({ type: 'user', isSidechain: true, message: { content: 'You are working card #6' } });

  it('follows the subagents this run started and tags their steps with the Agent call', () => {
    fs.writeFileSync(transcript, call('old', 'Agent', { description: 'an earlier card' }));
    const from = fs.statSync(transcript).size;
    fs.appendFileSync(transcript, call('a1', 'Agent', { description: 'Review the code' }) + result('a1', 'launched'));
    subagent('agent-old', 'old', prompt + text('not this run', { isSidechain: true }));
    subagent('agent-x', 'a1', prompt + call('s1', 'Bash', { command: 'npm test' }, { isSidechain: true }) + result('s1', 'ok'));

    const entries = new SessionReader(transcript, from).read(null);
    const steps = entries.filter((e) => e.parent);
    expect(steps.map((e) => [e.kind, e.tool, e.parent])).toEqual([
      ['tool', 'Bash', 'a1'],
      ['result', 'Bash', 'a1'],
    ]);
    expect(steps.every((e) => e.subagent && e.id.startsWith('agent-x:'))).toBe(true);
    expect(entries.some((e) => e.text === 'not this run')).toBe(false);
  });

  it('reads only what is new on the next read, subagents included', () => {
    fs.appendFileSync(transcript, call('a1', 'Agent', { description: 'Review' }));
    const reader = new SessionReader(transcript, 0);
    expect(reader.read(null)).toHaveLength(1);
    const file = subagent('agent-x', 'a1', prompt + text('step one', { isSidechain: true }));
    expect(reader.read(null).map((e) => e.text)).toEqual(['step one']);
    fs.appendFileSync(file, text('step two', { isSidechain: true }));
    expect(reader.read(null).map((e) => e.text)).toEqual(['step two']);
    expect(reader.read(null)).toEqual([]);
  });

  it('follows a subagent started by a subagent', () => {
    fs.writeFileSync(transcript, call('a1', 'Agent', { description: 'outer' }));
    subagent('agent-outer', 'a1', prompt + call('a2', 'Agent', { description: 'inner' }, { isSidechain: true }));
    subagent('agent-inner', 'a2', prompt + text('deep work', { isSidechain: true }));
    const entries = new SessionReader(transcript, 0).read(null);
    expect(entries.find((e) => e.text === 'deep work')?.parent).toBe('a2');
    expect(entries.find((e) => e.toolId === 'a2')?.parent).toBe('a1');
  });

  it('keeps every step of a call that is still in view when trimming', () => {
    const e = (id: string, extra: object = {}) => ({ id, at, kind: 'text' as const, ...extra });
    const entries = [
      e('1'),
      { id: '2', at, kind: 'tool' as const, tool: 'Agent', toolId: 'a1' },
      e('s1', { parent: 'a1' }),
      e('s2', { parent: 'a1' }),
      e('3'),
    ];
    const { entries: kept, cut } = lastEntries(entries, 2);
    expect(cut).toBe(true);
    expect(kept.map((x) => x.id)).toEqual(['2', 's1', 's2', '3']);
  });

  it('saves the subagent steps with the run', () => {
    const store = Store.init(root);
    store.session = { id: 'abc', transcript };
    const card = store.create({ title: 'x', column: 'implement', agent: 'reviewer' });
    store.claimNext();
    fs.appendFileSync(transcript, call('a1', 'Agent', { description: 'Review' }));
    subagent('agent-x', 'a1', prompt + text('reviewed', { isSidechain: true }));
    const done = store.finish(card.id, 'ok');
    expect(store.savedSession(card.id, done.session!.run)!.entries.find((e) => e.text === 'reviewed')?.parent).toBe('a1');
  });
});

describe('session on the card', () => {
  it('records where the run starts on claim and closes the range when it ends', () => {
    fs.writeFileSync(transcript, text('before'));
    const store = Store.init(root);
    store.session = { id: 'abc', transcript };
    const card = store.create({ title: 'x', column: 'implement' });

    const claimed = store.claimNext()!;
    expect(claimed.session).toMatchObject({ id: 'abc', transcript, from: fs.statSync(transcript).size, to: null, saved: false });

    fs.appendFileSync(transcript, text('working'));
    const done = store.finish(card.id, 'ok');
    expect(done.session!.to).toBe(fs.statSync(transcript).size);
  });

  it('closes the range on plan, fail and a drag off the run, but not on a question', () => {
    const store = Store.init(root);
    store.session = { id: 'abc', transcript };
    const a = store.create({ title: 'a', column: 'plan' });
    store.claimNext();
    expect(store.savePlan(a.id, 'p').session!.to).not.toBeNull();

    const b = store.create({ title: 'b', column: 'implement' });
    store.claimNext();
    expect(store.ask(b.id, '?').task.session!.to).toBeNull();
    expect(store.fail(b.id, 'broke').session!.to).not.toBeNull();

    const c = store.create({ title: 'c', column: 'implement' });
    store.claimNext();
    expect(store.move(c.id, 'backlog').session!.to).not.toBeNull();
  });

  it('records nothing outside Claude Code and loads older cards without a session', () => {
    const store = Store.init(root);
    store.create({ title: 'x', column: 'implement' });
    expect(store.claimNext()!.session).toBeNull();
    expect(normalizeTask({ id: 't' }, 't').session).toBeNull();
    expect(normalizeTask({ id: 't', session: { id: 's', transcript: 'f', from: -1 } }, 't').session).toBeNull();
  });
});

describe('saved sessions', () => {
  it('saves each run when it ends, so it outlives the transcript', () => {
    const store = Store.init(root);
    store.session = { id: 'abc', transcript };
    const card = store.create({ title: 'x', column: 'plan' });
    store.claimNext();
    fs.appendFileSync(transcript, text('planning'));
    const planned = store.savePlan(card.id, 'p');

    expect(planned.session!.saved).toBe(true);
    fs.rmSync(transcript);
    const saved = store.savedSession(card.id, planned.session!.run)!;
    expect(saved.mode).toBe('plan');
    expect(saved.entries.map((e) => e.text)).toEqual(['planning']);
  });

  it('files the previous run under history on the next claim, newest last', () => {
    const store = Store.init(root);
    store.session = { id: 'abc', transcript };
    const card = store.create({ title: 'x', column: 'plan' });
    const first = store.claimNext()!.session!.run;
    fs.appendFileSync(transcript, text('run one'));
    const planned = store.savePlan(card.id, 'p');

    store.move(card.id, 'implement');
    const second = store.claimNext()!;
    // dated by when the run ended, not by the claim that retired it
    expect(second.sessionHistory[0].endedAt).toBe(store.savedSession(card.id, first)!.endedAt);
    expect(second.sessionHistory[0].endedAt <= planned.updatedAt).toBe(true);
    expect(second.session!.run).not.toBe(first);
    expect(second.sessionHistory).toEqual([expect.objectContaining({ run: first, mode: 'plan' })]);
    fs.appendFileSync(transcript, text('run two'));
    store.finish(card.id, 'ok');

    expect(store.savedSession(card.id, first)!.entries.map((e) => e.text)).toEqual(['run one']);
    expect(store.savedSession(card.id, second.session!.run)!.entries.map((e) => e.text)).toEqual(['run two']);
  });

  it('saves a run that never ended properly when the card is claimed again', () => {
    const store = Store.init(root);
    store.session = { id: 'abc', transcript };
    const card = store.create({ title: 'x', column: 'implement' });
    const crashed = store.claimNext()!.session!.run;
    fs.appendFileSync(transcript, text('then the worker died'));
    // the user sends the card back without the worker ever finishing it
    store.move(card.id, 'implement');
    const next = store.claimNext()!;
    expect(next.sessionHistory.map((h) => h.run)).toEqual([crashed]);
    expect(store.savedSession(card.id, crashed)!.entries).toHaveLength(1);
  });

  it('keeps at most MAX_SESSION_HISTORY runs and deletes the oldest copies', () => {
    const store = Store.init(root);
    store.session = { id: 'abc', transcript };
    const card = store.create({ title: 'x', column: 'implement' });
    const runs: string[] = [];
    for (let i = 0; i < MAX_SESSION_HISTORY + 2; i++) {
      runs.push(store.claimNext()!.session!.run);
      store.finish(card.id, `r${i}`);
      store.move(card.id, 'implement');
    }
    const last = store.claimNext()!;
    expect(last.sessionHistory).toHaveLength(MAX_SESSION_HISTORY);
    expect(last.sessionHistory[0].run).toBe(runs[2]);
    expect(store.savedSession(card.id, runs[0])).toBeNull();
    expect(store.savedSession(card.id, runs[2])).not.toBeNull();
  });

  it('never copies a transcript from outside the Claude home', () => {
    const store = Store.init(root);
    const outside = path.join(root, 'secret.jsonl');
    fs.writeFileSync(outside, '');
    store.session = { id: 'abc', transcript: outside };
    const card = store.create({ title: 'x', column: 'implement' });
    store.claimNext();
    fs.appendFileSync(outside, text('secret'));
    expect(store.finish(card.id, 'ok').session!.saved).toBe(false);
  });
});

describe('clearing and the keep setting', () => {
  const finishedRuns = (store: Store, n: number) => {
    const card = store.create({ title: 'x', column: 'implement' });
    for (let i = 0; i < n; i++) {
      store.claimNext();
      fs.appendFileSync(transcript, text(`run ${i}`));
      store.finish(card.id, 'ok');
      if (i < n - 1) store.move(card.id, 'implement');
    }
    return card;
  };

  it('clears the session, its history and the saved copies', () => {
    const store = Store.init(root);
    store.session = { id: 'abc', transcript };
    const card = finishedRuns(store, 2);
    expect(store.get(card.id)!.sessionHistory).toHaveLength(1);
    expect(fs.readdirSync(path.join(root, '.ticketrail', 'sessions', card.id))).toHaveLength(2);

    const cleared = store.clearSession(card.id);
    expect(cleared.session).toBeNull();
    expect(cleared.sessionHistory).toEqual([]);
    expect(cleared.activity.at(-1)!.text).toBe('Session cleared.');
    expect(fs.existsSync(path.join(root, '.ticketrail', 'sessions', card.id))).toBe(false);
    // the file on disk says so too
    const raw = JSON.parse(fs.readFileSync(path.join(root, '.ticketrail', 'tasks', `${card.id}.json`), 'utf8'));
    expect([raw.session, raw.sessionHistory]).toEqual([null, []]);
    // the transcript is Claude Code's and is left alone
    expect(fs.existsSync(transcript)).toBe(true);
  });

  it('refuses to clear a run that is still being written', () => {
    const store = Store.init(root);
    store.session = { id: 'abc', transcript };
    const card = store.create({ title: 'x', column: 'implement' });
    store.claimNext();
    expect(() => store.clearSession(card.id)).toThrow(/still working/);
  });

  it('saves nothing when session history is turned off, but still records the live run', () => {
    const store = Store.init(root);
    store.updateSettings({ keepSessions: false });
    store.session = { id: 'abc', transcript };
    const card = finishedRuns(store, 2);
    const task = store.get(card.id)!;
    expect(task.session).toMatchObject({ saved: false });
    expect(task.session!.to).not.toBeNull();
    expect(task.sessionHistory).toEqual([]);
    expect(fs.existsSync(path.join(root, '.ticketrail', 'sessions'))).toBe(false);
  });
});

describe('session over HTTP', () => {
  let home: string;
  let server: ServerHandle;
  let base: string;
  let store: Store;

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-home-'));
    process.env.TICKETRAIL_HOME = home;
    process.env.CLAUDE_CONFIG_DIR = claude;
    store = Store.init(root);
    addProject(root);
    server = await startServer(store, { port: 0 });
    base = `http://localhost:${server.port}/api/projects/${projectId(root)}`;
  });

  afterEach(async () => {
    await server.close();
    delete process.env.TICKETRAIL_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const claim = () => {
    const worker = new Store(root, { session: { id: 'abc', transcript } });
    worker.create({ title: 'x', column: 'implement' });
    return worker.claimNext()!;
  };

  it('serves the run so far', async () => {
    const task = claim();
    fs.appendFileSync(transcript, text('hello'));
    const res = await fetch(`${base}/tasks/${task.id}/session`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ recorded: true, live: true });
    expect(body.entries.map((e: any) => e.text)).toEqual(['hello']);
  });

  it('serves a finished run from its saved copy once the transcript is gone, and earlier runs by id', async () => {
    const task = claim();
    fs.appendFileSync(transcript, text('first run'));
    const worker = new Store(root, { session: { id: 'abc', transcript } });
    const first = worker.finish(task.id, 'ok').session!.run;
    worker.move(task.id, 'implement');
    worker.claimNext();
    fs.appendFileSync(transcript, text('second run'));
    worker.finish(task.id, 'ok again');
    fs.rmSync(transcript);

    const current = await (await fetch(`${base}/tasks/${task.id}/session`)).json();
    expect(current.entries.map((e: any) => e.text)).toEqual(['second run']);
    const past = await (await fetch(`${base}/tasks/${task.id}/sessions/${first}`)).json();
    expect(past.entries.map((e: any) => e.text)).toEqual(['first run']);
    expect((await fetch(`${base}/tasks/${task.id}/sessions/r_unknown`)).status).toBe(404);
    expect((await fetch(`${base}/tasks/${task.id}/sessions/..%2F..%2Fconfig`)).status).toBe(404);
  });

  it('clears a session and changes the keep setting', async () => {
    const task = claim();
    new Store(root).finish(task.id, 'ok');
    const del = await fetch(`${base}/tasks/${task.id}/session`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect((await del.json()).session).toBeNull();

    const patch = await fetch(`${base}/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keepSessions: false }),
    });
    expect((await patch.json()).keepSessions).toBe(false);
    expect((await (await fetch(`${base}/board`)).json()).keepSessions).toBe(false);
    expect(new Store(root).config().keepSessions).toBe(false);
  });

  it('answers 409 when clearing a live run', async () => {
    const task = claim();
    expect((await fetch(`${base}/tasks/${task.id}/session`, { method: 'DELETE' })).status).toBe(409);
  });

  it('refuses a transcript path outside the Claude home', async () => {
    const task = claim();
    const file = path.join(root, '.ticketrail', 'tasks', `${task.id}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...raw, session: { ...raw.session, transcript: '/etc/hosts.jsonl' } }));
    const res = await fetch(`${base}/tasks/${task.id}/session`);
    expect(res.status).toBe(403);
  });

  it('streams what the worker writes after the tab opened, then ends with the run', async () => {
    const task = claim();
    const controller = new AbortController();
    const res = await fetch(`${base}/tasks/${task.id}/session/events`, { signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';
    const until = async (needle: string) => {
      const deadline = Date.now() + 5000;
      while (!received.includes(needle)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${needle}:\n${received}`);
        const { value, done } = await reader.read();
        if (done) break;
        received += decoder.decode(value);
      }
    };

    await until('event: snapshot');
    fs.appendFileSync(transcript, text('streamed in'));
    await until('streamed in');
    expect(received).toContain('event: entries');

    new Store(root).finish(task.id, 'ok');
    await until('event: end');
    controller.abort();
  });
});
