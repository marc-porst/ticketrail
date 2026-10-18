import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findTranscript, modelFromTranscript, modelLabel, resolveModel } from '../src/core/model.ts';
import { Store } from '../src/core/store.ts';

let home: string;

/** A transcript as Claude Code writes it: one JSON record per line. */
function writeTranscript(sessionId: string, records: unknown[], project = 'a-project'): string {
  const dir = path.join(home, 'projects', project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

const assistant = (model: string, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  timestamp: new Date().toISOString(),
  message: { role: 'assistant', model, content: [] },
  ...extra,
});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-claude-'));
  process.env.CLAUDE_CONFIG_DIR = home;
  delete process.env.TICKETRAIL_MODEL;
  delete process.env.ANTHROPIC_MODEL;
  delete process.env.CLAUDE_CODE_SESSION_ID;
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.TICKETRAIL_MODEL;
  delete process.env.ANTHROPIC_MODEL;
  delete process.env.CLAUDE_CODE_SESSION_ID;
});

describe('finding the transcript', () => {
  it('locates it by session id whatever the project directory is called', () => {
    const file = writeTranscript('s1', [assistant('claude-opus-5')], 'some-odd-slug');
    expect(findTranscript('s1', home)).toBe(file);
  });

  it('returns null for an unknown session, an empty id or a missing home', () => {
    writeTranscript('s1', [assistant('claude-opus-5')]);
    expect(findTranscript('nope', home)).toBeNull();
    expect(findTranscript('', home)).toBeNull();
    expect(findTranscript('s1', path.join(home, 'does-not-exist'))).toBeNull();
  });
});

describe('reading the model', () => {
  it('takes the last assistant turn', () => {
    const file = writeTranscript('s1', [
      assistant('claude-sonnet-5'),
      { type: 'user', message: { role: 'user', content: 'hi' } },
      assistant('claude-opus-5'),
    ]);
    expect(modelFromTranscript(file)).toBe('claude-opus-5');
  });

  it('ignores subagent turns, which may run a different model', () => {
    const file = writeTranscript('s1', [
      assistant('claude-opus-5'),
      assistant('claude-haiku-4-5-20251001', { isSidechain: true }),
    ]);
    expect(modelFromTranscript(file)).toBe('claude-opus-5');
  });

  it('ignores the <synthetic> sentinel', () => {
    const file = writeTranscript('s1', [assistant('claude-opus-5'), assistant('<synthetic>')]);
    expect(modelFromTranscript(file)).toBe('claude-opus-5');
  });

  it('skips a half-written last line rather than throwing', () => {
    const file = writeTranscript('s1', [assistant('claude-opus-5')]);
    fs.appendFileSync(file, '{"type":"assistant","mess');
    expect(modelFromTranscript(file)).toBe('claude-opus-5');
  });

  it('reads only the tail, and still finds a model in a transcript far past it', () => {
    // Padding well beyond the 256 KB window, so the answer can only come from
    // the end of the file and the truncated first line must not break parsing.
    const filler = Array.from({ length: 400 }, () => ({
      type: 'user',
      message: { role: 'user', content: 'x'.repeat(1000) },
    }));
    const file = writeTranscript('s1', [assistant('claude-sonnet-5'), ...filler, assistant('claude-opus-5')]);
    expect(fs.statSync(file).size).toBeGreaterThan(256 * 1024);
    expect(modelFromTranscript(file)).toBe('claude-opus-5');
  });

  it('returns null for a transcript with no assistant turn, or no file at all', () => {
    const file = writeTranscript('s1', [{ type: 'user', message: { role: 'user', content: 'hi' } }]);
    expect(modelFromTranscript(file)).toBeNull();
    expect(modelFromTranscript(path.join(home, 'nothing.jsonl'))).toBeNull();
  });
});

describe('resolveModel', () => {
  it('prefers an explicit answer over everything else', () => {
    writeTranscript('s1', [assistant('claude-opus-5')]);
    process.env.CLAUDE_CODE_SESSION_ID = 's1';
    process.env.TICKETRAIL_MODEL = 'from-env';
    expect(resolveModel('from-flag')).toBe('from-flag');
    expect(resolveModel()).toBe('from-env');
  });

  it('prefers the transcript over ANTHROPIC_MODEL, which may be an alias', () => {
    writeTranscript('s1', [assistant('claude-opus-5')]);
    process.env.CLAUDE_CODE_SESSION_ID = 's1';
    process.env.ANTHROPIC_MODEL = 'opus';
    expect(resolveModel()).toBe('claude-opus-5');
  });

  it('falls back to ANTHROPIC_MODEL when there is no transcript', () => {
    process.env.ANTHROPIC_MODEL = 'opus';
    expect(resolveModel()).toBe('opus');
  });

  it('is null outside Claude Code, so nothing is recorded', () => {
    expect(resolveModel()).toBeNull();
  });
});

describe('modelLabel', () => {
  it('reads the family and version out of an id', () => {
    expect(modelLabel('claude-opus-5')).toBe('Opus 5');
    expect(modelLabel('claude-sonnet-5')).toBe('Sonnet 5');
    expect(modelLabel('claude-fable-5-1')).toBe('Fable 5.1');
  });

  it('drops a snapshot date and a context-window suffix', () => {
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(modelLabel('claude-sonnet-5[1m]')).toBe('Sonnet 5');
  });

  it('shows anything it does not recognise exactly as it is', () => {
    expect(modelLabel('gpt-4o')).toBe('gpt-4o');
    expect(modelLabel('claude-something-odd')).toBe('claude-something-odd');
  });
});

describe('recording the model on a card', () => {
  let root: string;

  const boardOn = (model: string | null) => new Store(root, { model });
  const statuses = (id: string) => boardOn(null).get(id)!.activity.filter((a) => a.kind === 'status');

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-model-board-'));
    Store.init(root);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('stamps the status changes Claude makes', () => {
    const opus = boardOn('claude-opus-5');
    const task = opus.create({ title: 'work' });
    opus.move(task.id, 'plan');
    opus.claimNext();
    opus.savePlan(task.id, '# Plan');

    const stamped = statuses(task.id).filter((a) => a.model);
    expect(stamped.map((a) => a.text)).toEqual(['Claude started planning.', 'Plan ready for review.']);
    expect(stamped.every((a) => a.model === 'claude-opus-5')).toBe(true);
    expect(boardOn(null).get(task.id)!.model).toBe('claude-opus-5');
  });

  it('leaves the moves you make yourself unattributed', () => {
    const opus = boardOn('claude-opus-5');
    const task = opus.create({ title: 'work' });
    // A move through patch() is what the browser does, and the server has no model.
    const moved = new Store(root).move(task.id, 'plan');
    expect(moved.activity.at(-1)!.text).toBe('Moved to Plan.');
    expect(moved.activity.at(-1)!.model).toBeUndefined();
  });

  it('notes a model change between planning and implementing', () => {
    const opus = boardOn('claude-opus-5');
    const task = opus.create({ title: 'work' });
    opus.move(task.id, 'plan');
    opus.claimNext();
    opus.savePlan(task.id, '# Plan');

    const sonnet = boardOn('claude-sonnet-5');
    sonnet.move(task.id, 'implement');
    sonnet.claimNext();

    const notice = statuses(task.id).find((a) => a.text.startsWith('Model changed'));
    expect(notice?.text).toBe('Model changed since the last run: Opus 5 → Sonnet 5.');
    expect(notice?.model).toBe('claude-sonnet-5');
    expect(boardOn(null).get(task.id)!.model).toBe('claude-sonnet-5');
  });

  it('says nothing when the model has not changed', () => {
    const opus = boardOn('claude-opus-5');
    const task = opus.create({ title: 'work' });
    opus.move(task.id, 'plan');
    opus.claimNext();
    opus.savePlan(task.id, '# Plan');
    opus.move(task.id, 'implement');
    opus.claimNext();

    expect(statuses(task.id).some((a) => a.text.startsWith('Model changed'))).toBe(false);
  });

  it('records nothing at all when no model is known', () => {
    const plain = boardOn(null);
    const task = plain.create({ title: 'work' });
    plain.move(task.id, 'implement');
    plain.claimNext();
    plain.finish(task.id, 'shipped');

    expect(statuses(task.id).every((a) => a.model === undefined)).toBe(true);
    expect(boardOn(null).get(task.id)!.model).toBeNull();
  });

  it('does not announce a change when the earlier run had no model', () => {
    const plain = boardOn(null);
    const task = plain.create({ title: 'work' });
    plain.move(task.id, 'plan');
    plain.claimNext();
    plain.savePlan(task.id, '# Plan');

    const opus = boardOn('claude-opus-5');
    opus.move(task.id, 'implement');
    opus.claimNext();

    expect(statuses(task.id).some((a) => a.text.startsWith('Model changed'))).toBe(false);
    expect(boardOn(null).get(task.id)!.model).toBe('claude-opus-5');
  });
});
