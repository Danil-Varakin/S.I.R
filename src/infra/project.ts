import { readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { ConfigError } from '../core/errors.ts';
import { isContainedPath } from '../core/header.ts';
import { isDirectory, isFile, isRepoRoot, pathWithin, toPosixPath, upwards } from './fs.ts';
import { CONFIG_FILE_NAME, configCandidates, loadConfig } from './config/load.ts';
import type { FlagOverride, ResolvedConfig } from './config/load.ts';

export const CONFIG_ENV = 'SIR_CONFIG';

export interface Project {
  readonly configFile: string | undefined;
  readonly projectRoot: string | undefined;
  readonly upstreamRoot: string | null;
}

export interface UpstreamProject extends Project {
  readonly configFile: string;
  readonly projectRoot: string;
  readonly upstreamRoot: string;
}

export function withUpstream(project: Project | undefined): UpstreamProject | undefined {
  return project !== undefined && project.upstreamRoot !== null ? (project as UpstreamProject) : undefined;
}

export interface ConfigSearch {
  readonly explicitPath?: string | undefined;
  readonly cwd?: string | undefined;
  readonly isPatch?: boolean;
}

export function configFileFor(path: string, search: ConfigSearch = {}): string | undefined {
  if (search.explicitPath !== undefined) {
    const file = resolve(search.explicitPath);
    if (!isFile(file)) throw new ConfigError('no such config file', file);
    return file;
  }
  const nearest = configCandidates(dirname(path)).at(-1);
  if (nearest !== undefined && isFile(nearest)) return nearest;
  if (search.isPatch === true) return envConfig();

  const claims = claimsOn(path);
  if (claims.length > 1) {
    throw new ConfigError(
      `${claims.length} configs claim ${path} — their upstream holds it:\n` +
        claims.map((c) => `  ${c}`).join('\n') +
        `\n  name one with --config (or ${CONFIG_ENV})`,
    );
  }
  if (claims.length === 1) return claims[0];

  const env = envConfig();
  if (env !== undefined) return env;
  if (search.cwd !== undefined) {
    const here = join(resolve(search.cwd), CONFIG_FILE_NAME);
    if (isFile(here) && claimsFile(here, path)) return here;
  }
  return undefined;
}

function envConfig(): string | undefined {
  const named = process.env[CONFIG_ENV];
  if (named === undefined || named === '') return undefined;
  const file = resolve(named);
  if (!isFile(file)) throw new ConfigError(`no such config file (${CONFIG_ENV})`, file);
  return file;
}

function claimsOn(path: string): string[] {
  const out: string[] = [];
  let pastRepo = false;
  for (const dir of upwards(dirname(path))) {
    if (pastRepo && claimsFile(join(dir, CONFIG_FILE_NAME), path)) out.push(join(dir, CONFIG_FILE_NAME));
    if (!isRepoRoot(dir)) continue;
    pastRepo = true;
    for (const sub of subdirectories(dir)) {
      const candidate = join(dir, sub, CONFIG_FILE_NAME);
      if (claimsFile(candidate, path)) out.push(candidate);
    }
  }
  return [...new Set(out)];
}

function subdirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== '.git' && e.name !== 'node_modules')
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function claimsFile(file: string, path: string): boolean {
  const upstream = upstreamIn(file);
  if (upstream === undefined) return false;
  const inside = pathWithin(resolve(dirname(file), upstream), path);
  return inside !== undefined && inside !== '';
}

function upstreamIn(file: string): string | undefined {
  if (!isFile(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { upstream?: unknown };
    return typeof parsed.upstream === 'string' && parsed.upstream !== '' ? parsed.upstream : undefined;
  } catch {
    return undefined;
  }
}

export function projectOf(config: ResolvedConfig): Project {
  const file = config.file;
  const upstream = config.generate.upstream;
  if (upstream === null) return { configFile: file, projectRoot: file === undefined ? undefined : dirname(file), upstreamRoot: null };
  if (file === undefined) {
    throw new ConfigError('upstream is measured from the config file, and there is none');
  }
  const root = resolve(dirname(file), upstream);
  if (!isDirectory(root)) throw new ConfigError(`upstream "${upstream}" names no directory: ${root}`, file);
  return { configFile: file, projectRoot: dirname(file), upstreamRoot: root };
}

export interface LoadedProject {
  readonly config: ResolvedConfig;
  readonly project: Project;
}

export function loadProject(options: {
  readonly path: string | undefined;
  readonly search?: ConfigSearch;
  readonly useFile: boolean;
  readonly flags?: readonly FlagOverride[] | undefined;
}): LoadedProject {
  const { path, search = {} } = options;
  let explicitPath: string | undefined;
  if (options.useFile) explicitPath = path !== undefined ? configFileFor(resolve(path), search) : search.explicitPath;
  const config = loadConfig({ explicitPath, startDir: search.cwd ?? process.cwd(), useFile: explicitPath !== undefined, flags: options.flags });
  return { config, project: projectOf(config) };
}

export function upstreamTarget(project: UpstreamProject, code: string): string {
  const inside = pathWithin(project.upstreamRoot, resolve(code));
  if (inside === undefined || inside === '') {
    throw new ConfigError(
      `${resolve(code)} is outside upstream ${project.upstreamRoot}: the project patches only the code under it`,
      project.configFile,
    );
  }
  return toPosixPath(inside);
}

export function upstreamCode(project: UpstreamProject, target: string): string | undefined {
  if (!isContainedPath(target)) return undefined;
  return join(project.upstreamRoot, ...target.split(/[\\/]/));
}

export function patchTreeRoot(project: UpstreamProject, out: string): string {
  return isAbsolute(out) ? out : join(project.projectRoot, out);
}
