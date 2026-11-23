import { createHash } from 'node:crypto';
import { Store } from '../../core/store.ts';
import { findRoot } from '../../core/paths.ts';
import { waitFor } from '../../core/watch.ts';
import { startHeartbeat, touchWorker } from '../../core/presence.ts';
import { COLUMN_LABELS, type Message, type Task, type TerminalWait } from '../../core/task.ts';
import { flagNumber, type Args } from '../args.ts';

/**
 * Claude Code hooks, installed into .claude/settings.local.json by `init`.
 * They make what Claude does in its terminal visible on the board:
 *
 *   pre-tool    PreToolUse on AskUserQuestion / ExitPlanMode. The question goes
 *               to the card, and the hook hands the user's answer back to Claude.
 *   permission  PermissionRequest. The permission prompt goes to the card as
 *               Allow / Deny. A Deny on the board keeps Claude going (a "No"
 *               in the terminal stops its turn, and with it the worker).
 *   notify      Notification. Claude is waiting in the terminal (an idle turn,
 *               a prompt the board did not get): the card moves to User Input.
 *   resume      PostToolUse / UserPromptSubmit. The session moved again: a card
 *               held for the terminal goes back to In Progress, and a question
 *               the terminal answered first comes off the card.
 *
 * The terminal can still answer while a hook waits on the board; whichever
 * answers first wins, and the other side lets go. A hook only touches the
 * card the session is working, and any failure leaves Claude Code alone.
 */
export const HOOK_EVENTS = ['pre-tool', 'permission', 'notify', 'resume'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** The fields Claude Code sends on stdin that the hooks use. */
export interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: any;
  message?: string;
  notification_type?: string;
}

/** What the PreToolUse hook prints: Claude Code reads the decision and shows Claude the reason. */
export interface PreToolOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason: string;
    updatedInput?: Record<string, unknown>;
  };
}

/** What the PermissionRequest hook prints. Without it, Claude Code asks in the terminal as usual. */
export interface PermissionOutput {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest';
    decision: { behavior: 'allow' } | { behavior: 'deny'; message: string; interrupt: false };
  };
}

export type HookOutput = PreToolOutput | PermissionOutput;

/** The hook's own timeout in settings; the wait for an answer stops a minute short of it. */
export const HOOK_TIMEOUT_S = 3600;
const DEFAULT_WAIT_S = HOOK_TIMEOUT_S - 60;

const APPROVE = 'Approve';
const KEEP_PLANNING = 'Keep planning';
const ALLOW = 'Allow';
const DENY = 'Deny';

function decide(
  permissionDecision: 'allow' | 'deny',
  permissionDecisionReason: string,
  updatedInput?: Record<string, unknown>,
): PreToolOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision,
      permissionDecisionReason,
      ...(updatedInput ? { updatedInput } : {}),
    },
  };
}

/**
 * Which tool call a question stands for, so PostToolUse can tell the terminal
 * answered it. AskUserQuestion and ExitPlanMode come back with their input
 * changed (answers, plan), and only one of them runs at a time: the name is enough.
 */
export function toolKey(name: string | undefined, input: unknown): string {
  if (!name) return '';
  if (name === 'AskUserQuestion' || name === 'ExitPlanMode') return name;
  return createHash('sha1').update(`${name}\0${JSON.stringify(input ?? null)}`).digest('hex').slice(0, 16);
}

type Outcome =
  | { status: 'answered'; task: Task; answers: { question: Message; answer: Message }[] }
  | { status: 'withdrawn' | 'cancelled' | 'timeout'; task: Task | null };

/**
 * Block until every question is answered, the user pulls the card away, the
 * terminal answers first (the questions are withdrawn), or time runs out.
 * If Claude Code gives up on the hook (it ends or kills it), the questions
 * come off the card, so no button is left that nothing listens to.
 */
async function awaitAnswers(store: Store, taskId: string, asked: Message[], timeoutMs: number): Promise<Outcome> {
  const ids = asked.map((m) => m.id);
  const probe = (): Outcome | null => {
    const task = store.get(taskId);
    if (!task) return { status: 'cancelled', task: null };
    const questions = ids.map((id) => task.messages.find((m) => m.id === id));
    if (questions.some((q) => !q || q.withdrawn)) return { status: 'withdrawn', task };
    const answers = questions.map((q) => (q?.answeredBy ? task.messages.find((m) => m.id === q.answeredBy) : undefined));
    if (questions.every((q, i) => q && answers[i])) {
      return { status: 'answered', task, answers: questions.map((q, i) => ({ question: q!, answer: answers[i]! })) };
    }
    if (task.column !== 'user-input') return { status: 'cancelled', task };
    return null;
  };

  const letGo = () => {
    try {
      store.withdraw(taskId, ids);
    } catch {
      // the card is gone: nothing to clean up
    }
  };
  const onSignal = () => {
    letGo();
    process.exit(0);
  };
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
  for (const s of signals) process.on(s, onSignal);
  // Claude Code may drop the hook without a signal: then this process is reparented
  const parent = process.ppid;
  const orphaned = setInterval(() => {
    if (process.ppid !== parent) onSignal();
  }, 2000);
  orphaned.unref();

  touchWorker(store);
  const stop = startHeartbeat(store);
  try {
    const outcome = (await waitFor(store, probe, timeoutMs)) ?? { status: 'timeout' as const, task: store.get(taskId) };
    if (outcome.status === 'timeout') letGo();
    return outcome;
  } finally {
    clearInterval(orphaned);
    for (const s of signals) process.off(s, onSignal);
    stop();
    touchWorker(store);
  }
}

/** "45 minutes", "30 seconds". */
function duration(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes >= 1) return `${minutes} minute${minutes > 1 ? 's' : ''}`;
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `${seconds} second${seconds > 1 ? 's' : ''}`;
}

/** Answered on the card: null. Settled in the terminal or timed out: nothing to say, the terminal asks as usual. */
function notAnswered(outcome: Exclude<Outcome, { status: 'answered' }>, card: Task): PreToolOutput | null {
  if (outcome.status !== 'cancelled') return null;
  const where = outcome.task ? `it is now in ${COLUMN_LABELS[outcome.task.column]}` : 'it was deleted';
  return decide(
    'deny',
    `The user did not answer on the Ticketrail board: they moved card #${card.number} away from User Input (${where}). ` +
      `Do not ask again. Run \`ticketrail check ${card.id}\` and do what it says.`,
  );
}

function answerText(answer: Message): string {
  return answer.choices?.length ? answer.choices.join(', ') : answer.text;
}

function from(input: HookInput, pid = process.pid) {
  return { source: 'terminal' as const, tool: toolKey(input.tool_name, input.tool_input), pid };
}

/** AskUserQuestion: ask on the card, wait, and answer the tool with what the user picked there. */
async function askOnBoard(store: Store, card: Task, input: HookInput, timeoutMs: number): Promise<PreToolOutput | null> {
  const raw = Array.isArray(input.tool_input?.questions) ? input.tool_input.questions : [];
  const questions = raw
    .filter((q: any) => typeof q?.question === 'string' && q.question.trim())
    .map((q: any) => ({
      key: q.question as string,
      text: q.question.trim(),
      header: typeof q.header === 'string' ? q.header : undefined,
      options: Array.isArray(q.options) ? q.options : [],
      multiSelect: q.multiSelect === true,
    }));
  if (!questions.length) return null;

  const { messages } = store.askAll(card.id, questions, from(input));
  const outcome = await awaitAnswers(store, card.id, messages, timeoutMs);
  if (outcome.status !== 'answered') return notAnswered(outcome, card);

  // Claude Code takes the answers as the tool's result: question text → label(s), comma-joined
  const answers: Record<string, string> = {};
  outcome.answers.forEach(({ answer }, i) => (answers[questions[i].key] = answerText(answer)));
  return decide('allow', `Answered on the Ticketrail board (card #${card.number}).`, { ...input.tool_input, answers });
}

/** ExitPlanMode: the user approves leaving plan mode on the card, not in the terminal. */
async function approvePlanOnBoard(store: Store, card: Task, input: HookInput, timeoutMs: number): Promise<PreToolOutput | null> {
  const plan = typeof input.tool_input?.plan === 'string' ? input.tool_input.plan.trim() : '';
  const { messages } = store.askAll(
    card.id,
    [
      {
        text: `Claude wants to leave plan mode and start working${plan ? ' on this plan:\n\n' + plan : '.'}`,
        header: 'Plan mode',
        options: [
          { label: APPROVE, description: 'Leave plan mode and start' },
          { label: KEEP_PLANNING, description: 'Stay in plan mode; write what to change' },
        ],
      },
    ],
    from(input),
  );
  const outcome = await awaitAnswers(store, card.id, messages, timeoutMs);
  if (outcome.status !== 'answered') return notAnswered(outcome, card);
  const answer = outcome.answers[0].answer;
  const approved = answer.choices?.includes(APPROVE) || answer.text.trim().toLowerCase() === APPROVE.toLowerCase();
  if (approved) {
    return decide('allow', `The user approved the plan on the Ticketrail board (card #${card.number}).`, input.tool_input ?? {});
  }
  return decide(
    'deny',
    `The user did not approve leaving plan mode on the Ticketrail board (card #${card.number}). Their answer: ${answerText(answer)}`,
  );
}

/** One line on what Claude wants to do, for the permission question. */
export function describeTool(name: string, input: any): string {
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const command = s(input?.command);
  if (command) {
    const why = s(input?.description);
    return `${why ? why + '\n\n' : ''}\`${command.length > 600 ? command.slice(0, 600) + '…' : command}\``;
  }
  const file = s(input?.file_path) || s(input?.notebook_path) || s(input?.path);
  if (file) return `${name} ${file}`;
  const url = s(input?.url);
  if (url) return `${name} ${url}`;
  const json = JSON.stringify(input ?? {});
  return json && json !== '{}' ? `${name} ${json.length > 300 ? json.slice(0, 300) + '…' : json}` : name;
}

function permit(decision: PermissionOutput['hookSpecificOutput']['decision']): PermissionOutput {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

/**
 * A permission prompt: Allow / Deny on the card. A deny tells Claude to carry
 * on without it, so the worker keeps going. Nothing printed (timeout, the
 * terminal answered, card moved away) leaves the terminal prompt as it is.
 */
async function permissionOnBoard(store: Store, card: Task, input: HookInput, timeoutMs: number): Promise<PermissionOutput | null> {
  const name = input.tool_name ?? 'a tool';
  const { messages } = store.askAll(
    card.id,
    [
      {
        text: `Claude wants to use ${name}:\n\n${describeTool(name, input.tool_input)}`,
        header: 'Permission',
        options: [
          { label: ALLOW, description: 'Let Claude do this once' },
          { label: DENY, description: 'Claude skips it and carries on; write why to steer it' },
        ],
      },
    ],
    from(input),
  );
  const outcome = await awaitAnswers(store, card.id, messages, timeoutMs);
  if (outcome.status !== 'answered') return null;
  const answer = outcome.answers[0].answer;
  const said = answer.text.trim();
  if (answer.choices?.includes(ALLOW) || said.toLowerCase() === ALLOW.toLowerCase()) return permit({ behavior: 'allow' });
  const reason = answer.choices?.includes(DENY) || said.toLowerCase() === DENY.toLowerCase() ? '' : said;
  return permit({
    behavior: 'deny',
    interrupt: false,
    message:
      `The user denied this on the Ticketrail board (card #${card.number}).` +
      (reason ? ` They said: ${reason}` : '') +
      ' Do not try the same thing again. Carry on without it, or ask on the card with `ticketrail ask` if you are stuck.',
  });
}

/** What a Notification says about why Claude stopped, or null when it is not waiting on anyone. */
export function waitKind(input: HookInput): TerminalWait['kind'] | null {
  switch (input.notification_type) {
    case 'permission_prompt':
      return 'permission';
    case 'idle_prompt':
      return 'idle';
    case 'elicitation_dialog':
      return 'other';
    case undefined:
    case '':
      break;
    default:
      return null; // e.g. auth_success: nothing to wait for
  }
  const text = input.message ?? '';
  if (/permission/i.test(text)) return 'permission';
  if (/waiting for your input/i.test(text)) return 'idle';
  return null;
}

const WAIT_TEXT: Record<TerminalWait['kind'], string> = {
  permission: 'Claude needs your permission in the terminal.',
  idle: 'Claude stopped and is waiting for you in the terminal. Type there to carry on.',
  other: 'Claude is waiting for you in the terminal.',
};

/**
 * Run one hook against the board at `root`. Returns what to print to Claude
 * Code, or null to print nothing and let it carry on as it would anyway.
 */
export async function runHook(
  store: Store,
  event: HookEvent,
  input: HookInput,
  options: { timeoutMs?: number } = {},
): Promise<HookOutput | null> {
  const sessionId = input.session_id ?? '';
  if (!sessionId) return null;

  if (event === 'resume') {
    // a tool ran: a question the terminal answered for it is settled. A new prompt: everything is.
    store.resume(
      sessionId,
      input.hook_event_name === 'UserPromptSubmit' ? 'all' : { tool: toolKey(input.tool_name, input.tool_input) },
    );
    return null;
  }

  const card = store.cardOfSession(sessionId);
  if (!card) return null;

  if (event === 'notify') {
    const kind = waitKind(input);
    // Claude sits at its prompt: a question whose hook is gone cannot be answered from the board
    if (kind === 'idle') store.resume(sessionId, 'orphaned');
    const now = store.get(card.id) ?? card;
    // a question on the card is already what the user sees; a hook is waiting for it
    if (kind && !(now.column === 'user-input' && !now.waiting)) {
      store.markWaiting(card.id, { kind, text: input.message?.trim() || WAIT_TEXT[kind] });
    }
    return null;
  }

  // pre-tool, permission: the session is clearly moving, whatever else happens
  store.resume(sessionId);
  const fresh = store.get(card.id);
  if (!fresh || fresh.column !== 'in-progress') return null;
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_S * 1000;
  if (event === 'permission') {
    // these two have their own hook (pre-tool) when they reach a prompt at all
    if (input.tool_name === 'AskUserQuestion' || input.tool_name === 'ExitPlanMode') return null;
    return permissionOnBoard(store, fresh, input, timeoutMs);
  }
  if (input.tool_name === 'AskUserQuestion') return askOnBoard(store, fresh, input, timeoutMs);
  if (input.tool_name === 'ExitPlanMode') return approvePlanOnBoard(store, fresh, input, timeoutMs);
  return null;
}

function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
  });
}

/**
 * `ticketrail hook <event>`. Never fails Claude Code: no board, bad input or
 * an error all end quietly with exit code 0, so the terminal works as before.
 */
export async function hookCommand(args: Args, positional: string[]): Promise<void> {
  const event = positional[0] as HookEvent;
  if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
    process.stderr.write(`Usage: ticketrail hook <${HOOK_EVENTS.join('|')}>  (reads the Claude Code hook JSON on stdin)\n`);
    return;
  }
  try {
    let input: HookInput = {};
    try {
      input = JSON.parse((await readStdin()) || '{}');
    } catch {
      return;
    }
    const root = findRoot(input.cwd || process.cwd());
    if (!root) return;
    const seconds = flagNumber(args, 'timeout', DEFAULT_WAIT_S);
    const output = await runHook(new Store(root), event, input, { timeoutMs: Math.max(1, seconds) * 1000 });
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (err) {
    process.stderr.write(`ticketrail hook ${event}: ${(err as Error).message}\n`);
  }
}
