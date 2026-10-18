import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refuse } from './store.ts';
import { isSkillName, parseFrontmatter } from './skill-rules.ts';
import { MANAGED_SKILLS, SKILL_FILE, skillsDir } from './skills.ts';

/**
 * Import skills from a git repository: shallow-clone it into a temp folder,
 * list every SKILL.md in it, then copy the ones the user picks into the
 * project's .claude/skills. A scan is kept for a while so the import step
 * copies exactly what the user saw, without cloning twice.
 */

export interface RepoSkill {
  /** The skill's folder inside the repository; what the import step names. */
  path: string;
  /** The name it will get in .claude/skills, or null if none is usable. */
  name: string | null;
  description: string;
  /** Other files that come with it. */
  files: number;
  /** The project already has a skill with this name. */
  exists: boolean;
  /**
   * Another folder in the repository holds a skill of the same name and is
   * the one to prefer (e.g. `skills/x` over a mirror in `.factory/skills/x`).
   */
  duplicateOf: string | null;
}

export interface RepoScan {
  id: string;
  repo: string;
  ref: string | null;
  subdir: string | null;
  skills: RepoSkill[];
}

export interface ImportResult {
  imported: string[];
  skipped: { path: string; reason: string }[];
}

/** How long a scan's clone is kept for the import step. */
export const SCAN_TTL_MS = 15 * 60_000;
const CLONE_TIMEOUT_MS = 90_000;
const MAX_SKILLS = 500;
const MAX_SKILL_BYTES = 10 * 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules']);

interface Clone {
  dir: string;
  scan: RepoScan;
  timer: NodeJS.Timeout;
}

const clones = new Map<string, Clone>();

/**
 * What to clone. A GitHub or GitLab page URL such as
 * `https://github.com/o/r/tree/main/skills` becomes the repository, the
 * branch and the folder to look in.
 */
export function parseRepoUrl(input: unknown): { repo: string; ref: string | null; subdir: string | null } {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) throw refuse(400, 'Paste the URL of a git repository');
  // an argument git would read as an option, or a transport that runs commands
  if (raw.startsWith('-') || /^ext::/i.test(raw) || /\s/.test(raw)) throw refuse(400, `"${raw}" is not a repository URL`);

  const ssh = /^[\w.-]+@[\w.-]+:[\w./~-]+$/.test(raw);
  if (ssh) return { repo: raw, ref: null, subdir: null };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw refuse(400, `"${raw}" is not a repository URL. Use https://…, git@host:owner/repo or file://…`);
  }
  if (!['https:', 'http:', 'ssh:', 'git:', 'file:'].includes(url.protocol)) {
    throw refuse(400, `${url.protocol.replace(':', '')} URLs are not supported`);
  }

  const page = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(?:-\/)?(?:tree|blob)\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
  if (page && /^(www\.)?(github\.com|gitlab\.com)$/.test(url.hostname)) {
    const [, owner, name, ref, rest] = page;
    let subdir = rest ? decodeURIComponent(rest).replace(/\/+$/, '') : null;
    // a link to the SKILL.md itself means its folder
    if (subdir && path.posix.basename(subdir) === SKILL_FILE) subdir = path.posix.dirname(subdir);
    return { repo: `${url.origin}/${owner}/${name}.git`, ref: decodeURIComponent(ref), subdir: subdir || null };
  }
  url.hash = '';
  return { repo: url.toString(), ref: null, subdir: null };
}

function git(args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      // never sit waiting for a password prompt nobody can see
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GCM_INTERACTIVE: 'never' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), CLONE_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(refuse(500, (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'git is not installed on this machine' : err.message));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      if (signal) return reject(refuse(504, 'Cloning took too long and was stopped'));
      const reason = stderr
        .split('\n')
        .map((l) => l.replace(/^(fatal|error|remote): /, '').trim())
        .filter(Boolean)
        .pop();
      reject(refuse(400, `Could not clone the repository${reason ? `: ${reason}` : ''}`));
    });
  });
}

/** Every folder under `dir` holding a SKILL.md, nearest first, symlinks not followed. */
function findSkillDirs(dir: string, rel = '', found: string[] = []): string[] {
  if (found.length >= MAX_SKILLS) return found;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return found;
  }
  if (entries.some((e) => e.isFile() && e.name === SKILL_FILE)) {
    found.push(rel);
    // a skill's own subfolders are its resources, not more skills
    return found;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
      findSkillDirs(dir, rel ? `${rel}/${entry.name}` : entry.name, found);
    }
  }
  return found;
}

/** Regular files only: a symlink in a cloned repo could point anywhere. */
function walkFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(dir, child));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

function skillName(declared: string, folder: string): string | null {
  if (isSkillName(declared)) return declared;
  const base = folder ? path.posix.basename(folder) : '';
  if (isSkillName(base)) return base;
  const slug = String(declared || base)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return isSkillName(slug) ? slug : null;
}

function describe(root: string, cloneDir: string, scan: Omit<RepoScan, 'skills'>): RepoSkill[] {
  const base = scan.subdir ? path.resolve(cloneDir, scan.subdir) : cloneDir;
  const inside = base === cloneDir || base.startsWith(cloneDir + path.sep);
  if (!inside || !fs.existsSync(base) || !fs.lstatSync(base).isDirectory()) {
    throw refuse(404, `The repository has no folder "${scan.subdir}"`);
  }
  const prefix = scan.subdir ? `${scan.subdir}/` : '';
  const skills: RepoSkill[] = findSkillDirs(base).map((rel) => {
    const raw = fs.readFileSync(path.join(base, rel, SKILL_FILE), 'utf8');
    const { frontmatter } = parseFrontmatter(raw);
    const name = skillName(frontmatter.name ?? '', rel || (scan.subdir ?? '') || path.basename(scan.repo, '.git'));
    return {
      path: (prefix + rel).replace(/\/$/, '') || '.',
      name,
      description: frontmatter.description ?? '',
      files: walkFiles(path.join(base, rel)).length - 1,
      exists: !!name && fs.existsSync(path.join(skillsDir(root), name)),
      duplicateOf: null,
    };
  });

  // Repos often mirror their skills for other tools (.factory/, .cursor/…).
  // Per name, prefer a path without hidden folders, then the shallowest.
  const rank = (p: string) => [p.split('/').some((part) => part.startsWith('.') && part !== '.') ? 1 : 0, p.split('/').length, p];
  const preferred = new Map<string, RepoSkill>();
  for (const skill of [...skills].sort((a, b) => compare(rank(a.path), rank(b.path)))) {
    if (!skill.name) continue;
    const first = preferred.get(skill.name);
    if (first) skill.duplicateOf = first.path;
    else preferred.set(skill.name, skill);
  }
  return skills;
}

function compare(a: (string | number)[], b: (string | number)[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

function forget(id: string): void {
  const clone = clones.get(id);
  if (!clone) return;
  clearTimeout(clone.timer);
  clones.delete(id);
  fs.rmSync(clone.dir, { recursive: true, force: true });
}

/** Clone the repository and list the skills in it. */
export async function scanRepo(root: string, url: unknown): Promise<RepoScan> {
  const target = parseRepoUrl(url);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-skill-import-'));
  try {
    const args = ['-c', 'protocol.ext.allow=never', 'clone', '--depth', '1', '--single-branch', '--no-tags'];
    if (target.ref) args.push('--branch', target.ref);
    await git([...args, '--', target.repo, dir]);

    const id = crypto.randomBytes(8).toString('hex');
    const head = { id, ...target };
    const scan: RepoScan = { ...head, skills: describe(root, dir, head) };
    const timer = setTimeout(() => forget(id), SCAN_TTL_MS);
    timer.unref?.();
    clones.set(id, { dir, scan, timer });
    return scan;
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Copy the chosen skills (by their path in the repository) into the
 * project. An existing skill is left alone unless `overwrite` is set.
 */
export function importSkills(
  root: string,
  input: { scanId?: unknown; paths?: unknown; overwrite?: unknown },
): ImportResult {
  const clone = typeof input.scanId === 'string' ? clones.get(input.scanId) : undefined;
  if (!clone) throw refuse(410, 'That scan has expired; load the repository again');
  if (!Array.isArray(input.paths) || !input.paths.length) throw refuse(400, 'Pick at least one skill to import');
  const overwrite = input.overwrite === true;

  const result: ImportResult = { imported: [], skipped: [] };
  const taken = new Set<string>();
  for (const wanted of input.paths) {
    const skill = clone.scan.skills.find((s) => s.path === wanted);
    if (!skill) {
      result.skipped.push({ path: String(wanted), reason: 'not in this repository' });
      continue;
    }
    if (!skill.name) {
      result.skipped.push({ path: skill.path, reason: 'no usable skill name' });
      continue;
    }
    if (taken.has(skill.name)) {
      result.skipped.push({ path: skill.path, reason: `another selected skill is also called "${skill.name}"` });
      continue;
    }
    const dest = path.join(skillsDir(root), skill.name);
    let destIsLink = false;
    try {
      destIsLink = fs.lstatSync(dest).isSymbolicLink();
    } catch {
      /* not there yet */
    }
    // replacing it would delete it, which Ticketrail's own skills never allow
    if (MANAGED_SKILLS.includes(skill.name)) {
      result.skipped.push({ path: skill.path, reason: `"${skill.name}" comes with Ticketrail and cannot be replaced` });
      continue;
    }
    if (destIsLink) {
      result.skipped.push({ path: skill.path, reason: `"${skill.name}" is a symlink in this project` });
      continue;
    }
    if (fs.existsSync(dest) && !overwrite) {
      result.skipped.push({ path: skill.path, reason: `"${skill.name}" already exists` });
      continue;
    }

    const source = path.join(clone.dir, skill.path === '.' ? '' : skill.path);
    const files = walkFiles(source);
    const bytes = files.reduce((n, f) => n + fs.statSync(path.join(source, f)).size, 0);
    if (bytes > MAX_SKILL_BYTES) {
      result.skipped.push({ path: skill.path, reason: 'larger than 10 MB' });
      continue;
    }

    // build it beside the target, then swap, so a failed copy leaves the old skill intact
    const staging = path.join(skillsDir(root), `.import-${skill.name}-${process.pid}-${Date.now()}`);
    fs.mkdirSync(staging, { recursive: true });
    try {
      for (const file of files) {
        fs.mkdirSync(path.dirname(path.join(staging, file)), { recursive: true });
        fs.copyFileSync(path.join(source, file), path.join(staging, file));
      }
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(staging, dest);
    } catch (err) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw err;
    }
    taken.add(skill.name);
    result.imported.push(skill.name);
  }
  return result;
}

/** Drop every kept clone; the server calls this when it shuts down. */
export function forgetScans(): void {
  for (const id of [...clones.keys()]) forget(id);
}
