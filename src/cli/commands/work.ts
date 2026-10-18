import fs from 'node:fs';
import type { Store } from '../../core/store.ts';
import { waitFor } from '../../core/watch.ts';
import { startHeartbeat, touchWorker } from '../../core/presence.ts';
import { isWorkerName, type ActivityKind, type Message, type Task } from '../../core/task.ts';
import { flagBool, flagList, flagNumber, flagString, type Args } from '../args.ts';
import { printJson, textInput } from '../io.ts';
import { relatedContext, withPaths } from './attach.ts';
import { agentExists, readAgent } from '../../core/agents.ts';
import { describeFilter, isEmptyFilter, matchesFilter, parseFilter, type WorkFilter } from '../../core/filter.ts';
import { findWorktree } from '../../core/paths.ts';
import { describeNews, hasNews, markSeen, unseenNews } from '../../core/news.ts';

/**
 * Finishing a card with notes the user left mid-run would ignore them. Stop
 * once, hand them over, and let the worker run the same command again.
 */
function refuseWithNews(store: Store, id: string, command: string): void {
  const task = store.get(id);
  if (!task || task.column !== 'in-progress') return;
  const news = unseenNews(store, task);
  if (!hasNews(news)) return;
  markSeen(store, task);
  throw new Error(
    `${describeNews(news)}\n\nNot finished yet: read the above, adjust your work if it changes anything, ` +
      `then run \`ticketrail ${command} ${id} ...\` again.`,
  );
}

/**
 * Has the CLI been rebuilt since this process started? A worker can wait for
 * hours, and a waiting process keeps the code it started with; without this
 * it would go on matching cards by rules the board has since replaced.
 */
export function codeChanged(script: string | undefined = process.argv[1]): () => boolean {
  const stamp = (): number | null => {
    try {
      return script ? fs.statSync(fs.realpathSync(script)).mtimeMs : null;
    } catch {
      return null;
    }
  };
  const started = stamp();
  return () => {
    if (started === null) return false;
    const now = stamp();
    return now !== null && now !== started;
  };
}

const UPDATED_NOTE = 'ticketrail was updated while this worker waited. Run next again; it uses the new version.';

/** `--worker <name>` and `--only <filter>`: who this worker is and which cards it takes. */
interface WorkerSpec {
  name: string | null;
  filter: WorkFilter | null;
  /** The filter as the board header shows it. */
  label: string | null;
}

function workerSpec(store: Store, args: Args): WorkerSpec {
  const name = flagString(args, 'worker') ?? null;
  if (name !== null && !isWorkerName(name)) {
    throw new Error(`"${name}" is not a usable worker name: letters, digits, ".", "_" and "-", at most 40 characters`);
  }
  const folders = store.folders();
  const filter = parseFilter(flagList(args, 'only'), folders);
  if (isEmptyFilter(filter)) return { name, filter: null, label: null };
  return { name, filter, label: describeFilter(filter, folders) };
}

/** The worker's filter alone; claimNext adds the rule for cards sent to a worker. */
function matcher(spec: WorkerSpec): (task: Task) => boolean {
  const filter = spec.filter;
  return filter ? (task) => matchesFilter(task, filter) : () => true;
}

/** Would this worker claim the card? The same rule claimNext applies, for `wait`. */
function claimable(spec: WorkerSpec): (task: Task) => boolean {
  const filter = matcher(spec);
  return (task) => (task.worker ? task.worker === spec.name : filter(task));
}

const DEFAULT_TIMEOUT_S = 500; // stays under the 600s ceiling of Claude Code's Bash tool

function timeoutMs(args: Args): number {
  return Math.max(0, flagNumber(args, 'timeout', DEFAULT_TIMEOUT_S)) * 1000;
}

/**
 * Block until Implement or Plan holds a card, without claiming it. This is what
 * an idle worker runs in the background: it costs nothing while it waits, and
 * because it never moves a card, a session closed mid-wait leaves nothing
 * stranded in In Progress. `--timeout 0` means no limit.
 */
export async function waitCommand(store: Store, args: Args): Promise<void> {
  const seconds = Math.max(0, flagNumber(args, 'timeout', 0));
  const spec = workerSpec(store, args);
  const match = claimable(spec);
  const updated = codeChanged();
  // a filtered worker is only woken by cards it would actually claim
  const probe = (): { updated: true } | { implement: number; plan: number } | null => {
    if (updated()) return { updated: true };
    const implement = store.column('implement').filter(match).length;
    const plan = store.column('plan').filter(match).length;
    return implement || plan ? { implement, plan } : null;
  };
  // the heartbeat is what lights up "worker ready" in the board header
  const stop = startHeartbeat(store, { name: spec.name, filter: spec.label });
  let ready: Awaited<ReturnType<typeof probe>>;
  try {
    ready = await waitFor(store, probe, seconds === 0 ? Infinity : seconds * 1000);
  } finally {
    stop();
  }
  touchWorker(store);
  if (ready && 'updated' in ready) return printJson({ status: 'updated', note: UPDATED_NOTE });
  printJson(ready ? { status: 'ready', ...ready } : { status: 'timeout' });
}

/**
 * Claim the next card a worker can act on. A card naming an agent whose file is
 * gone goes straight back to the user rather than being worked by the wrong hands.
 */
function claimWorkable(store: Store, spec: WorkerSpec): Task | null {
  for (;;) {
    const task = store.claimNext({ worker: spec.name, match: matcher(spec) });
    if (!task?.agent || agentExists(store.root, task.agent)) return task;
    store.fail(
      task.id,
      `This card is assigned to the agent "${task.agent}", but .claude/agents/${task.agent}.md does not exist. ` +
        'Create that agent, pick another one, or clear the agent field, then move the card back.',
    );
  }
}

/** Claim the top card of the highest-priority queue, blocking until one shows up. */
export async function nextCommand(store: Store, args: Args): Promise<void> {
  const spec = workerSpec(store, args);
  touchWorker(store);
  let task: Task | null;
  if (flagBool(args, 'wait')) {
    // a long wait must not claim with code that has since been replaced
    const updated = codeChanged();
    const stop = startHeartbeat(store, { name: spec.name, filter: spec.label });
    let got: Task | 'updated' | null;
    try {
      got = await waitFor<Task | 'updated'>(store, () => (updated() ? 'updated' : claimWorkable(store, spec)), timeoutMs(args));
    } finally {
      stop();
    }
    touchWorker(store);
    if (got === 'updated') return printJson({ status: 'none', reason: 'updated', note: UPDATED_NOTE });
    task = got;
  } else {
    task = claimWorkable(store, spec);
  }

  if (!task) return printJson({ status: 'none' });
  const related = relatedContext(store, task);
  const folder = task.folder ? store.findFolder(task.folder) : null;
  const agent = task.agent ? readAgent(store.root, task.agent) : null;
  const worktree = findWorktree();
  printJson({
    status: 'claimed',
    mode: task.mode,
    type: task.type,
    ...(spec.name ? { worker: spec.name } : {}),
    task: withPaths(store, task),
    ...(worktree
      ? {
          worktree: { path: worktree.path, branch: worktree.branch },
          worktreeNote:
            `You are working in the git worktree ${worktree.path}` +
            (worktree.branch ? ` on branch ${worktree.branch}` : '') +
            '. Make your changes there, not in the main checkout, and name the worktree and branch in your summary ' +
            'so the user can review and merge them.',
        }
      : {}),
    ...(folder ? { folderName: folder.name } : {}),
    ...(task.attachments.length
      ? { attachmentNote: `This card has ${task.attachments.length} file(s). Read each attachments[].path before you start.` }
      : {}),
    ...(related.length
      ? {
          relatedCards: related,
          relatedNote:
            `This card links ${related.length} related card(s). Read their plan and result for context before you start. ` +
            'They are context, not work: do not edit, move or claim them.',
        }
      : {}),
    ...(agent ? { agent: { name: agent.name, description: agent.description, path: agent.path } } : {}),
    guidance: agent ? delegationFor(task, agent.path) : guidanceFor(task),
  });
}

/**
 * A card with an agent is handed to that subagent. The worker stays a thin
 * dispatcher: the subagent's work never fills the worker's own context.
 */
function delegationFor(task: Task, agentPath: string): string {
  const name = task.agent!;
  return (
    `This card is assigned to the project agent "${name}". Do not do the work yourself: delegate the whole card ` +
    `to it with the Agent tool (subagent_type "${name}"). If that agent type is unknown to this session ` +
    `(it was created after the session started), use a general-purpose subagent and tell it to follow ${agentPath} ` +
    'as its instructions. In the prompt, give it the card id, title, description, plan, attachment paths and ' +
    'related-card context from this output, tell it to log milestones with ticketrail log <id> "...", ' +
    `and give it this instruction: ${guidanceFor(task)} If it cannot finish, it must run ticketrail fail <id> "reason". ` +
    'When the subagent returns, run ticketrail check <id>; if the card is still In Progress, finish it yourself ' +
    "from the subagent's report with the same command."
  );
}

/**
 * What the worker should do with the card it just claimed. Type wins over mode
 * for the two read-only types: an investigation or a question never writes code
 * whichever queue it was dragged into.
 */
function guidanceFor(task: Task): string {
  if (task.type === 'investigation') {
    return (
      'This is an Investigation card. Research the codebase and write your findings into the plan. ' +
      'Do not change any code and do not create or edit files outside the plan. ' +
      'Finish with: ticketrail plan <id> --file <plan.md>'
    );
  }
  if (task.type === 'question') {
    return (
      'This is a Question card. Answer it — do not change any code. ' +
      'Finish with: ticketrail done <id> --file <answer.md>, so the answer is on the card.'
    );
  }
  if (task.mode === 'plan') return 'Research and write a plan, then: ticketrail plan <id> --file <plan.md>';
  return task.plan
    ? 'Implement the plan stored on this card, then: ticketrail done <id> --file <summary.md>'
    : 'No plan on this card — implement from the description, then: ticketrail done <id> --file <summary.md>';
}

export function logCommand(store: Store, args: Args, positional: string[]): void {
  const [id, ...rest] = positional;
  const text = textInput(args, rest);
  if (!id || !text) throw new Error('Usage: ticketrail log <id> "what you just did" [--kind info|file|test|error]');
  const kind = (flagString(args, 'kind') ?? 'info') as ActivityKind;
  touchWorker(store);
  store.activity(id, text, kind);
  const task = store.get(id);
  console.log(`logged to #${task?.number ?? id}`);
  // a milestone is the natural moment to hear what the user added meanwhile
  if (task?.column === 'in-progress') {
    const news = unseenNews(store, task);
    if (hasNews(news)) {
      markSeen(store, task);
      console.log(`\n${describeNews(news)}`);
    }
  }
}

/** Park the card on User Input and (optionally) block until the user answers. */
export async function askCommand(store: Store, args: Args, positional: string[]): Promise<void> {
  const [id, ...rest] = positional;
  const question = textInput(args, rest);
  if (!id || !question) throw new Error('Usage: ticketrail ask <id> "your question" [--wait]');

  const { message } = store.ask(id, question);

  if (!flagBool(args, 'wait')) {
    return printJson({ status: 'asked', questionId: message.id, task: store.get(id) });
  }

  const probe = (): { task: Task; answer: Message } | null => {
    const task = store.get(id);
    if (!task) return null;
    const asked = task.messages.find((m) => m.id === message.id);
    if (!asked?.answeredBy) return null;
    const answer = task.messages.find((m) => m.id === asked.answeredBy);
    return answer ? { task, answer } : null;
  };

  touchWorker(store);
  const stop = startHeartbeat(store);
  let result: Awaited<ReturnType<typeof probe>>;
  try {
    result = await waitFor(store, probe, timeoutMs(args));
  } finally {
    stop();
  }
  touchWorker(store);
  if (!result) {
    return printJson({
      status: 'pending',
      questionId: message.id,
      task: store.get(id),
      guidance:
        'Nobody answered yet. The card stays in User Input — stop working on it and tell the user you are waiting.',
    });
  }
  printJson({ status: 'answered', answer: result.answer.text, task: result.task });
}

export function planCommand(store: Store, args: Args, positional: string[]): void {
  const [id, ...rest] = positional;
  const plan = textInput(args, rest, ['file', 'plan-file']);
  if (!id || !plan) throw new Error('Usage: ticketrail plan <id> --file <plan.md>  (or --text "..." or - for stdin)');
  touchWorker(store);
  refuseWithNews(store, id, 'plan');
  const task = store.savePlan(id, plan);
  console.log(`#${task.number} "${task.title}" -> Planned (${plan.length} chars). Waiting for review.`);
}

export function doneCommand(store: Store, args: Args, positional: string[]): void {
  const [id, ...rest] = positional;
  const result = textInput(args, rest, ['file', 'summary-file']);
  if (!id) throw new Error('Usage: ticketrail done <id> --file <summary.md>  (or --text "..." or - for stdin)');
  touchWorker(store);
  refuseWithNews(store, id, 'done');
  const task = store.finish(id, result || 'Finished.');
  console.log(`#${task.number} "${task.title}" -> Done.`);
}

export function failCommand(store: Store, args: Args, positional: string[]): void {
  const [id, ...rest] = positional;
  const reason = textInput(args, rest);
  if (!id || !reason) throw new Error('Usage: ticketrail fail <id> "why you stopped"');
  touchWorker(store);
  const task = store.fail(id, reason);
  console.log(`#${task.number} "${task.title}" -> User Input. Waiting for the user.`);
}

/** Cheap mid-run check: has the user dragged the card away from In Progress? */
export function checkCommand(store: Store, positional: string[]): void {
  const [id] = positional;
  const task = id ? store.get(id) : null;
  if (!task) throw new Error(`Usage: ticketrail check <id>`);
  touchWorker(store);
  const working = !task.cancelRequested && task.column === 'in-progress';
  const news = working ? unseenNews(store, task) : null;
  if (news && hasNews(news)) markSeen(store, task);
  printJson({
    status: working ? 'ok' : 'cancelled',
    column: task.column,
    cancelRequested: task.cancelRequested,
    ...(news && hasNews(news)
      ? {
          news,
          newsNote: 'The user added this while you work on the card. Read the messages, open the files, and take them into account.',
        }
      : {}),
  });
}
