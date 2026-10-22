import { join, resolve } from 'node:path';
import { ConfigError } from '../../core/errors.ts';
import { findRepoRoot } from '../fs.ts';
import { CONFIG_FILE_NAME, readSettings, resolveConfig } from './load.ts';
import { CONFIG_VERSION, FIELD_BY_PATH, GROUP_PATHS, checkKeysOf, checkSchemaVersion, fieldsOf } from './schema.ts';

// The text of a new sir.config.json, for `sir init` and the service's
// `configTemplate` alike: the schema belongs to the core, so nobody else keeps a copy.
// Only what was asked for is written — a default spelt out in the file would pin it,
// and a later change of that default would quietly not reach the project.

const REPO = 'https://raw.githubusercontent.com/Danil-Varakin/S.I.R';

/** The release each config schema's own file first shipped in. A pushed tag never moves
 *  (P7), so the file read from it is frozen by git itself: a v1 config is checked
 *  against v1 as released, whatever `main` holds later. A row is added in the release
 *  that ships the version (VERSIONING.md §5). */
export const SCHEMA_RELEASED_IN: Readonly<Record<number, string>> = { 3: 'v0.5.0' };

/** The JSON Schema of config schema `version`: from its release tag, or from `main`
 *  while the version is not released yet. */
export function schemaUrl(version: number): string {
  return `${REPO}/${SCHEMA_RELEASED_IN[version] ?? 'main'}/schemas/sir.config.v${version}.schema.json`;
}

/** Where the core itself would look for a config from `startDir`: the repository root,
 *  outside a repository `startDir` itself. */
export function suggestedConfigPath(startDir: string): string {
  return join(findRepoRoot(startDir) ?? resolve(startDir), CONFIG_FILE_NAME);
}

export interface ConfigTemplate {
  readonly text: string;
  readonly version: number;
}

/** `settings` in the paths of the config — nested (`{ generate: { out } }`), dotted
 *  (`{ "generate.out": … }`) or both. The text it returns reads back, through the loader,
 *  to exactly these settings. */
export function configTemplate(options: { version?: unknown; settings?: unknown } = {}): ConfigTemplate {
  const version = checkSchemaVersion(options.version ?? CONFIG_VERSION, undefined);

  const leaves = new Map<string, unknown>();
  if (options.settings !== undefined) {
    if (!isObject(options.settings)) throw new ConfigError('settings must be an object of config keys');
    flatten(options.settings, '', leaves);
  }
  checkKeysOf([...leaves.keys()], version, undefined);

  const config: Record<string, unknown> = { $schema: schemaUrl(version), version };
  for (const spec of fieldsOf(version)) {
    if (!leaves.has(spec.path)) continue;
    const parts = spec.path.split('.');
    let node = config;
    for (const part of parts.slice(0, -1)) node = (node[part] ??= {}) as Record<string, unknown>;
    node[parts.at(-1)!] = leaves.get(spec.path);
  }

  // The loader's own checks, values and pairs: what it would refuse is never written.
  resolveConfig({ fromFile: readSettings(config, undefined) });

  return { text: `${JSON.stringify(config, null, 2)}\n`, version };
}

function flatten(node: Readonly<Record<string, unknown>>, prefix: string, out: Map<string, unknown>): void {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (!FIELD_BY_PATH.has(path) && GROUP_PATHS.has(path) && isObject(value)) flatten(value, path, out);
    else out.set(path, value);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
