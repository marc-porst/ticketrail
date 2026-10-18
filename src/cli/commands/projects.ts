import path from 'node:path';
import {
  addProject,
  describeProjects,
  isBoard,
  removeProject,
  registryHome,
} from '../../core/registry.ts';
import { printJson } from '../io.ts';
import { flagBool, type Args } from '../args.ts';

export function projectsCommand(args: Args, positional: string[]): void {
  const [action, target] = positional;

  if (action === 'add') {
    if (!target) throw new Error('Usage: ticketrail projects add <path>');
    const root = path.resolve(target);
    if (!isBoard(root)) {
      throw new Error(`${root} has no board. Run "ticketrail init" there first.`);
    }
    const record = addProject(root);
    console.log(`registered ${record.path}  (${record.id})`);
    return;
  }

  if (action === 'remove') {
    if (!target) throw new Error('Usage: ticketrail projects remove <path|id>');
    const record = removeProject(target);
    console.log(record ? `removed ${record.path}` : `not registered: ${target}`);
    return;
  }

  if (action && action !== 'list') {
    throw new Error(`Usage: ticketrail projects [list|add <path>|remove <path|id>]`);
  }

  const projects = describeProjects();
  if (flagBool(args, 'json')) return printJson(projects);

  if (!projects.length) {
    console.log('No projects registered yet.');
    console.log('Run "ticketrail init" in a project, or "ticketrail projects add <path>".');
    return;
  }

  console.log(`Projects (${registryHome()}/projects.json)\n`);
  for (const p of projects) {
    if (p.missing) {
      console.log(`  ${p.name.padEnd(20)} ${p.shortPath}  — missing, remove with "projects remove ${p.id}"`);
      continue;
    }
    const bits = [
      p.summary.queued ? `${p.summary.queued} queued` : '',
      p.summary.inProgress ? `${p.summary.inProgress} in progress` : '',
      p.summary.blocked ? `${p.summary.blocked} waiting on you` : '',
    ].filter(Boolean);
    console.log(`  ${p.name.padEnd(20)} ${p.shortPath}${bits.length ? `  · ${bits.join(' · ')}` : ''}`);
  }
}
