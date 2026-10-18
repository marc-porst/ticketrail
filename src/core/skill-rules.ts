/**
 * The parts of a skill that need no filesystem, shared by the server and the
 * board UI (live preview, name hints).
 */

/** Claude's own rules for a skill name. */
export const SKILL_NAME = /^[a-z0-9](?:[a-z0-9]|-(?!-)){0,63}$/;
export const MAX_SKILL_DESCRIPTION = 1024;
/** Written by `ticketrail init`; `init --force` puts it back. */
export const MANAGED_SKILLS = ['ticketrail'];

export function isSkillName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && SKILL_NAME.test(value);
}

/**
 * Just enough YAML for skill frontmatter: `key: value`, quoted values, and
 * `>` / `|` block scalars. Anything else marks the block invalid; the raw
 * file is what gets saved either way.
 */
export function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string; valid: boolean } {
  const text = raw.replace(/^\uFEFF/, '');
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) {
    const opened = /^---[ \t]*\r?\n/.test(text);
    return { frontmatter: {}, body: text, valid: !opened };
  }

  const frontmatter: Record<string, string> = {};
  const lines = match[1].split(/\r?\n/);
  let valid = true;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const kv = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (!kv) {
      valid = false;
      continue;
    }
    const [, key, rest] = kv;
    const block = /^([>|])[+-]?\s*$/.exec(rest);
    if (block || rest === '') {
      // a block scalar, or a value continued on indented lines (lists included)
      const taken: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) {
        taken.push(lines[++i].trim());
      }
      while (taken.length && !taken[taken.length - 1]) taken.pop();
      frontmatter[key] =
        block?.[1] === '|'
          ? taken.join('\n')
          : taken.map((t) => t.replace(/^-\s+/, '')).join(block ? ' ' : ', ').replace(/\s+/g, ' ').trim();
      continue;
    }
    frontmatter[key] = unquote(rest.trim());
  }
  return { frontmatter, body: text.slice(match[0].length), valid };
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) {
    const inner = value.slice(1, -1);
    return value[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\n/g, '\n') : inner.replace(/''/g, "'");
  }
  return value;
}
