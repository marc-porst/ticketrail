import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirName, findWorktree, hasBoard } from './paths.ts';
import { addProject } from './registry.ts';
import { DEFAULT_CONFIG, Store } from './store.ts';

export interface InitResult {
  root: string;
  name: string;
  /** The board did not exist before this call. */
  fresh: boolean;
  /** Claude files written into .claude, relative to the project root. */
  written: string[];
  /** templates/claude could not be located, so no skill was installed. */
  templatesMissing: boolean;
  /** What happened to the Claude Code hooks in .claude/settings.local.json. */
  hooks: HooksResult;
}

/** `skipped`: the settings file is not valid JSON, or there is no built CLI to point the hooks at. */
export type HooksResult = 'installed' | 'unchanged' | 'skipped';

/** Where the hooks go: per machine, because the command can be a path into this checkout. */
export const HOOKS_FILE = path.join('.claude', 'settings.local.json');

/** The hook timeout Claude Code allows the question hook, in seconds (it waits for the user). */
const QUESTION_HOOK_TIMEOUT_S = 3600;

/** A hook command this package wrote, whatever path it was written with. */
function isOurs(command: unknown): boolean {
  return typeof command === 'string' && /ticketrail|cli\.js/.test(command) && /\bhook (pre-tool|notify|resume)\b/.test(command);
}

/** The hooks a board needs, keyed by Claude Code event. */
function hookEntries(cli: string): Record<string, any[]> {
  const run = (event: string, extra: Record<string, unknown> = {}) => ({ type: 'command', command: `${cli} hook ${event}`, ...extra });
  return {
    PreToolUse: [{ matcher: 'AskUserQuestion|ExitPlanMode', hooks: [run('pre-tool', { timeout: QUESTION_HOOK_TIMEOUT_S })] }],
    Notification: [{ hooks: [run('notify')] }],
    PostToolUse: [{ matcher: '*', hooks: [run('resume')] }],
    UserPromptSubmit: [{ hooks: [run('resume')] }],
  };
}

/**
 * Merge the board's Claude Code hooks into .claude/settings.local.json. Hooks
 * and settings already there are kept; entries this package wrote before are
 * replaced, so a moved checkout gets the new path. A file that is not valid
 * JSON is left alone.
 */
export function installHooks(root: string, cli: string | null = hookCli()): HooksResult {
  if (!cli) return 'skipped';
  const file = path.join(root, HOOKS_FILE);
  let settings: any = {};
  let before = '';
  if (fs.existsSync(file)) {
    before = fs.readFileSync(file, 'utf8');
    try {
      settings = before.trim() ? JSON.parse(before) : {};
    } catch {
      return 'skipped';
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return 'skipped';
  }
  const hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks) ? settings.hooks : {};
  for (const [event, entries] of Object.entries(hookEntries(cli))) {
    const kept = (Array.isArray(hooks[event]) ? hooks[event] : [])
      .map((group: any) =>
        Array.isArray(group?.hooks) ? { ...group, hooks: group.hooks.filter((h: any) => !isOurs(h?.command)) } : group,
      )
      .filter((group: any) => !Array.isArray(group?.hooks) || group.hooks.length > 0);
    hooks[event] = [...kept, ...entries];
  }
  settings.hooks = hooks;
  const after = `${JSON.stringify(settings, null, 2)}\n`;
  if (after === before) return 'unchanged';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, after);
  return 'installed';
}

/** templates/claude ships with the package. */
function templateRoot(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, '..', 'templates', 'claude'), // dist/cli.js
    path.join(here, '..', '..', 'templates', 'claude'), // src/core/*.ts
    path.join(here, '..', '..', '..', 'templates', 'claude'), // src/cli/commands/*.ts
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'skills'))) return path.resolve(dir);
  }
  return null;
}

/** The bundled CLI this code belongs to: dist/cli.js itself, or the build next to a checkout's sources. */
function bundlePath(): string | null {
  const here = fileURLToPath(import.meta.url);
  const candidates = [
    here, // running the bundle: this code is dist/cli.js
    path.join(path.dirname(here), '..', '..', 'dist', 'cli.js'), // src/core/*.ts in a checkout
  ];
  for (const file of candidates) {
    if (path.basename(file) !== 'cli.js' || !fs.existsSync(file)) continue;
    try {
      return fs.realpathSync(file);
    } catch {
      return path.resolve(file);
    }
  }
  return null;
}

/** Is `file` inside `dir`? Both are compared with symlinks resolved. */
function isInside(file: string, dir: string): boolean {
  let real = dir;
  try {
    real = fs.realpathSync(dir);
  } catch {
    /* compare as given */
  }
  const rel = path.relative(real, file);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * How the generated skill should invoke the CLI. These files are committed, so
 * the command should work for everyone who clones the project:
 * - installed as a dependency of the project: `npx ticketrail`, which finds it there;
 * - installed globally: `ticketrail`, which is on the PATH (npx would not find it);
 * - run from a checkout of Ticketrail itself: straight at the build, so the
 *   skill works before the package is ever published.
 */
export function cliCommand(root?: string, bundle: string | null = bundlePath()): string {
  if (!bundle) return 'npx ticketrail';
  if (!bundle.includes(`${path.sep}node_modules${path.sep}`)) return `node ${bundle}`;
  return root && !isInside(bundle, path.join(root, 'node_modules')) ? 'ticketrail' : 'npx ticketrail';
}

/**
 * The command the hooks run. Unlike the skill, it is written per machine, so
 * it names the installed CLI by its absolute path, wherever that is: no npx
 * (slow on every tool call, and it would try to download the package), and no
 * dependence on what is on the PATH beyond `node`. Null when there is no build
 * to point at.
 */
export function hookCli(): string | null {
  const bundle = bundlePath();
  if (!bundle) return null;
  return nodeCommand(bundle);
}

/** `node <file>`, quoted when the shell would split or expand the path. */
export function nodeCommand(file: string): string {
  return `node ${/[\s"'$`\\]/.test(file) ? JSON.stringify(file) : file}`;
}

/**
 * Make sure the Claude Code project a worker runs in has the hooks: the
 * board's own checkout, or the linked worktree the worker is in, whose
 * untracked settings file a fresh worktree does not have. Also repoints hooks
 * at a moved or reinstalled CLI. Returns the settings file when it changed,
 * so the worker can be told the hooks apply from its next session.
 *
 * Only for a worker inside Claude Code, and never when the board says
 * `"hooks": false` in its config.json.
 */
export function ensureHooks(store: Store, start: string = process.cwd()): string | null {
  if (!process.env.CLAUDE_CODE_SESSION_ID || store.config().hooks === false) return null;
  const worktree = findWorktree(start);
  const dir = worktree && samePath(worktree.main, store.root) ? worktree.path : store.root;
  try {
    return installHooks(dir) === 'installed' ? path.join(dir, HOOKS_FILE) : null;
  } catch {
    return null; // a read-only checkout, say: the board still works without them
  }
}

function samePath(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

function copyTree(from: string, to: string, force: boolean, written: string[], root: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyTree(src, dest, force, written, root);
    } else if (force || !fs.existsSync(dest)) {
      const body = fs.readFileSync(src, 'utf8').replaceAll('{{pk}}', cliCommand(root));
      fs.writeFileSync(dest, body);
      written.push(path.relative(root, dest));
    }
  }
}

function patchGitignore(root: string): void {
  const file = path.join(root, '.gitignore');
  const dir = dataDirName(root);
  // sessions/ holds copies of terminal output, which can include anything a command printed
  const entries = [`${dir}/.locks/`, `${dir}/.runtime/`, `${dir}/sessions/`];
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const missing = entries.filter((e) => !current.split(/\r?\n/).includes(e));
  if (!missing.length) return;
  const block = `${current.trim() ? current.replace(/\s*$/, '\n\n') : ''}# Ticketrail runtime state (the board itself is committed)\n${missing.join('\n')}\n`;
  fs.writeFileSync(file, block);
}

/**
 * Create a board in `root`: the .ticketrail data directory, the Claude skill
 * files, the gitignore entries and a registry entry. Idempotent — run against
 * an existing board it only fills in what is missing, and never re-seeds the
 * welcome card or overwrites a title the user has chosen.
 */
export function initBoard(
  root: string,
  options: { port?: number; title?: string; force?: boolean } = {},
): InitResult {
  const resolved = path.resolve(root);
  const force = options.force ?? false;

  const fresh = !hasBoard(resolved);
  const store = Store.init(resolved, { port: options.port ?? DEFAULT_CONFIG.port });

  // Write the name into config.json so it is visible and editable rather than
  // being magic, but never overwrite one the user has already set.
  if (options.title || fresh) {
    store.saveConfig({ ...store.config(), title: options.title ?? store.projectName() });
  }

  const written: string[] = [];
  const templates = templateRoot();
  if (templates) copyTree(templates, path.join(resolved, '.claude'), force, written, resolved);
  const hooks = installHooks(resolved);
  patchGitignore(resolved);
  addProject(resolved);

  if (fresh && store.list().length === 0) {
    store.create({
      title: 'Welcome to Ticketrail',
      description: [
        'This card is a tour. Cards you write here are what Claude Code works from.',
        '',
        '- Write cards in **Backlog**. Only you put things there.',
        '- Drag a card to **Plan** and Claude researches it and writes a plan back.',
        '- Review the plan in **Planned**, edit it, then drag to **Implement**.',
        '- Drag straight to **Implement** to skip planning.',
        '- If Claude needs something from you the card lands in **User Input** — answer it right here in the card.',
        '',
        'Start the worker with `/ticketrail-work` in a Claude Code session, then drag this card to Plan to see it move.',
      ].join('\n'),
    });
  }

  return { root: resolved, name: store.projectName(), fresh, written, templatesMissing: !templates, hooks };
}
