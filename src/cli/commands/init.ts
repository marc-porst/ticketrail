import { initBoard } from '../../core/board-init.ts';
import { dataDirName, LEGACY_DATA_DIR } from '../../core/paths.ts';
import { DEFAULT_CONFIG } from '../../core/store.ts';
import { flagBool, flagNumber, flagString, type Args } from '../args.ts';

export function initCommand(args: Args): void {
  const result = initBoard(process.cwd(), {
    port: flagNumber(args, 'port', DEFAULT_CONFIG.port),
    title: flagString(args, 'title'),
    force: flagBool(args, 'force'),
  });

  const dir = dataDirName(result.root);
  console.log(`Ticketrail ready in ${result.root}`);
  console.log(`  project      ${result.name}  (rename it in ${dir}/config.json)`);
  console.log(`  board data   ${dir}/`);
  if (dir === LEGACY_DATA_DIR) {
    console.log(`               made before the rename; stop the server, then: git mv ${LEGACY_DATA_DIR} .ticketrail`);
  }
  if (result.written.length) {
    console.log(`  claude files ${result.written.join('\n               ')}`);
  } else if (!result.templatesMissing) {
    console.log(`  claude files already present (use --force to overwrite)`);
  }
  console.log(`\nNext: ticketrail serve   (or /ticketrail-start in Claude Code)`);
}
