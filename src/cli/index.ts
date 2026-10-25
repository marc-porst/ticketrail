import { Store } from '../core/store.ts';
import { requireRoot } from '../core/paths.ts';
import { currentSession, resolveModel } from '../core/model.ts';
import { flagString, parseArgs } from './args.ts';
import { initCommand } from './commands/init.ts';
import { serveCommand } from './commands/serve.ts';
import {
  addCommand,
  agentsCommand,
  assignCommand,
  sendCommand,
  deriveCommand,
  fileCommand,
  folderCommand,
  foldersCommand,
  labelCommand,
  listCommand,
  moveCommand,
  relateCommand,
  showCommand,
  statusCommand,
} from './commands/board.ts';
import { projectsCommand } from './commands/projects.ts';
import { attachCommand, detachCommand, filesCommand } from './commands/attach.ts';
import {
  askCommand,
  checkCommand,
  doneCommand,
  failCommand,
  logCommand,
  nextCommand,
  planCommand,
  waitCommand,
} from './commands/work.ts';

const HELP = `ticketrail — a kanban board your project and Claude Code share

  init [--port] [--title] [--force]  create .ticketrail/ and install the Claude skill
  serve [--port] [--open]          run the board UI + API

Working the board (this is what /ticketrail-work uses):
  next [--wait] [--timeout 500]    claim the top card of Implement, else Plan  -> JSON
  wait [--timeout 0]               block until Plan/Implement has a card; never claims (0 = no limit)
    both take --worker <name> and --only <filter> for parallel workers, e.g.
    --worker fe --only label:frontend,type:bug   (label: agent: folder: type:, "none" allowed)
  check <id>                       has the user pulled this card back?          -> JSON
  log <id> "text" [--kind]         append to the card's activity feed
  ask <id> "question" [--wait]     park on User Input, block for the answer     -> JSON
  plan <id> --file <plan.md>       store the plan, move to Planned
  done <id> --file <summary.md>    store the result, move to Done
  fail <id> "reason"               stop and hand the card back to the user
  files <id>                       the card's attachments, with paths to open  -> JSON
  attach <id> <file>...            attach a file to the card
  detach <id> <fileId>             remove an attachment

Everyday:
  add "title" [--description] [--column] [--type] [--label] [--related] [--folder] [--agent] [--for <worker>]   create a card
  list [--column] [--type] [--label] [--folder]   the board as JSON
  show <id>                                one card as JSON
  move <id> <column>                       move a card
  label <id> --add x [--remove y]          edit a card's labels
  derive <id>                              spawn a Feature card from an investigation
  relate <id> <other>...                   link cards whose context Claude reads with this one
  unrelate <id> <other>...                 remove those links
  folders                                  the board's folders as JSON (optional grouping)
  folder add "name" [--color]              create a folder  (also: rename, color, remove)
  file <id> <folder|none>                  put a card in a folder, or take it out
  agents                                   the project's agents (.claude/agents) as JSON
  assign <id> <agent|none>                 hand a card to an agent; the worker delegates it
  send <id> <worker|none>                  only that named worker may claim the card
  status                                   human-readable summary
  projects [add|remove <path>]             boards the switcher offers

Text arguments accept --text "...", --file <path>, or --file - for stdin.
In a linked git worktree the CLI uses the main checkout's board, so parallel
workers in separate worktrees share one board. TICKETRAIL_ROOT=<path> overrides.

The model behind each status change is recorded on the card. It is read from the
Claude Code session; pass --model <id> to say so yourself, or set recordModel to
false in .ticketrail/config.json to record nothing.
`;

async function main(): Promise<void> {
  const [, , command = 'help', ...rest] = process.argv;
  const args = parseArgs(rest);
  const positional = args.positional;

  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(HELP);
    return;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    console.log('ticketrail 0.1.0');
    return;
  }
  if (command === 'init') return initCommand(args);
  // works from anywhere: it is about every board, not the one you are standing in
  if (command === 'projects') return projectsCommand(args, positional);

  const store = new Store(requireRoot());
  // Which model is running is worth recording on the card, but it is the
  // board's call whether to: `recordModel: false` in config.json turns it off.
  if (store.config().recordModel !== false) store.model = resolveModel(flagString(args, 'model'));
  // The Session tab reads the worker's own transcript; `liveSession: false` keeps it out.
  if (store.config().liveSession !== false) store.session = currentSession();

  switch (command) {
    case 'serve': return serveCommand(store, args);
    case 'next': return nextCommand(store, args);
    case 'wait': return waitCommand(store, args);
    case 'check': return checkCommand(store, positional);
    case 'log': return logCommand(store, args, positional);
    case 'ask': return askCommand(store, args, positional);
    case 'plan': return planCommand(store, args, positional);
    case 'done': return doneCommand(store, args, positional);
    case 'fail': return failCommand(store, args, positional);
    case 'attach': return attachCommand(store, args, positional);
    case 'files': return filesCommand(store, positional);
    case 'detach': return detachCommand(store, positional);
    case 'add': return addCommand(store, args, positional);
    case 'list': return listCommand(store, args);
    case 'show': return showCommand(store, positional);
    case 'move': return moveCommand(store, positional);
    case 'label': return labelCommand(store, args, positional);
    case 'derive': return deriveCommand(store, positional);
    case 'relate': return relateCommand(store, positional);
    case 'unrelate': return relateCommand(store, positional, true);
    case 'folders': return foldersCommand(store);
    case 'folder': return folderCommand(store, args, positional);
    case 'file': return fileCommand(store, positional);
    case 'agents': return agentsCommand(store);
    case 'assign': return assignCommand(store, positional);
    case 'send': return sendCommand(store, positional);
    case 'status': return statusCommand(store);
    default:
      process.stderr.write(`Unknown command "${command}"\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((err: Error) => {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
});
