import { ConfigError } from '../../core/errors.ts';
import { DEFAULT_SYNTH_LIMITS } from '../../generate/limits.ts';
import type { SynthLimits } from '../../generate/limits.ts';
import { GIT_EOLS } from '../git.ts';
import type { GitEol, GitSource } from '../git.ts';

// A RANGE, not a number: this sir reads every config schema from CONFIG_MIN to
// CONFIG_VERSION, and writes CONFIG_VERSION. Adding an optional key raises only
// CONFIG_VERSION, so every config already committed keeps loading; CONFIG_MIN moves
// only when an old schema can no longer be read as it was meant. Rules: VERSIONING.md.
export const CONFIG_VERSION: number = 3;
export const CONFIG_MIN: number = 3;

/** `v1`, or `v1–v3` once the range opens up. */
export function configRange(): string {
  return CONFIG_MIN === CONFIG_VERSION ? `v${CONFIG_VERSION}` : `v${CONFIG_MIN}–v${CONFIG_VERSION}`;
}

export interface GenerateSettings extends SynthLimits {
  /** The root of the code the project patches, from the config file's directory — the
   *  top-level key `upstream`, not under `generate`: it is where the project lies, not
   *  what a run does. With it a patch is `<config dir>/<out>/<path from upstream>.sirp`
   *  and `Target` is measured from it. Schema 2. */
  readonly upstream: string | null;
  readonly out: string | null;
  readonly language: string | null;
  readonly exact: boolean;
  readonly bridgeGap: number;
  /** The old version out of git, as `--head` / `--branch` / `--commit` name it. Naming
   *  any of the three is the ask for git, as on the command line. Schema 2. */
  readonly baseHead: boolean;
  readonly baseBranch: string | null;
  readonly baseCommit: string | null;
  /** The line endings of that old version: as git stores it, or as the file on disk
   *  has them. Schema 2. */
  readonly baseEol: GitEol;
}

export type PartialSettings = { [K in keyof GenerateSettings]?: GenerateSettings[K] | undefined };

type ValueKind = 'boolean' | 'count' | 'countOrAll' | 'stringOrNull' | 'eol';

export interface FieldSpec {
  readonly path: string;
  readonly key: keyof GenerateSettings;
  readonly kind: ValueKind;
  readonly flag: string;
  /** The first config schema this key is part of. */
  readonly since: number;
  /** The last schema it is part of; absent while it still is. */
  readonly until?: number;
  /** Set when the key arrived in a release without the schema bump C2 asks for: it is
   *  part of `since` as released (P7), and the summary says so. */
  readonly unbumpedIn?: string;
}

export const FIELDS: readonly FieldSpec[] = [
  { path: 'upstream', key: 'upstream', kind: 'stringOrNull', flag: '--upstream', since: 2 },
  { path: 'generate.out', key: 'out', kind: 'stringOrNull', flag: '--out', since: 1 },
  { path: 'generate.language', key: 'language', kind: 'stringOrNull', flag: '--language', since: 1 },
  { path: 'generate.exact', key: 'exact', kind: 'boolean', flag: '--exact', since: 1 },
  { path: 'generate.bridgeGap', key: 'bridgeGap', kind: 'count', flag: '--bridge-gap', since: 1 },
  { path: 'generate.parents.min', key: 'minParents', kind: 'count', flag: '--min-parents', since: 1 },
  { path: 'generate.parents.max', key: 'maxParents', kind: 'countOrAll', flag: '--parents', since: 1 },
  { path: 'generate.parents.detail.base', key: 'parentDetailBase', kind: 'count', flag: '--parent-detail', since: 1 },
  { path: 'generate.parents.required', key: 'parentsRequired', kind: 'boolean', flag: '--require-parents', since: 1 },
  { path: 'generate.siblings.min', key: 'minSiblings', kind: 'count', flag: '--min-siblings', since: 1 },
  { path: 'generate.siblings.max', key: 'maxSiblings', kind: 'count', flag: '--siblings', since: 1 },
  { path: 'generate.siblings.detail.base', key: 'siblingDetailBase', kind: 'count', flag: '--sibling-detail', since: 1 },
  { path: 'generate.base.head', key: 'baseHead', kind: 'boolean', flag: '--head', since: 2 },
  { path: 'generate.base.branch', key: 'baseBranch', kind: 'stringOrNull', flag: '--branch', since: 2 },
  { path: 'generate.base.commit', key: 'baseCommit', kind: 'stringOrNull', flag: '--commit', since: 2 },
  { path: 'generate.base.eol', key: 'baseEol', kind: 'eol', flag: '--eol', since: 2 },
];

/** A key a released schema had and a later one dropped. No setting reads it any more,
 *  but a file or a request that still names one is told which schemas had it and what
 *  took its place — `since: null` stays for a key no schema ever had. */
export interface RetiredField {
  readonly path: string;
  readonly since: number;
  readonly until: number;
  readonly instead: string;
}

const RETIRED_FIELDS: readonly RetiredField[] = [
  {
    path: 'generate.mirror',
    since: 1,
    until: 1,
    instead: '"upstream": "." keeps the patches in the same tree under generate.out',
  },
];

export const RETIRED_BY_PATH = new Map(RETIRED_FIELDS.map((f) => [f.path, f]));

/** Whether the settings name the old version in git — any coordinate is the ask. */
export function basesOnGit(settings: GenerateSettings): boolean {
  return settings.baseHead || settings.baseBranch !== null || settings.baseCommit !== null;
}

/** `generate.base` as git takes it. No `path`: the base is the file being worked on, and
 *  which file that is names one run, not the project (C6). */
export function gitSourceOf(settings: GenerateSettings): GitSource {
  return { branch: settings.baseBranch ?? undefined, commit: settings.baseCommit ?? undefined, eol: settings.baseEol };
}

export const DEFAULT_SETTINGS: GenerateSettings = Object.freeze({
  ...DEFAULT_SYNTH_LIMITS,
  upstream: null,
  out: null,
  language: null,
  exact: false,
  bridgeGap: 0,
  baseHead: false,
  baseBranch: null,
  baseCommit: null,
  baseEol: 'repository',
});

export const GROUP_PATHS = new Set(
  FIELDS.flatMap((f) => {
    const parts = f.path.split('.');
    return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('.'));
  }),
);

export const FIELD_BY_PATH = new Map(FIELDS.map((f) => [f.path, f]));
export const FIELD_BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

export function knownConfigKeys(): string[] {
  return FIELDS.map((f) => f.path);
}

/** The keys of config schema `version`, in schema order — the ONE list the template,
 *  the loader and the version summaries are built from. */
export function fieldsOf(version: number): FieldSpec[] {
  return FIELDS.filter((f) => f.since <= version && (f.until === undefined || version <= f.until));
}

/** Every version in the range, oldest first, with one line of what it holds. */
export function schemaVersions(): { version: number; summary: string }[] {
  const out: { version: number; summary: string }[] = [];
  for (let v = CONFIG_MIN; v <= CONFIG_VERSION; v++) out.push({ version: v, summary: schemaSummary(v) });
  return out;
}

/** `v1: generate: out, mirror (added in 0.2.0 without a bump), language, …` */
export function schemaSummary(version: number): string {
  const groups = new Map<string, string[]>();
  for (const f of fieldsOf(version)) {
    const parts = f.path.split('.');
    // a top-level key (`upstream`) stands on its own
    const [group, name] = parts.length === 1 ? ['', parts[0]!] : [parts[0]!, parts.slice(1).join('.')];
    const shown = name + (f.unbumpedIn !== undefined ? ` (added in ${f.unbumpedIn} without a bump)` : '');
    groups.set(group, [...(groups.get(group) ?? []), shown]);
  }
  return `v${version}: ${[...groups].map(([g, names]) => (g === '' ? names.join(', ') : `${g}: ${names.join(', ')}`)).join('; ')}`;
}

/** Every schema in the range is read; outside it the message says WHICH side is behind —
 *  a config from a newer sir asks for an update, not for its own deletion (C5). */
export function checkSchemaVersion(value: unknown, file: string | undefined): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ConfigError(
      `"version" must be a whole number, the config schema version — this sir reads ${configRange()} ` +
        `(got ${JSON.stringify(value)})`,
      file,
    );
  }
  if (value > CONFIG_VERSION) {
    throw new ConfigError(
      `"version" ${value} is a config schema this sir does not know yet — it reads ${configRange()}: ` +
        'update sir, or write the config for the schema this one reads',
      file,
    );
  }
  if (value < CONFIG_MIN) {
    throw new ConfigError(
      `"version" ${value} is a config schema this sir no longer reads — it reads ${configRange()}: ` +
        `move the file to v${CONFIG_VERSION}`,
      file,
    );
  }
  return value;
}

/** Keys that exist in some schema, or none, but not in `version` — all of them in one
 *  error, each with the schemas it belongs to. `since: null` — no schema has it. */
export function checkKeysOf(paths: readonly string[], version: number, file: string | undefined): void {
  const allowed = new Set(fieldsOf(version).map((f) => f.path));
  const outside = paths.filter((p) => !allowed.has(p));
  if (outside.length === 0) return;
  const keys = outside.map((path) => {
    const spec = FIELD_BY_PATH.get(path) ?? RETIRED_BY_PATH.get(path);
    return { path, since: spec?.since ?? null, until: spec?.until ?? null };
  });
  const named = keys.map((k) => {
    const instead = RETIRED_BY_PATH.get(k.path)?.instead;
    if (k.since === null) return `${k.path} (no such key)`;
    if (k.until !== null && k.until < version) {
      return `${k.path} (v${k.since}–v${k.until}${instead !== undefined ? `; ${instead}` : ''})`;
    }
    return `${k.path} (since v${k.since})`;
  });
  throw new ConfigError(
    `not in config schema v${version}: ${named.join(', ')}\n  v${version} keys: ${fieldsOf(version)
      .map((f) => f.path)
      .join(', ')}`,
    file,
    { version, keys },
  );
}

export function checkValue(value: unknown, spec: FieldSpec, file: string | undefined): unknown {
  const bad = (expected: string): never => {
    throw new ConfigError(`"${spec.path}" must be ${expected} (got ${JSON.stringify(value) ?? 'undefined'})`, file);
  };
  switch (spec.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? value : bad('true or false');
    case 'count':
      return isCount(value) ? value : bad('a non-negative integer');
    case 'countOrAll':
      return value === 'all' || isCount(value) ? value : bad('a non-negative integer or "all"');
    case 'eol':
      return GIT_EOLS.includes(value as GitEol) ? value : bad(GIT_EOLS.map((e) => `"${e}"`).join(' or '));
    case 'stringOrNull':
      if (value === null) return null;
      return typeof value === 'string' && value.trim() !== '' ? value : bad('a non-empty string or null');
  }
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1000;
}

export function checkPairs(settings: GenerateSettings, origins: Record<string, string>): void {
  if (settings.upstream === null) return;

  const where = (path: string): string => `${path} (${origins[path] ?? 'default'})`;
  if (settings.out === null) {
    throw new ConfigError(
      `${where('upstream')} keeps the patches in a tree of their own: set ${where('generate.out')} to a directory`,
    );
  }
  if (settings.out === '-') {
    throw new ConfigError(`${where('upstream')} writes a tree of files, so ${where('generate.out')} cannot be "-"`);
  }
}
