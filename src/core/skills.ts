import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { refuse } from './store.ts';
import { isSkillName, MANAGED_SKILLS, MAX_SKILL_DESCRIPTION, parseFrontmatter } from './skill-rules.ts';

export { isSkillName, MANAGED_SKILLS, MAX_SKILL_DESCRIPTION, parseFrontmatter, SKILL_NAME } from './skill-rules.ts';

/**
 * Project skills: `<root>/.claude/skills/<name>/SKILL.md`, the layout Claude
 * Code reads. The board UI lists, renders, edits, creates and deletes them.
 * Nothing here rewrites a file it was not asked to write, and nothing reaches
 * outside the skills directory, whatever name or symlink it is handed.
 */

export const SKILL_FILE = 'SKILL.md';

export interface SkillSummary {
  name: string;
  description: string;
  /** Installed by Ticketrail itself. */
  managed: boolean;
  /** A symlinked skill: shown, never written or deleted from here. */
  readonly: boolean;
  /** Everything else in the skill's directory, relative to it. */
  files: string[];
  updatedAt: string;
}

export interface Skill extends SkillSummary {
  /** The whole SKILL.md, frontmatter included. */
  raw: string;
  frontmatter: Record<string, string>;
  /** False when there is a `---` block it could not read. */
  frontmatterValid: boolean;
  body: string;
  /** Changes whenever the file does; a save must quote the one it read. */
  version: string;
  path: string;
}

export function skillsDir(root: string): string {
  return path.join(root, '.claude', 'skills');
}

export function skillVersion(raw: string): string {
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12);
}

/** The skill's directory, or a refusal if the name could lead anywhere else. */
function locate(root: string, name: string): { dir: string; linked: boolean } {
  if (!isSkillName(name)) {
    throw refuse(400, `"${name}" is not a valid skill name: use lowercase letters, digits and single hyphens, at most 64 characters`);
  }
  const base = skillsDir(root);
  const dir = path.join(base, name);
  const isLink = (file: string) => {
    try {
      return fs.lstatSync(file).isSymbolicLink();
    } catch {
      return false;
    }
  };
  return { dir, linked: isLink(dir) || isLink(path.join(dir, SKILL_FILE)) };
}

function existing(root: string, name: string): { dir: string; linked: boolean } {
  const found = locate(root, name);
  if (!fs.existsSync(path.join(found.dir, SKILL_FILE))) throw refuse(404, `No skill named "${name}"`);
  return found;
}

function writable(root: string, name: string): string {
  const { dir, linked } = existing(root, name);
  if (linked) throw refuse(403, `"${name}" is a symlink to somewhere else; edit it where it lives`);
  return dir;
}

function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(dir, prefix), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(dir, rel));
    else if (rel !== SKILL_FILE) out.push(rel);
    if (out.length >= 200) break;
  }
  return out.sort();
}

function summarize(name: string, dir: string, linked: boolean, raw: string): Skill {
  const file = path.join(dir, SKILL_FILE);
  const { frontmatter, body, valid } = parseFrontmatter(raw);
  return {
    name,
    description: frontmatter.description ?? '',
    managed: MANAGED_SKILLS.includes(name),
    readonly: linked,
    files: listFiles(dir),
    updatedAt: fs.statSync(file).mtime.toISOString(),
    raw,
    frontmatter,
    frontmatterValid: valid,
    body,
    version: skillVersion(raw),
    path: file,
  };
}

export function listSkills(root: string): SkillSummary[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(skillsDir(root));
  } catch {
    return [];
  }
  const skills: SkillSummary[] = [];
  for (const name of entries.sort()) {
    if (!isSkillName(name)) continue;
    try {
      const { raw, frontmatter, body, frontmatterValid, version, path: _path, ...summary } = readSkill(root, name);
      skills.push(summary);
    } catch {
      /* not a skill directory, or unreadable: leave it out */
    }
  }
  return skills;
}

export function readSkill(root: string, name: string): Skill {
  const { dir, linked } = existing(root, name);
  return summarize(name, dir, linked, fs.readFileSync(path.join(dir, SKILL_FILE), 'utf8'));
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
export function writeSkill(root: string, name: string, raw: unknown, expectedVersion?: string, force = false): Skill {
  if (typeof raw !== 'string') throw refuse(400, 'A skill needs its text');
  const dir = writable(root, name);
  const file = path.join(dir, SKILL_FILE);
  const current = fs.readFileSync(file, 'utf8');
  if (!force && expectedVersion && skillVersion(current) !== expectedVersion) {
    throw refuse(409, `"${name}" changed on disk since you opened it`);
  }
  writeAtomic(file, raw);
  return readSkill(root, name);
}

function titleFor(name: string): string {
  return name
    .split('-')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

/** The frontmatter is quoted so a colon or `#` in the description stays valid YAML. */
export function skillTemplate(name: string, description: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    '---',
    '',
    `# ${titleFor(name)}`,
    '',
    '## When to use',
    '',
    '- Describe the situations where Claude should reach for this skill.',
    '',
    '## Steps',
    '',
    '1. First step.',
    '2. Second step.',
    '',
  ].join('\n');
}

export function createSkill(root: string, input: { name?: unknown; description?: unknown; raw?: unknown }): Skill {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const description = typeof input.description === 'string' ? input.description.trim().replace(/\s+/g, ' ') : '';
  const { dir } = locate(root, name);
  if (!description) throw refuse(400, 'A skill needs a description: it is how Claude decides when to use it');
  if (description.length > MAX_SKILL_DESCRIPTION) {
    throw refuse(400, `Keep the description under ${MAX_SKILL_DESCRIPTION} characters`);
  }
  if (fs.existsSync(dir)) throw refuse(409, `A skill named "${name}" already exists`);

  fs.mkdirSync(dir, { recursive: true });
  const raw = typeof input.raw === 'string' && input.raw.trim() ? input.raw : skillTemplate(name, description);
  writeAtomic(path.join(dir, SKILL_FILE), raw);
  return readSkill(root, name);
}

export function deleteSkill(root: string, name: string): { removed: string } {
  const dir = writable(root, name);
  if (MANAGED_SKILLS.includes(name)) {
    throw refuse(403, `"${name}" comes with Ticketrail and cannot be deleted; /ticketrail-work depends on it`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { removed: name };
}

/**
 * Delete several skills in one go. Each is checked like a single delete; one
 * that cannot go (unknown, symlinked) is reported and the rest still are.
 */
export function deleteSkills(root: string, names: unknown): { removed: string[]; failed: { name: string; reason: string }[] } {
  if (!Array.isArray(names) || !names.length) throw refuse(400, 'Pick at least one skill to delete');
  const removed: string[] = [];
  const failed: { name: string; reason: string }[] = [];
  for (const name of new Set(names.map(String))) {
    try {
      deleteSkill(root, name);
      removed.push(name);
    } catch (err) {
      failed.push({ name, reason: (err as Error).message });
    }
  }
  return { removed, failed };
}
