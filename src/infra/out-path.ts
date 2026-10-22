import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { ConfigError } from '../core/errors.ts';
import { kindOf, repoRootAround } from './fs.ts';
import { patchTreeRoot, upstreamTarget, withUpstream } from './project.ts';
import type { Project, UpstreamProject } from './project.ts';

/** The file name of a patch: the code's own name and this. */
export const PATCH_EXTENSION = '.sirp';

export interface OutPathInput {
  readonly inPath: string;
  readonly out: string | null;
  /** a project with an upstream: the patch tree is `<project root>/<out>/<Target>.sirp` */
  readonly project?: Project | undefined;
  readonly suffix?: string;
}

export interface OutPath {
  readonly path: string | undefined;
  /** with an upstream: the file's path from the upstream root — the patch's `Target` */
  readonly target?: string;
}

export function resolveOutPath(input: OutPathInput): OutPath {
  const inPath = resolve(input.inPath);
  const name = `${basename(inPath)}${input.suffix ?? PATCH_EXTENSION}`;

  const upstream = withUpstream(input.project);
  if (upstream !== undefined) return inUpstream(upstream, input.out, inPath);
  if (input.out === null) return { path: join(dirname(inPath), name) };
  if (input.out === '-') return { path: undefined };

  const target = isAbsolute(input.out) ? input.out : join(repoRootAround(inPath), input.out);
  if (namesDirectory(input.out, target)) return { path: join(target, name) };
  // A file named outright: for a patch it must be one `apply` and `pair` take back.
  if (input.suffix === undefined && extname(target).toLowerCase() !== PATCH_EXTENSION) {
    throw new ConfigError(
      `generate.out (--out) names the file ${target}: a patch is a ${PATCH_EXTENSION} file — ` +
        `name it ${basename(target, extname(target))}${PATCH_EXTENSION}, or give a directory`,
    );
  }
  return { path: target };
}

/** With an upstream `out` is the root of a tree that repeats the upstream's: the config
 *  loader has made sure it names a directory. */
function inUpstream(project: UpstreamProject, out: string | null, inPath: string): OutPath {
  if (out === null || out === '-') {
    throw new ConfigError('upstream keeps the patches in a tree of their own: generate.out must name a directory', project.configFile);
  }
  const target = upstreamTarget(project, inPath);
  // one patch named outright (`--out x.sirp`) instead of its place in the tree
  if (!/[/\\]$/.test(out) && extname(out).toLowerCase() === PATCH_EXTENSION) return { path: patchTreeRoot(project, out), target };
  return { path: join(patchTreeRoot(project, out), ...target.split('/')) + PATCH_EXTENSION, target };
}

/** Whether `out` names a directory to put the patch in, rather than the file itself: a
 *  trailing slash says so outright, then what is on disk, and for a path that is not
 *  there yet — the absence of an extension. */
function namesDirectory(out: string, target: string): boolean {
  if (/[/\\]$/.test(out)) return true;
  const kind = kindOf(target);
  return kind === undefined ? extname(basename(out)) === '' : kind === 'directory';
}
