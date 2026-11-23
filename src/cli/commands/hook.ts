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
 *   pre-tool  PreToolUse on AskUserQuestion / ExitPlanMode. The question goes
 *             to the card instead of the terminal, and the hook hands the
 *             user's answer back to Claude.
 *   notify    Notification. Claude is waiting in the terminal (a permission
 *             prompt, an idle turn): the card moves to User Input and says so.
 *   resume    PostToolUse / UserPromptSubmit. The session moved again, so a
 *             card held for the terminal goes back to In Progress.
 *
 * A hook only touches the card the session is working. Any other Claude Code
 * session in the project, and any failure, leaves Claude Code alone.
 */
export const HOOK_EVENTS = ['pre-tool', 'notify', 'resume'] as const;
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
  };
}

/** The hook's own timeout in settings; the wait for an answer stops a minute short of it. */
export const HOOK_TIMEOUT_S = 3600;
const DEFAULT_WAIT_S = HOOK_TIMEOUT_S - 60;

const APPROVE = 'Approve';
const KEEP_PLANNING = 'Keep planning';

function decide(permissionDecision: 'allow' | 'deny', permissionDecisionReason: string): PreToolOutput {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason } };
}

type Outcome =
  | { status: 'answered'; task: Task; answers: { question: Message; answer: Message }[] }
  | { status: 'cancelled'; task: Task | null }
  | { status: 'timeout'; task: Task | null };

/** Block until every question is answered, the user pulls the card away, or time runs out. */
async function awaitAnswers(store: Store, taskId: string, asked: Message[], timeoutMs: number): Promise<Outcome> {
  const ids = asked.map((m) => m.id);
  const probe = (): Outcome | null => {
    const task = store.get(taskId);
    if (!task) return { status: 'cancelled', task: null };
    const questions = ids.map((id) => task.messages.find((m) => m.id === id));
    const answers = questions.map((q) => (q?.answeredBy ? task.messages.find((m) => m.id === q.answeredBy) : undefined));
    if (questions.every((q, i) => q && answers[i])) {
      return { status: 'answered', task, answers: questions.map((q, i) => ({ question: q!, answer: answers[i]! })) };
    }
    if (task.column !== 'user-input') return { status: 'cancelled', task };
    return null;
  };
  touchWorker(store);
  const stop = startHeartbeat(store);
  try {
    return (await waitFor(store, probe, timeoutMs)) ?? { status: 'timeout', task: store.get(taskId) };
  } finally {
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

function notAnswered(outcome: Exclude<Outcome, { status: 'answered' }>, card: Task, timeoutMs: number): string {
  if (outcome.status === 'cancelled') {
    const where = outcome.task ? `it is now in ${COLUMN_LABELS[outcome.task.column]}` : 'it was deleted';
    return (
      `The user did not answer on the Ticketrail board: they moved card #${card.number} away from User Input (${where}). ` +
      `Do not ask again. Run \`ticketrail check ${card.id}\` and do what it says.`
    );
  }
  return (
    `Nobody answered on the Ticketrail board within ${duration(timeoutMs)}. The question stays on card #${card.number} in User Input. ` +
    'Stop working on this card, tell the user you are waiting for their answer there, and move on.'
  );
}

function answerText(answer: Message): string {
  return answer.choices?.length ? answer.choices.join(', ') : answer.text;
}

/** AskUserQuestion: ask on the card, wait, and give Claude the answers as the reason the terminal was skipped. */
async function askOnBoard(store: Store, card: Task, input: any, timeoutMs: number): Promise<PreToolOutput | null> {
  const questions = (Array.isArray(input?.questions) ? input.questions : [])
    .filter((q: any) => typeof q?.question === 'string' && q.question.trim())
    .map((q: any) => ({
      text: q.question.trim(),
      header: typeof q.header === 'string' ? q.header : undefined,
      options: Array.isArray(q.options) ? q.options : [],
      multiSelect: q.multiSelect === true,
    }));
  if (!questions.length) return null;

  const { messages } = store.askAll(card.id, questions, 'terminal');
  const outcome = await awaitAnswers(store, card.id, messages, timeoutMs);
  if (outcome.status !== 'answered') return decide('deny', notAnswered(outcome, card, timeoutMs));

  const lines = outcome.answers.map(({ question, answer }) => `- "${question.text}" → ${answerText(answer)}`);
  return decide(
    'deny',
    [
      `The user answered on the Ticketrail board (card #${card.number}), so the question was not shown in the terminal. Their answers:`,
      ...lines,
      'Carry on with these answers. Do not ask the same question again. ' +
        `Next time, ask with \`ticketrail ask ${card.id} "..." --option "..." --wait\`.`,
    ].join('\n'),
  );
}

/** ExitPlanMode: the user approves leaving plan mode on the card, not in the terminal. */
async function approvePlanOnBoard(store: Store, card: Task, input: any, timeoutMs: number): Promise<PreToolOutput> {
  const plan = typeof input?.plan === 'string' ? input.plan.trim() : '';
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
    'terminal',
  );
  const outcome = await awaitAnswers(store, card.id, messages, timeoutMs);
  if (outcome.status !== 'answered') return decide('deny', notAnswered(outcome, card, timeoutMs));
  const answer = outcome.answers[0].answer;
  const approved = answer.choices?.includes(APPROVE) || answer.text.trim().toLowerCase() === APPROVE.toLowerCase();
  if (approved) return decide('allow', `The user approved the plan on the Ticketrail board (card #${card.number}).`);
  return decide(
    'deny',
    `The user did not approve leaving plan mode on the Ticketrail board (card #${card.number}). Their answer: ${answerText(answer)}`,
  );
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
  idle: 'Claude stopped and is waiting for you in the terminal.',
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
): Promise<PreToolOutput | null> {
  const sessionId = input.session_id ?? '';
  if (!sessionId) return null;

  if (event === 'resume') {
    store.resume(sessionId);
    return null;
  }

  const card = store.cardOfSession(sessionId);
  if (!card) return null;

  if (event === 'notify') {
    const kind = waitKind(input);
    // a question on the card is already what the user sees; the hook is waiting for it
    if (kind && !(card.column === 'user-input' && !card.waiting)) {
      store.markWaiting(card.id, { kind, text: input.message?.trim() || WAIT_TEXT[kind] });
    }
    return null;
  }

  // pre-tool: the session is clearly moving, whatever else happens
  store.resume(sessionId);
  const fresh = store.get(card.id);
  if (!fresh || fresh.column !== 'in-progress') return null;
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_S * 1000;
  if (input.tool_name === 'AskUserQuestion') return askOnBoard(store, fresh, input.tool_input, timeoutMs);
  if (input.tool_name === 'ExitPlanMode') return approvePlanOnBoard(store, fresh, input.tool_input, timeoutMs);
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
