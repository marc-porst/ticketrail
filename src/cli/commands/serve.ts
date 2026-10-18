import { spawn } from 'node:child_process';
import { startServer } from '../../server/server.ts';
import { Store } from '../../core/store.ts';
import { addProject, describeProjects } from '../../core/registry.ts';
import { COLUMN_LABELS, COLUMNS } from '../../core/task.ts';
import { flagBool, flagNumber, type Args } from '../args.ts';

export async function serveCommand(store: Store, args: Args): Promise<void> {
  // Serving a board is as good as declaring it, so it shows up in the switcher.
  addProject(store.root);
  const handle = await startServer(store, { port: flagNumber(args, 'port', store.config().port) });

  const counts = store.list().reduce<Record<string, number>>((acc, task) => {
    acc[task.column] = (acc[task.column] ?? 0) + 1;
    return acc;
  }, {});

  const others = describeProjects().filter((p) => p.path !== store.root && !p.missing);
  console.log(`Ticketrail is serving ${store.projectName()} (${store.root})`);
  console.log(`  ${handle.url}`);
  if (others.length) {
    console.log(`  also switchable from the header: ${others.map((p) => p.name).join(', ')}`);
  }
  console.log(
    `  ${COLUMNS.filter((c) => counts[c]).map((c) => `${COLUMN_LABELS[c]} ${counts[c]}`).join(' · ') || 'board is empty'}`,
  );

  if (flagBool(args, 'open')) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(opener, [handle.url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
  }

  const shutdown = () => {
    void handle.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
