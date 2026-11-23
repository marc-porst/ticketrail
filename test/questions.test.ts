import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/core/store.ts';
import { needsUser, normalizeTask, pendingQuestion } from '../src/core/task.ts';
import { parseOptions } from '../src/cli/commands/work.ts';
import { runHook, waitKind } from '../src/cli/commands/hook.ts';
import { HOOKS_FILE, cliCommand, ensureHooks, hookCli, installHooks, nodeCommand } from '../src/core/board-init.ts';

let root: string;
let store: Store;
let transcript: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-questions-'));
  store = Store.init(root);
  transcript = path.join(root, 'session.jsonl');
  fs.writeFileSync(transcript, '{}\n');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A card in In Progress, claimed by the Claude Code session `sid`. */
function claimed(sid = 'sess-1') {
  store.session = { id: sid, transcript };
  store.create({ title: 'Pick a database', column: 'implement' });
  const card = store.claimNext()!;
  store.session = null;
  return card;
}

/** Answer whatever the card is waiting on as soon as it is waiting. */
function answerWhenAsked(id: string, answer: (s: Store) => void) {
  const timer = setInterval(() => {
    const task = store.get(id);
    if (task && pendingQuestion(task)) {
      clearInterval(timer);
      answer(store);
    }
  }, 20);
  return () => clearInterval(timer);
}

describe('questions with options', () => {
  it('stores the options and keeps only real choices in the answer', () => {
    const card = claimed();
    const { message } = store.ask(card.id, 'Which database?', {
      options: ['Postgres', { label: 'SQLite', description: 'One file' }, 'Postgres', ''],
      header: 'Database',
    });
    expect(message.options).toEqual([{ label: 'Postgres' }, { label: 'SQLite', description: 'One file' }]);
    expect(store.get(card.id)!.column).toBe('user-input');

    const { task, message: reply } = store.message(card.id, 'SQLite', 'user', {
      answers: message.id,
      choices: ['SQLite', 'MongoDB'],
    });
    expect(reply.choices).toEqual(['SQLite']);
    expect(task.column).toBe('in-progress');
    expect(task.messages.find((m) => m.id === message.id)!.answeredBy).toBe(reply.id);
  });

  it('refuses an answer to a question that is already answered', () => {
    const card = claimed();
    const { message } = store.ask(card.id, 'Yes or no?', { options: ['Yes', 'No'] });
    store.message(card.id, 'Yes', 'user', { answers: message.id, choices: ['Yes'] });
    expect(() => store.message(card.id, 'No', 'user', { answers: message.id })).toThrow(/not open/);
  });

  it('waits for every question asked together, in the order they were asked', () => {
    const card = claimed();
    const { messages } = store.askAll(card.id, [
      { text: 'First?', options: ['a', 'b'] },
      { text: 'Second?', options: ['c', 'd'] },
    ]);
    expect(pendingQuestion(store.get(card.id)!)!.id).toBe(messages[0].id);

    const after = store.message(card.id, 'a', 'user').task; // free text answers the first open one
    expect(after.column).toBe('user-input');
    expect(pendingQuestion(after)!.id).toBe(messages[1].id);

    expect(store.message(card.id, 'd', 'user', { answers: messages[1].id }).task.column).toBe('in-progress');
  });

  it('reads --option values with an optional description', () => {
    expect(parseOptions(['Postgres', 'SQLite|One file, no server', 'Mongo|'])).toEqual([
      { label: 'Postgres' },
      { label: 'SQLite', description: 'One file, no server' },
      { label: 'Mongo' },
    ]);
  });

  it('loads old task files and drops broken options', () => {
    const task = normalizeTask(
      { id: 't1', messages: [{ id: 'm1', role: 'claude', text: 'q', needsAnswer: true, options: [{ nope: 1 }, 'ok'] }] },
      't1',
    );
    expect(task.messages[0].options).toEqual([{ label: 'ok' }]);
    expect(task.waiting).toBeNull();
  });
});

describe('waiting in the terminal', () => {
  it('moves the card to User Input and back once the session moves again', () => {
    const card = claimed('s1');
    store.markWaiting(card.id, { kind: 'permission', text: 'Claude needs your permission to use Bash' });
    const held = store.get(card.id)!;
    expect(held.column).toBe('user-input');
    expect(held.waiting).toMatchObject({ kind: 'permission' });
    expect(needsUser(held)).toBe(true);

    // a note from the board cannot release it: Claude is not listening there
    expect(store.message(card.id, 'hello', 'user').task.column).toBe('user-input');

    store.resume('s1');
    const back = store.get(card.id)!;
    expect(back.column).toBe('in-progress');
    expect(back.waiting).toBeNull();
  });

  it('forgets the wait when the user moves the card away', () => {
    const card = claimed('s1');
    store.markWaiting(card.id, { kind: 'idle', text: 'waiting' });
    store.move(card.id, 'backlog');
    expect(store.get(card.id)!.waiting).toBeNull();
  });

  it('tells waits apart from other notifications', () => {
    expect(waitKind({ notification_type: 'permission_prompt' })).toBe('permission');
    expect(waitKind({ notification_type: 'idle_prompt' })).toBe('idle');
    expect(waitKind({ notification_type: 'auth_success' })).toBeNull();
    expect(waitKind({ message: 'Claude needs your permission to use Bash' })).toBe('permission');
    expect(waitKind({ message: 'Claude is waiting for your input' })).toBe('idle');
    expect(waitKind({ message: 'Something else' })).toBeNull();
  });
});

describe('hooks', () => {
  const askInput = {
    questions: [
      {
        question: 'Which database?',
        header: 'Database',
        multiSelect: false,
        options: [
          { label: 'Postgres', description: 'Server' },
          { label: 'SQLite', description: 'One file' },
        ],
      },
    ],
  };

  it('asks AskUserQuestion on the card and hands the answer back to Claude', async () => {
    const card = claimed('s1');
    const stop = answerWhenAsked(card.id, (s) => {
      const q = pendingQuestion(s.get(card.id)!)!;
      expect(q).toMatchObject({ source: 'terminal', header: 'Database' });
      s.message(card.id, 'SQLite', 'user', { answers: q.id, choices: ['SQLite'] });
    });
    const out = await runHook(store, 'pre-tool', { session_id: 's1', tool_name: 'AskUserQuestion', tool_input: askInput }, { timeoutMs: 5000 });
    stop();
    expect(out!.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out!.hookSpecificOutput.permissionDecisionReason).toContain('"Which database?" → SQLite');
    expect(store.get(card.id)!.column).toBe('in-progress');
  });

  it('tells Claude to move on when nobody answers', async () => {
    const card = claimed('s1');
    const out = await runHook(store, 'pre-tool', { session_id: 's1', tool_name: 'AskUserQuestion', tool_input: askInput }, { timeoutMs: 300 });
    expect(out!.hookSpecificOutput.permissionDecisionReason).toMatch(/Nobody answered/);
    expect(store.get(card.id)!.column).toBe('user-input');
  });

  it('stops waiting when the user pulls the card away', async () => {
    const card = claimed('s1');
    const stop = answerWhenAsked(card.id, (s) => s.move(card.id, 'backlog'));
    const out = await runHook(store, 'pre-tool', { session_id: 's1', tool_name: 'AskUserQuestion', tool_input: askInput }, { timeoutMs: 5000 });
    stop();
    expect(out!.hookSpecificOutput.permissionDecisionReason).toMatch(/moved card #\d+ away/);
  });

  it('leaves sessions without a card alone', async () => {
    claimed('s1');
    expect(await runHook(store, 'pre-tool', { session_id: 'other', tool_name: 'AskUserQuestion', tool_input: askInput })).toBeNull();
    expect(await runHook(store, 'pre-tool', { tool_name: 'AskUserQuestion', tool_input: askInput })).toBeNull();
    expect(await runHook(store, 'notify', { session_id: 'other', notification_type: 'permission_prompt' })).toBeNull();
  });

  it('lets the user approve leaving plan mode on the card', async () => {
    const card = claimed('s1');
    const stop = answerWhenAsked(card.id, (s) => {
      const q = pendingQuestion(s.get(card.id)!)!;
      expect(q.text).toContain('1. Do the thing');
      s.message(card.id, 'Approve', 'user', { answers: q.id, choices: ['Approve'] });
    });
    const out = await runHook(store, 'pre-tool', { session_id: 's1', tool_name: 'ExitPlanMode', tool_input: { plan: '1. Do the thing' } }, { timeoutMs: 5000 });
    stop();
    expect(out!.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('marks a permission prompt and clears it on resume', async () => {
    const card = claimed('s1');
    await runHook(store, 'notify', { session_id: 's1', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
    expect(store.get(card.id)!.waiting).toMatchObject({ kind: 'permission', text: 'Claude needs your permission to use Bash' });
    await runHook(store, 'resume', { session_id: 's1' });
    expect(store.get(card.id)!.column).toBe('in-progress');
  });

  it('does not mark a card whose question is already on the board', async () => {
    const card = claimed('s1');
    store.ask(card.id, 'Board question?');
    await runHook(store, 'notify', { session_id: 's1', notification_type: 'idle_prompt' });
    expect(store.get(card.id)!.waiting).toBeNull();
  });
});

describe('installing the hooks', () => {
  const file = () => path.join(root, HOOKS_FILE);
  const read = () => JSON.parse(fs.readFileSync(file(), 'utf8'));

  it('merges into existing settings and is idempotent', () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(
      file(),
      JSON.stringify({
        permissions: { allow: ['Bash(ls)'] },
        hooks: {
          PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'prettier --write' }] }],
          // written by an older checkout somewhere else
          Notification: [{ hooks: [{ type: 'command', command: 'node /old/place/dist/cli.js hook notify' }] }],
        },
      }),
    );
    expect(installHooks(root, 'node /new/dist/cli.js')).toBe('installed');
    const settings = read();
    expect(settings.permissions).toEqual({ allow: ['Bash(ls)'] });
    expect(settings.hooks.PostToolUse.map((g: any) => g.hooks[0].command)).toEqual([
      'prettier --write',
      'node /new/dist/cli.js hook resume',
    ]);
    expect(settings.hooks.Notification).toEqual([{ hooks: [{ type: 'command', command: 'node /new/dist/cli.js hook notify' }] }]);
    expect(settings.hooks.PreToolUse[0]).toMatchObject({ matcher: 'AskUserQuestion|ExitPlanMode' });
    expect(settings.hooks.PreToolUse[0].hooks[0].timeout).toBeGreaterThanOrEqual(3600);

    expect(installHooks(root, 'node /new/dist/cli.js')).toBe('unchanged');
  });

  it('points the hooks at the built CLI by its absolute path, quoted when needed', () => {
    const cli = hookCli()!;
    const file = cli.replace(/^node /, '').replace(/^"(.*)"$/, '$1');
    expect(path.isAbsolute(file) && fs.existsSync(file)).toBe(true);
    expect(nodeCommand('/my projects/dist/cli.js')).toBe('node "/my projects/dist/cli.js"');
    expect(nodeCommand('/plain/dist/cli.js')).toBe('node /plain/dist/cli.js');
  });

  it('leaves a settings file it cannot read alone', () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), '{ not json');
    expect(installHooks(root, 'npx ticketrail')).toBe('skipped');
    expect(fs.readFileSync(file(), 'utf8')).toBe('{ not json');
  });
});

describe('a session that moved on', () => {
  it('acts on the card it works now, not the one left waiting on a question', async () => {
    store.session = { id: 's1', transcript };
    store.create({ title: 'first', column: 'implement' });
    const first = store.claimNext()!;
    store.ask(first.id, 'Nobody answers this'); // the wait times out, the worker moves on
    store.create({ title: 'second', column: 'implement' });
    const second = store.claimNext()!;
    store.session = null;

    expect(store.cardOfSession('s1')!.id).toBe(second.id);
    await runHook(store, 'notify', { session_id: 's1', notification_type: 'permission_prompt' });
    expect(store.get(second.id)!.waiting).toMatchObject({ kind: 'permission' });
    expect(store.cardOfSession('s1')!.id).toBe(second.id); // held for the terminal still counts as current
  });
});

describe('the command the skill files use', () => {
  it('fits how Ticketrail is installed', () => {
    const project = '/work/app';
    expect(cliCommand(project, '/work/app/node_modules/ticketrail/dist/cli.js')).toBe('npx ticketrail');
    expect(cliCommand(project, '/usr/local/lib/node_modules/ticketrail/dist/cli.js')).toBe('ticketrail');
    expect(cliCommand(project, '/src/ticketrail/dist/cli.js')).toBe('node /src/ticketrail/dist/cli.js');
    expect(cliCommand(project, null)).toBe('npx ticketrail');
  });
});

describe('installing the hooks from a worker', () => {
  const saved = process.env.CLAUDE_CODE_SESSION_ID;
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = saved;
  });

  /** A linked worktree of `main`, laid out the way git writes one. */
  function worktreeOf(main: string): string {
    const gitdir = path.join(main, '.git', 'worktrees', 'wt');
    fs.mkdirSync(gitdir, { recursive: true });
    fs.writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
    fs.writeFileSync(path.join(gitdir, 'HEAD'), 'ref: refs/heads/feature\n');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-wt-'));
    fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${gitdir}\n`);
    return dir;
  }

  it('installs into the worktree the worker runs in, once', () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'sid';
    const wt = worktreeOf(root);
    try {
      expect(ensureHooks(store, wt)).toBe(path.join(wt, HOOKS_FILE));
      expect(JSON.parse(fs.readFileSync(path.join(wt, HOOKS_FILE), 'utf8')).hooks.PreToolUse).toHaveLength(1);
      expect(ensureHooks(store, wt)).toBeNull(); // already there
      expect(fs.existsSync(path.join(root, HOOKS_FILE))).toBe(false);
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });

  it('installs into the board itself outside a worktree', () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'sid';
    expect(ensureHooks(store, root)).toBe(path.join(root, HOOKS_FILE));
  });

  it('does nothing outside Claude Code, or when the board turned hooks off', () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    expect(ensureHooks(store, root)).toBeNull();
    process.env.CLAUDE_CODE_SESSION_ID = 'sid';
    store.saveConfig({ ...store.config(), hooks: false });
    expect(ensureHooks(store, root)).toBeNull();
    expect(fs.existsSync(path.join(root, HOOKS_FILE))).toBe(false);
  });
});
