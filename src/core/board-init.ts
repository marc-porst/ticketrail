import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirName, hasBoard } from './paths.ts';
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

/**
 * How the generated skill should invoke the CLI. Installed as a dependency it
 * is on the PATH; run from a checkout it is not, so point straight at the
 * build — the skill then works before the package is ever published.
 */
function cliCommand(): string {
  const here = fileURLToPath(import.meta.url);
  if (here.includes(`${path.sep}node_modules${path.sep}`)) return 'npx ticketrail';
  const bundle = path.join(path.dirname(here), 'cli.js');
  return fs.existsSync(bundle) ? `node ${bundle}` : 'npx ticketrail';
}

function copyTree(from: string, to: string, force: boolean, written: string[], root: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyTree(src, dest, force, written, root);
    } else if (force || !fs.existsSync(dest)) {
      const body = fs.readFileSync(src, 'utf8').replaceAll('{{pk}}', cliCommand());
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

  return { root: resolved, name: store.projectName(), fresh, written, templatesMissing: !templates };
}
