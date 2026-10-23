import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { ConfigError } from '../core/errors.ts';
import { kindOf, repoRootAround } from './fs.ts';
import { patchTreeRoot, upstreamTarget, withUpstream } from './project.ts';
import type { Project, UpstreamProject } from './project.ts';

export const PATCH_EXTENSION = '.sirp';

export interface OutPathInput {
  readonly inPath: string;
  readonly out: string | null;
  readonly project?: Project | undefined;
  readonly suffix?: string;
}

export interface OutPath {
  readonly path: string | undefined;
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
  if (input.suffix === undefined && extname(target).toLowerCase() !== PATCH_EXTENSION) {
    throw new ConfigError(
      `generate.out (--out) names the file ${target}: a patch is a ${PATCH_EXTENSION} file — ` +
        `name it ${basename(target, extname(target))}${PATCH_EXTENSION}, or give a directory`,
    );
  }
  return { path: target };
}

function inUpstream(project: UpstreamProject, out: string | null, inPath: string): OutPath {
  if (out === null || out === '-') {
    throw new ConfigError('upstream keeps the patches in a tree of their own: generate.out must name a directory', project.configFile);
  }
  const target = upstreamTarget(project, inPath);
  if (!/[/\\]$/.test(out) && extname(out).toLowerCase() === PATCH_EXTENSION) return { path: patchTreeRoot(project, out), target };
  return { path: join(patchTreeRoot(project, out), ...target.split('/')) + PATCH_EXTENSION, target };
}

function namesDirectory(out: string, target: string): boolean {
  if (/[/\\]$/.test(out)) return true;
  const kind = kindOf(target);
  return kind === undefined ? extname(basename(out)) === '' : kind === 'directory';
}
