import fs from 'node:fs';
import path from 'node:path';
import { refuse } from './store.ts';
import { isSkillName, MAX_SKILL_DESCRIPTION, parseFrontmatter } from './skill-rules.ts';
import { skillVersion } from './skills.ts';
import { AGENT_TEMPLATES } from './agent-templates.ts';

export { AGENT_TEMPLATES } from './agent-templates.ts';

/**
 * Project agents: `<root>/.claude/agents/<name>.md`, the Claude Code subagent
 * layout. A card can name one; the worker then hands the card to it. Same
 * guards as skills: nothing reaches outside the agents directory, and a
 * symlinked agent is shown but never written or deleted from here.
 */

/** Agent names follow the skill rules: lowercase letters, digits, single hyphens. */
export const isAgentName = isSkillName;

export interface AgentSummary {
  name: string;
  description: string;
  /** The `model` frontmatter, if the agent pins one. */
  model: string | null;
  /** A symlinked agent: shown, never written or deleted from here. */
  readonly: boolean;
  updatedAt: string;
}

export interface Agent extends AgentSummary {
  /** The whole file, frontmatter included. */
  raw: string;
  frontmatter: Record<string, string>;
  frontmatterValid: boolean;
  /** The system prompt. */
  body: string;
  /** Changes whenever the file does; a save must quote the one it read. */
  version: string;
  path: string;
}

export function agentsDir(root: string): string {
  return path.join(root, '.claude', 'agents');
}

/** The agent's file, or a refusal if the name could lead anywhere else. */
function locate(root: string, name: string): { file: string; linked: boolean } {
  if (!isAgentName(name)) {
    throw refuse(400, `"${name}" is not a valid agent name: use lowercase letters, digits and single hyphens, at most 64 characters`);
  }
  const file = path.join(agentsDir(root), `${name}.md`);
  let linked = false;
  try {
    linked = fs.lstatSync(file).isSymbolicLink();
  } catch {
    /* not there yet */
  }
  return { file, linked };
}

function existing(root: string, name: string): { file: string; linked: boolean } {
  const found = locate(root, name);
  if (!fs.existsSync(found.file)) throw refuse(404, `No agent named "${name}"`);
  return found;
}

function writable(root: string, name: string): string {
  const { file, linked } = existing(root, name);
  if (linked) throw refuse(403, `"${name}" is a symlink to somewhere else; edit it where it lives`);
  return file;
}

export function agentExists(root: string, name: string): boolean {
  return isAgentName(name) && fs.existsSync(path.join(agentsDir(root), `${name}.md`));
}

export function readAgent(root: string, name: string): Agent {
  const { file, linked } = existing(root, name);
  const raw = fs.readFileSync(file, 'utf8');
  const { frontmatter, body, valid } = parseFrontmatter(raw);
  return {
    name,
    description: frontmatter.description ?? '',
    model: frontmatter.model || null,
    readonly: linked,
    updatedAt: fs.statSync(file).mtime.toISOString(),
    raw,
    frontmatter,
    frontmatterValid: valid,
    body,
    version: skillVersion(raw),
    path: file,
  };
}

export function listAgents(root: string): AgentSummary[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(agentsDir(root));
  } catch {
    return [];
  }
  const agents: AgentSummary[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.md')) continue;
    const name = entry.slice(0, -3);
    if (!isAgentName(name)) continue;
    try {
      const { raw, frontmatter, body, frontmatterValid, version, path: _path, ...summary } = readAgent(root, name);
      agents.push(summary);
    } catch {
      /* unreadable: leave it out */
    }
  }
  return agents;
}

function writeAtomic(file: string, text: string): void {
  const tmp = path.join(path.dirname(file), `.tmp-${path.basename(file)}-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Save the whole file. `expectedVersion` is the version the editor loaded;
 * if the file changed since, nothing is written unless `force` is set.
 */
export function writeAgent(root: string, name: string, raw: unknown, expectedVersion?: string, force = false): Agent {
  if (typeof raw !== 'string') throw refuse(400, 'An agent needs its text');
  const file = writable(root, name);
  const current = fs.readFileSync(file, 'utf8');
  if (!force && expectedVersion && skillVersion(current) !== expectedVersion) {
    throw refuse(409, `"${name}" changed on disk since you opened it`);
  }
  writeAtomic(file, raw);
  return readAgent(root, name);
}

/** The frontmatter is quoted so a colon or `#` in the description stays valid YAML. */
export function agentTemplate(name: string, description: string, template = 'blank'): string {
  const base = AGENT_TEMPLATES[template] ?? AGENT_TEMPLATES.blank;
  return ['---', `name: ${name}`, `description: ${JSON.stringify(description)}`, '---', '', base.body].join('\n');
}

export function createAgent(
  root: string,
  input: { name?: unknown; description?: unknown; template?: unknown; raw?: unknown },
): Agent {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const template = typeof input.template === 'string' ? input.template : 'blank';
  const fallback = AGENT_TEMPLATES[template]?.description ?? '';
  const description =
    (typeof input.description === 'string' ? input.description.trim().replace(/\s+/g, ' ') : '') || fallback;
  const { file } = locate(root, name);
  if (!description) throw refuse(400, 'An agent needs a description: it says what the agent is for');
  if (description.length > MAX_SKILL_DESCRIPTION) {
    throw refuse(400, `Keep the description under ${MAX_SKILL_DESCRIPTION} characters`);
  }
  if (fs.existsSync(file)) throw refuse(409, `An agent named "${name}" already exists`);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = typeof input.raw === 'string' && input.raw.trim() ? input.raw : agentTemplate(name, description, template);
  writeAtomic(file, raw);
  return readAgent(root, name);
}

export function deleteAgent(root: string, name: string): { removed: string } {
  const file = writable(root, name);
  fs.rmSync(file, { force: true });
  return { removed: name };
}
