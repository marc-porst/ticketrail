export interface Args {
  positional: string[];
  /** A flag repeated on the command line collects into an array. */
  flags: Record<string, string | boolean | string[]>;
}

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};

  /** Repeating a flag appends rather than overwrites, so --label works twice. */
  const set = (name: string, value: string | boolean) => {
    const current = flags[name];
    if (current === undefined) return void (flags[name] = value);
    if (typeof value !== 'string') return;
    flags[name] = typeof current === 'string' ? [current, value] : Array.isArray(current) ? [...current, value] : value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      set(body, next);
      i++;
    } else {
      set(body, true);
    }
  }

  return { positional, flags };
}

export function flagString(args: Args, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args.flags[name];
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.length) return value[value.length - 1];
  }
  return undefined;
}

/** Every value given for a repeatable flag, in the order they were typed. */
export function flagList(args: Args, ...names: string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    const value = args.flags[name];
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) out.push(...value);
  }
  return out;
}

export function flagBool(args: Args, ...names: string[]): boolean {
  return names.some((name) => args.flags[name] === true || args.flags[name] === 'true');
}

export function flagNumber(args: Args, name: string, fallback: number): number {
  const value = flagString(args, name);
  const parsed = value === undefined ? NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
