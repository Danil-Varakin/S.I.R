export interface ArgSpec<T> {
  readonly flags?: Readonly<Record<string, keyof T & string>>;
  readonly negated?: Readonly<Record<string, keyof T & string>>;
  readonly values?: Readonly<Record<string, keyof T & string>>;
  readonly counts?: Readonly<Record<string, keyof T & string>>;
  readonly optional?: Readonly<Record<string, keyof T & string>>;
}

export function parseCountValue(raw: string): unknown {
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

export function parseArgs<T extends object>(argv: readonly string[], spec: ArgSpec<T>, initial: T): T {
  const opts = initial as Record<string, unknown>;
  const known = knownOptions(spec);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;

    const optional = spec.optional?.[a];
    if (optional !== undefined) {
      const next = argv[i + 1];
      opts[optional] = next !== undefined && !next.startsWith('-') ? argv[++i]! : '';
      continue;
    }

    const flag = spec.flags?.[a];
    if (flag !== undefined) {
      opts[flag] = true;
      continue;
    }

    const negated = spec.negated?.[a];
    if (negated !== undefined) {
      opts[negated] = false;
      continue;
    }

    const count = spec.counts?.[a];
    if (count !== undefined) {
      opts[count] = parseCountValue(valueFor(a, argv[++i], known));
      continue;
    }

    const value = spec.values?.[a];
    if (value === undefined) throw unknownArgument(a, known);
    opts[value] = valueFor(a, argv[++i], known);
  }

  return initial;
}

export function pickOptions<T>(spec: ArgSpec<T>, names: readonly string[]): ArgSpec<T> {
  const groups = ['flags', 'negated', 'values', 'counts', 'optional'] as const;
  const out: { -readonly [K in keyof ArgSpec<T>]: Record<string, keyof T & string> } = {};
  for (const name of names) {
    const group = groups.find((g) => spec[g]?.[name] !== undefined);
    if (group === undefined) throw new Error(`pickOptions: ${name} is not an option of the full command`);
    (out[group] ??= {})[name] = spec[group]![name]!;
  }
  return out;
}

export function knownOptions<T>(spec: ArgSpec<T>): ReadonlySet<string> {
  const groups = [spec.flags, spec.negated, spec.values, spec.counts, spec.optional];
  return new Set(groups.flatMap((group) => Object.keys(group ?? {})));
}

function valueFor(option: string, val: string | undefined, known: ReadonlySet<string>): string {
  if (val === undefined) throw new Error(`option ${option} needs a value`);
  if (known.has(val)) throw new Error(`option ${option} needs a value, and ${val} is another option`);
  return val;
}

function unknownArgument(a: string, known: ReadonlySet<string>): Error {
  const near = closest(a, known);
  if (near !== undefined) return new Error(`unknown argument: ${a}\n  did you mean ${near}?`);
  if (!a.startsWith('-')) {
    return new Error(`unknown argument: ${a}\n  a value goes after its option, as in --in ${a}`);
  }
  return new Error(`unknown argument: ${a}`);
}

function closest(a: string, known: ReadonlySet<string>): string | undefined {
  if (a.length < 4) return undefined;
  let best: string | undefined;
  let bestDistance = 3;
  for (const option of known) {
    const d = distance(a, option);
    if (d < bestDistance) {
      best = option;
      bestDistance = d;
    }
  }
  return best;
}

function distance(a: string, b: string): number {
  let previous = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      row.push(Math.min(substitution, previous[j]! + 1, row[j - 1]! + 1));
    }
    previous = row;
  }
  return previous[b.length]!;
}
