import { readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { ConfigError } from '../core/errors.ts';
import { isContainedPath } from '../core/header.ts';
import { isDirectory, isFile, isRepoRoot, pathWithin, toPosixPath, upwards } from './fs.ts';
import { CONFIG_FILE_NAME, configCandidates, loadConfig } from './config/load.ts';
import type { FlagOverride, ResolvedConfig } from './config/load.ts';

// The ONE place that decides whose a file is: which sir.config.json speaks for it,
// and — with `upstream` — where the code it patches lives.
//
// A project may patch code it does not own: Brave keeps its patches in src/brave and
// patches Chromium around it, which commits nowhere. Its config says so with
// `"upstream": ".."`, the root of that code measured from the config file. The patch of
// src/chrome/browser/ui/browser.h is then src/brave/<out>/chrome/browser/ui/browser.h.sirp
// and its `Target` is chrome/browser/ui/browser.h.
//
// The config of a file of code is looked for:
//   1. up from the file to the root of its git repository — a project of one repository;
//   2. else a config that CLAIMS the file — its `upstream` holds it — in the immediate
//      subdirectories of every repository root on the way up (src/*/sir.config.json),
//      and in the directories above the first repository root (the upstream inside the
//      project);
//   3. else SIR_CONFIG, else a config in the current directory that claims the file.
// Two claims are an error that names both. `--config` (the protocol's `configPath`)
// comes before all of it. A patch finds its config up from itself, as step 1.

export const CONFIG_ENV = 'SIR_CONFIG';

/** Where a project lies. `upstreamRoot` null: the code is in the project's own tree, and
 *  paths are as they always were — beside the file, or under `out`. */
export interface Project {
  readonly configFile: string | undefined;
  /** the directory of the config file; `out` is measured from it with an upstream */
  readonly projectRoot: string | undefined;
  readonly upstreamRoot: string | null;
}

/** A project over an upstream: its config file, and so its root, are there by
 *  construction (`projectOf`). */
export interface UpstreamProject extends Project {
  readonly configFile: string;
  readonly projectRoot: string;
  readonly upstreamRoot: string;
}

/** `project` when it has an upstream, else undefined. */
export function withUpstream(project: Project | undefined): UpstreamProject | undefined {
  return project !== undefined && project.upstreamRoot !== null ? (project as UpstreamProject) : undefined;
}

export interface ConfigSearch {
  /** `--config`, `configPath`: taken as is, no search */
  readonly explicitPath?: string | undefined;
  /** where the run was started; its config counts only when it claims the file */
  readonly cwd?: string | undefined;
  /** `true` for a patch: its config is up from it, never a claim */
  readonly isPatch?: boolean;
}

/** The config file for `path` (absolute), or undefined when nothing speaks for it. */
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

/** Every config the search of step 2 meets that claims `path`, nearest first. */
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

/** Whether the config at `file` names an upstream that holds `path`. A config that does
 *  not read is no claim: the one that does is what the error would be about. */
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

/** The project a resolved config describes. */
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

/** The config that speaks for `path` (a file of code or a patch), with `flags` over it,
 *  and the project it describes. */
export function loadProject(options: {
  readonly path: string | undefined;
  readonly search?: ConfigSearch;
  readonly useFile: boolean;
  readonly flags?: readonly FlagOverride[] | undefined;
}): LoadedProject {
  const { path, search = {} } = options;
  let explicitPath: string | undefined;
  if (options.useFile) explicitPath = path !== undefined ? configFileFor(resolve(path), search) : search.explicitPath;
  // nothing found: no file is read, whatever lies around the working directory
  const config = loadConfig({ explicitPath, startDir: search.cwd ?? process.cwd(), useFile: explicitPath !== undefined, flags: options.flags });
  return { config, project: projectOf(config) };
}

/** `Target` of `code` in a project with an upstream: its path from the upstream root,
 *  with `/`. A file outside the upstream is refused — its patch would have no place. */
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

/** The file a `Target` names in a project with an upstream, or undefined for a path out
 *  of it. */
export function upstreamCode(project: UpstreamProject, target: string): string | undefined {
  if (!isContainedPath(target)) return undefined;
  return join(project.upstreamRoot, ...target.split(/[\\/]/));
}

/** `<project root>/<out>` — the root of the patch tree with an upstream. */
export function patchTreeRoot(project: UpstreamProject, out: string): string {
  return isAbsolute(out) ? out : join(project.projectRoot, out);
}
