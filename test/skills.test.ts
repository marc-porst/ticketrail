import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSkill,
  deleteSkill,
  deleteSkills,
  isSkillName,
  listSkills,
  parseFrontmatter,
  readSkill,
  skillsDir,
  writeSkill,
} from '../src/core/skills.ts';

let root: string;

function put(name: string, raw: string, extra: Record<string, string> = {}) {
  const dir = path.join(skillsDir(root), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), raw);
  for (const [file, text] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-skills-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('frontmatter', () => {
  it('reads plain, quoted and folded values', () => {
    const { frontmatter, body, valid } = parseFrontmatter(
      [
        '---',
        'name: release-notes',
        'description: >',
        '  Write release notes.',
        '  Use for changelogs.',
        "model: 'claude-opus-5-5'",
        'allowed-tools: "Bash(git log:*), Read"',
        '---',
        '# Release notes',
        '',
      ].join('\n'),
    );
    expect(valid).toBe(true);
    expect(frontmatter).toEqual({
      name: 'release-notes',
      description: 'Write release notes. Use for changelogs.',
      model: 'claude-opus-5-5',
      'allowed-tools': 'Bash(git log:*), Read',
    });
    expect(body).toBe('# Release notes\n');
  });

  it('treats a file without frontmatter as all body, and flags an unclosed block', () => {
    expect(parseFrontmatter('# Just text')).toEqual({ frontmatter: {}, body: '# Just text', valid: true });
    expect(parseFrontmatter('---\nname: x\n# never closed').valid).toBe(false);
  });
});

describe('skill names', () => {
  it('follows Claude’s rules', () => {
    for (const ok of ['a', 'release-notes', 'v2-api', 'x'.repeat(64)]) expect(isSkillName(ok)).toBe(true);
    for (const bad of ['', 'Release', '-lead', 'two--dashes', 'dot.ted', '../up', 'a/b', 'x'.repeat(65)]) {
      expect(isSkillName(bad)).toBe(false);
    }
  });
});

describe('skills on disk', () => {
  it('lists skills with their description and extra files, sorted, ignoring stray folders', () => {
    put('zeta', '---\nname: zeta\ndescription: Last\n---\nbody');
    put('alpha', '---\nname: alpha\ndescription: First\n---\nbody', { 'reference.md': 'ref', 'scripts/run.sh': 'echo' });
    fs.mkdirSync(path.join(skillsDir(root), 'no-skill-file'), { recursive: true });

    const skills = listSkills(root);
    expect(skills.map((s) => s.name)).toEqual(['alpha', 'zeta']);
    expect(skills[0]).toMatchObject({ description: 'First', files: ['reference.md', 'scripts/run.sh'], managed: false });
    expect(skills[0]).not.toHaveProperty('raw');
  });

  it('has no skills when the project has no .claude folder', () => {
    expect(listSkills(root)).toEqual([]);
  });

  it('marks the skill Ticketrail installs as managed, and never deletes it', () => {
    put('ticketrail', '---\nname: ticketrail\ndescription: Board\n---\n');
    put('other', '---\nname: other\ndescription: x\n---\n');
    expect(listSkills(root).map((s) => [s.name, s.managed])).toEqual([['other', false], ['ticketrail', true]]);

    expect(() => deleteSkill(root, 'ticketrail')).toThrow(/comes with Ticketrail/);
    const bulk = deleteSkills(root, ['ticketrail', 'other']);
    expect(bulk.removed).toEqual(['other']);
    expect(bulk.failed[0].name).toBe('ticketrail');
    expect(fs.existsSync(path.join(skillsDir(root), 'ticketrail', 'SKILL.md'))).toBe(true);
    // still editable
    expect(writeSkill(root, 'ticketrail', 'edited').raw).toBe('edited');
  });

  it('creates a skill from the template, valid enough for Claude to read', () => {
    const skill = createSkill(root, { name: 'release-notes', description: 'Write notes: from git. #fast' });
    expect(skill.frontmatter).toMatchObject({ name: 'release-notes', description: 'Write notes: from git. #fast' });
    expect(skill.body).toMatch(/^\s*# Release Notes/);
    expect(fs.existsSync(path.join(skillsDir(root), 'release-notes', 'SKILL.md'))).toBe(true);
  });

  it('refuses a bad name, a duplicate and a missing description', () => {
    expect(() => createSkill(root, { name: 'Bad Name', description: 'x' })).toThrow(/not a valid skill name/);
    expect(() => createSkill(root, { name: 'ok', description: '  ' })).toThrow(/needs a description/);
    createSkill(root, { name: 'ok', description: 'x' });
    expect(() => createSkill(root, { name: 'ok', description: 'x' })).toThrow(/already exists/);
  });

  it('saves when the version matches and refuses when the file moved on', () => {
    const skill = createSkill(root, { name: 'notes', description: 'x' });
    const saved = writeSkill(root, 'notes', skill.raw + '\nMore.\n', skill.version);
    expect(saved.raw).toMatch(/More\.\n$/);

    let caught: (Error & { status?: number }) | undefined;
    try {
      writeSkill(root, 'notes', 'stale edit', skill.version);
    } catch (err) {
      caught = err as Error & { status?: number };
    }
    expect(caught?.status).toBe(409);
    expect(readSkill(root, 'notes').raw).toBe(saved.raw);

    expect(writeSkill(root, 'notes', 'forced', skill.version, true).raw).toBe('forced');
  });

  it('deletes the whole skill directory', () => {
    put('gone', '---\nname: gone\ndescription: x\n---\n', { 'extra.md': 'x' });
    expect(deleteSkill(root, 'gone')).toEqual({ removed: 'gone' });
    expect(fs.existsSync(path.join(skillsDir(root), 'gone'))).toBe(false);
  });

  it('deletes several skills at once and reports the ones it could not', () => {
    put('one', '---\nname: one\ndescription: x\n---\n');
    put('two', '---\nname: two\ndescription: x\n---\n');
    put('three', '---\nname: three\ndescription: x\n---\n');
    const result = deleteSkills(root, ['one', 'two', 'two', 'missing', '../up']);
    expect(result.removed).toEqual(['one', 'two']);
    expect(result.failed.map((f) => f.name)).toEqual(['missing', '../up']);
    expect(listSkills(root).map((s) => s.name)).toEqual(['three']);
    expect(() => deleteSkills(root, [])).toThrow(/at least one/);
  });

  it('never reaches outside .claude/skills', () => {
    fs.writeFileSync(path.join(root, 'SKILL.md'), 'outside');
    for (const name of ['..', '../..', '/etc', 'a/../..']) {
      expect(() => readSkill(root, name)).toThrow(/not a valid skill name/);
      expect(() => deleteSkill(root, name)).toThrow(/not a valid skill name/);
      expect(() => writeSkill(root, name, 'x')).toThrow(/not a valid skill name/);
    }
    expect(fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8')).toBe('outside');
  });

  it('shows a symlinked skill but will not write or delete through the link', () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-skill-src-'));
    fs.writeFileSync(path.join(elsewhere, 'SKILL.md'), '---\nname: shared\ndescription: Shared\n---\n');
    fs.mkdirSync(skillsDir(root), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(skillsDir(root), 'shared'));

    expect(listSkills(root)[0]).toMatchObject({ name: 'shared', readonly: true });
    expect(() => writeSkill(root, 'shared', 'x')).toThrow(/symlink/);
    expect(() => deleteSkill(root, 'shared')).toThrow(/symlink/);
    expect(fs.existsSync(path.join(elsewhere, 'SKILL.md'))).toBe(true);
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });
});
