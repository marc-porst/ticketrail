import type { Folder } from './folder.ts';
import { isTaskType, type Task, type TaskType } from './task.ts';

/**
 * Which cards a named worker takes: `--only label:frontend,type:bug`. Values of
 * one kind are alternatives (label:a,label:b = either label); different kinds
 * must all hold (label:a,type:bug = a bug labelled a). `none` matches a card
 * that has no agent / no folder / no type.
 */
export interface WorkFilter {
  labels: string[];
  agents: (string | null)[];
  /** Folder ids, resolved from names when the filter is parsed. */
  folders: (string | null)[];
  types: (TaskType | null)[];
}

const KINDS = ['label', 'agent', 'folder', 'type'] as const;

export function emptyFilter(): WorkFilter {
  return { labels: [], agents: [], folders: [], types: [] };
}

export function isEmptyFilter(filter: WorkFilter): boolean {
  return !filter.labels.length && !filter.agents.length && !filter.folders.length && !filter.types.length;
}

/** Parse `--only` values. Each may hold several comma-separated terms. Throws on anything it cannot read. */
export function parseFilter(specs: string[], folders: Folder[]): WorkFilter {
  const filter = emptyFilter();
  for (const term of specs.flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean)) {
    const at = term.indexOf(':');
    const kind = at > 0 ? term.slice(0, at).toLowerCase() : '';
    const value = at > 0 ? term.slice(at + 1).trim() : '';
    if (!value || !(KINDS as readonly string[]).includes(kind)) {
      throw new Error(`Cannot read the filter "${term}". Use ${KINDS.map((k) => `${k}:<value>`).join(', ')}`);
    }
    const none = value.toLowerCase() === 'none';
    if (kind === 'label') filter.labels.push(value.toLowerCase());
    if (kind === 'agent') filter.agents.push(none ? null : value);
    if (kind === 'type') {
      if (!none && !isTaskType(value)) throw new Error(`Unknown type "${value}" in the filter`);
      filter.types.push(none ? null : (value as TaskType));
    }
    if (kind === 'folder') {
      if (none) {
        filter.folders.push(null);
        continue;
      }
      const folder = folders.find((f) => f.id === value || f.name.toLowerCase() === value.toLowerCase());
      if (!folder) throw new Error(`No folder "${value}" for the filter`);
      filter.folders.push(folder.id);
    }
  }
  return filter;
}

export function matchesFilter(task: Task, filter: WorkFilter): boolean {
  if (filter.labels.length && !task.labels.some((l) => filter.labels.includes(l.toLowerCase()))) return false;
  if (filter.agents.length && !filter.agents.includes(task.agent ?? null)) return false;
  if (filter.folders.length && !filter.folders.includes(task.folder ?? null)) return false;
  if (filter.types.length && !filter.types.includes(task.type ?? null)) return false;
  return true;
}

/** Back to the `--only` form, folder ids shown by name: what the board header prints. */
export function describeFilter(filter: WorkFilter, folders: Folder[] = []): string {
  const folderName = (id: string | null) => (id === null ? 'none' : (folders.find((f) => f.id === id)?.name ?? id));
  return [
    ...filter.labels.map((l) => `label:${l}`),
    ...filter.agents.map((a) => `agent:${a ?? 'none'}`),
    ...filter.folders.map((f) => `folder:${folderName(f)}`),
    ...filter.types.map((t) => `type:${t ?? 'none'}`),
  ].join(',');
}
