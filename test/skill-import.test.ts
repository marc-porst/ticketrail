import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { forgetScans, importSkills, parseRepoUrl, scanRepo } from '../src/core/skill-import.ts';
import { readSkill, skillsDir } from '../src/core/skills.ts';

let repo: string;
let repoUrl: string;
let root: string;

function write(file: string, text: string) {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
}

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-skill-repo-'));
  write('README.md', '# skills');
  write('skills/release-notes/SKILL.md', '---\nname: release-notes\ndescription: Write release notes\n---\n# Notes\n');
  write('skills/release-notes/reference.md', 'ref');
  write('skills/release-notes/scripts/run.sh', 'echo hi');
  write('skills/Fancy Folder/SKILL.md', '---\nname: code-review\ndescription: Review code\n---\n');
  write('skills/ticketrail/SKILL.md', '---\nname: ticketrail\ndescription: Impostor\n---\n');
  write('skills/bad/SKILL.md', '---\nname: Not Valid!\ndescription: No usable name from folder either\n---\n');
  write('other/deep/nested/pdf/SKILL.md', '---\ndescription: No name, folder wins\n---\n');
  write('.factory/skills/release-notes/SKILL.md', '---\nname: release-notes\ndescription: Mirror\n---\n');
  fs.symlinkSync('/etc/hosts', path.join(repo, 'skills/release-notes/hosts'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'skills');
  repoUrl = pathToFileURL(repo).toString();
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-import-root-'));
});

afterEach(() => {
  forgetScans();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('repository URLs', () => {
  it('turns a GitHub folder link into repository, branch and folder', () => {
    expect(parseRepoUrl('https://github.com/acme/skills/tree/main/skills/pdf')).toEqual({
      repo: 'https://github.com/acme/skills.git',
      ref: 'main',
      subdir: 'skills/pdf',
    });
    expect(parseRepoUrl('https://github.com/acme/skills/blob/dev/pdf/SKILL.md')).toMatchObject({ ref: 'dev', subdir: 'pdf' });
    expect(parseRepoUrl('https://github.com/acme/skills')).toEqual({ repo: 'https://github.com/acme/skills', ref: null, subdir: null });
    expect(parseRepoUrl('git@github.com:acme/skills.git').repo).toBe('git@github.com:acme/skills.git');
  });

  it('refuses things that are not a repository, or that git would run', () => {
    for (const bad of ['', '--upload-pack=touch /tmp/x', 'ext::sh -c touch% /tmp/x', 'not a url', 'javascript:alert(1)']) {
      expect(() => parseRepoUrl(bad)).toThrow();
    }
  });
});

describe('scan and import', () => {
  it('lists every skill in the repository with a usable name', async () => {
    fs.mkdirSync(path.join(skillsDir(root), 'code-review'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir(root), 'code-review', 'SKILL.md'), '---\nname: code-review\ndescription: mine\n---\n');

    const scan = await scanRepo(root, repoUrl);
    const byPath = Object.fromEntries(scan.skills.map((s) => [s.path, s]));
    expect(Object.keys(byPath).sort()).toEqual([
      '.factory/skills/release-notes',
      'other/deep/nested/pdf',
      'skills/Fancy Folder',
      'skills/bad',
      'skills/release-notes',
      'skills/ticketrail',
    ]);
    expect(byPath['skills/release-notes']).toMatchObject({ name: 'release-notes', description: 'Write release notes', files: 2, exists: false });
    expect(byPath['skills/Fancy Folder']).toMatchObject({ name: 'code-review', exists: true });
    expect(byPath['other/deep/nested/pdf'].name).toBe('pdf');
    expect(byPath['skills/bad'].name).toBe('bad');
    // the mirror in a hidden folder defers to the plain one
    expect(byPath['skills/release-notes'].duplicateOf).toBeNull();
    expect(byPath['.factory/skills/release-notes'].duplicateOf).toBe('skills/release-notes');
  });

  it('copies the chosen skills, regular files only, and leaves existing ones unless told to replace', async () => {
    fs.mkdirSync(path.join(skillsDir(root), 'code-review'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir(root), 'code-review', 'SKILL.md'), 'mine');

    const scan = await scanRepo(root, repoUrl);
    const first = importSkills(root, { scanId: scan.id, paths: ['skills/release-notes', 'skills/Fancy Folder'] });
    expect(first.imported).toEqual(['release-notes']);
    expect(first.skipped).toEqual([{ path: 'skills/Fancy Folder', reason: '"code-review" already exists' }]);

    const dir = path.join(skillsDir(root), 'release-notes');
    expect(fs.readFileSync(path.join(dir, 'scripts/run.sh'), 'utf8')).toBe('echo hi');
    expect(fs.existsSync(path.join(dir, 'hosts'))).toBe(false);
    expect(readSkill(root, 'release-notes').description).toBe('Write release notes');
    expect(fs.readFileSync(path.join(skillsDir(root), 'code-review', 'SKILL.md'), 'utf8')).toBe('mine');

    const second = importSkills(root, { scanId: scan.id, paths: ['skills/Fancy Folder'], overwrite: true });
    expect(second.imported).toEqual(['code-review']);
    expect(readSkill(root, 'code-review').description).toBe('Review code');
    // Ticketrail's own skill is never replaced, even with overwrite
    fs.mkdirSync(path.join(skillsDir(root), 'ticketrail'));
    fs.writeFileSync(path.join(skillsDir(root), 'ticketrail', 'SKILL.md'), 'ours');
    const third = importSkills(root, { scanId: scan.id, paths: ['skills/ticketrail'], overwrite: true });
    expect(third.skipped[0].reason).toMatch(/comes with Ticketrail/);
    expect(fs.readFileSync(path.join(skillsDir(root), 'ticketrail', 'SKILL.md'), 'utf8')).toBe('ours');
    fs.rmSync(path.join(skillsDir(root), 'ticketrail'), { recursive: true });

    // no staging folders left behind
    expect(fs.readdirSync(skillsDir(root)).sort()).toEqual(['code-review', 'release-notes']);
  });

  it('explains a repository that cannot be cloned', async () => {
    await expect(scanRepo(root, repoUrl + '-missing')).rejects.toThrow(/Could not clone/);
  });

  it('refuses an unknown or expired scan, and a path that was not in it', async () => {
    expect(() => importSkills(root, { scanId: 'nope', paths: ['x'] })).toThrow(/expired/);
    const scan = await scanRepo(root, repoUrl);
    expect(importSkills(root, { scanId: scan.id, paths: ['../../etc'] }).skipped[0].reason).toBe('not in this repository');
    forgetScans();
    expect(() => importSkills(root, { scanId: scan.id, paths: ['skills/release-notes'] })).toThrow(/expired/);
  });
});
