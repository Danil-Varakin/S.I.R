import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isFile, isRepoRoot, upwards } from '../fs.ts';
import { ConfigError } from '../../core/errors.ts';
import {
  DEFAULT_SETTINGS,
  FIELDS,
  FIELD_BY_KEY,
  FIELD_BY_PATH,
  RETIRED_BY_PATH,
  GROUP_PATHS,
  checkKeysOf,
  checkPairs,
  checkSchemaVersion,
  checkValue,
  knownConfigKeys,
} from './schema.ts';
import type { FieldSpec, GenerateSettings, PartialSettings } from './schema.ts';
import { CONFIG_VERSION } from './schema.ts';

export const CONFIG_FILE_NAME = 'sir.config.json';

export interface ResolvedConfig {
  readonly version: number;
  readonly generate: GenerateSettings;
  readonly file: string | undefined;
  readonly schemaVersion: number | null;
  readonly origins: Readonly<Record<string, string>>;
}

export interface FlagOverride {
  readonly key: keyof GenerateSettings;
  readonly value: unknown;
  readonly flag: string;
}

export function overridesFrom(
  values: PartialSettings,
  label: (spec: FieldSpec) => string,
): FlagOverride[] {
  const out: FlagOverride[] = [];
  for (const spec of FIELDS) {
    const value = values[spec.key];
    if (value !== undefined) out.push({ key: spec.key, value, flag: label(spec) });
  }
  return out;
}

export function findConfigFile(startDir: string): string | undefined {
  const last = configCandidates(startDir).at(-1);
  return last !== undefined && isFile(last) ? last : undefined;
}

export function configCandidates(startDir: string): string[] {
  const out: string[] = [];
  for (const dir of upwards(startDir)) {
    const candidate = join(dir, CONFIG_FILE_NAME);
    out.push(candidate);
    if (isFile(candidate) || isRepoRoot(dir)) break;
  }
  return out;
}

export function readConfigFile(file: string): PartialSettings {
  return readConfigFileVersioned(file).settings;
}

function readConfigFileVersioned(file: string): { settings: PartialSettings; version: number } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new ConfigError(`cannot read config: ${(e as Error).message}`, file);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`invalid JSON: ${(e as Error).message}`, file);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError('config must be a JSON object', file);
  }

  return readVersioned(parsed as Record<string, unknown>, file);
}

export function readSettings(parsed: Readonly<Record<string, unknown>>, file: string | undefined): PartialSettings {
  return readVersioned(parsed, file).settings;
}

function readVersioned(
  parsed: Readonly<Record<string, unknown>>,
  file: string | undefined,
): { settings: PartialSettings; version: number } {
  const version = 'version' in parsed ? checkSchemaVersion(parsed['version'], file) : CONFIG_VERSION;
  const found = new Map<string, unknown>();
  for (const [key, value] of Object.entries(parsed)) {
    if (key === '$schema' || key === 'version') continue;
    collect(value, key, found, file);
  }
  checkKeysOf([...found.keys()], version, file);
  const out: PartialSettings = {};
  for (const [path, value] of found) {
    const spec = FIELD_BY_PATH.get(path)!;
    Object.assign(out, { [spec.key]: checkValue(value, spec, file) });
  }
  return { settings: out, version };
}

function collect(node: unknown, path: string, out: Map<string, unknown>, file: string | undefined): void {
  if (FIELD_BY_PATH.has(path)) {
    out.set(path, node);
    return;
  }
  const retired = RETIRED_BY_PATH.get(path);
  if (retired !== undefined) throw new ConfigError(`"${path}" is gone: ${retired.instead}`, file);
  if (!GROUP_PATHS.has(path)) {
    throw new ConfigError(`unknown key "${path}"\n  known keys: ${knownConfigKeys().join(', ')}`, file);
  }
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    throw new ConfigError(`"${path}" must be an object`, file);
  }
  for (const [key, value] of Object.entries(node)) collect(value, `${path}.${key}`, out, file);
}

export function resolveConfig(options: {
  file?: string | undefined;
  schemaVersion?: number | undefined;
  fromFile?: PartialSettings | undefined;
  flags?: readonly FlagOverride[] | undefined;
}): ResolvedConfig {
  const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  const origins: Record<string, string> = {};
  for (const spec of FIELDS) origins[spec.path] = 'default';

  const fileOrigin = options.file !== undefined ? `config ${options.file}` : 'config';

  for (const [key, value] of Object.entries(options.fromFile ?? {})) {
    if (value === undefined) continue;
    const spec = FIELD_BY_KEY.get(key as keyof GenerateSettings);
    if (spec === undefined) continue;
    settings[key] = value;
    origins[spec.path] = fileOrigin;
  }

  for (const override of options.flags ?? []) {
    if (override.value === undefined) continue;
    const spec = FIELD_BY_KEY.get(override.key);
    if (spec === undefined) throw new ConfigError(`internal: no config field for flag ${override.flag}`);
    settings[override.key] = checkValue(override.value, spec, undefined);
    origins[spec.path] = `flag ${override.flag}`;
  }

  checkPairs(settings as unknown as GenerateSettings, origins);

  return Object.freeze({
    version: CONFIG_VERSION,
    generate: Object.freeze(settings) as unknown as GenerateSettings,
    file: options.file,
    schemaVersion: options.file !== undefined ? (options.schemaVersion ?? CONFIG_VERSION) : null,
    origins: Object.freeze(origins),
  });
}

export function loadConfig(options: {
  explicitPath?: string | undefined;
  startDir: string;
  useFile: boolean;
  flags?: readonly FlagOverride[] | undefined;
}): ResolvedConfig {
  const flags = options.flags;
  if (!options.useFile) return resolveConfig({ flags });

  let file: string | undefined;
  if (options.explicitPath !== undefined) {
    file = resolve(options.explicitPath);
    if (!isFile(file)) throw new ConfigError('no such config file', file);
  } else {
    file = findConfigFile(options.startDir);
  }
  if (file === undefined) return resolveConfig({ flags });
  const read = readConfigFileVersioned(file);
  return resolveConfig({ file, schemaVersion: read.version, fromFile: read.settings, flags });
}

export function formatConfig(config: ResolvedConfig): string {
  const width = Math.max(...FIELDS.map((f) => f.path.length));
  const lines = [`version = ${config.version}`, `file    = ${config.file ?? '(none)'}`];
  for (const spec of FIELDS) {
    const value = JSON.stringify(config.generate[spec.key]);
    lines.push(`${spec.path.padEnd(width)} = ${value.padEnd(6)}  [${config.origins[spec.path]}]`);
  }
  return lines.join('\n') + '\n';
}
