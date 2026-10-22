import { basename, dirname, extname, join, resolve } from 'node:path';
import { ConfigError } from '../core/errors.ts';
import { formatSide, isContainedPath, readHeader } from '../core/header.ts';
import { isFile, pathWithin, readIfReadable, repoRootAround, toPosixPath } from './fs.ts';
import { PATCH_EXTENSION, resolveOutPath } from './out-path.ts';
import { patchTreeRoot, upstreamCode, upstreamTarget, withUpstream } from './project.ts';
import type { Project, UpstreamProject } from './project.ts';

// A file of code and its patch, both ways. Forward is `resolveOutPath` — the very
// function `generate` names `outPath` with — and backward undoes exactly what it does;
// the `Target` in the header of a .sirp comes first, since it names the file outright.
// With an upstream (`infra/project.ts`) `Target` is measured from the upstream root;
// without one, from the repository around the patch.

/** What `generate` writes into `Target` of a patch at `patchPath` for `codePath` without
 *  an upstream, or undefined when the file is not under the root — a path out of it
 *  would be one no reader accepts. */
export function targetFor(patchPath: string, codePath: string): string | undefined {
  const inside = pathWithin(repoRootAround(patchPath), resolve(codePath));
  if (inside === undefined || inside === '') return undefined;
  return toPosixPath(inside);
}

/** `Target` for the patch of `codePath`: from the upstream root when the project has
 *  one — wherever the patch goes, stdout included — else from the repository around the
 *  patch, and none without a place for it. */
export function patchTarget(project: Project | undefined, patchPath: string | undefined, codePath: string): string | undefined {
  const upstream = withUpstream(project);
  if (upstream !== undefined) return upstreamTarget(upstream, codePath);
  return patchPath !== undefined ? targetFor(patchPath, codePath) : undefined;
}

export interface PairSettings {
  readonly out: string | null;
  /** the project, when an upstream decides the layout */
  readonly project?: Project | undefined;
}

/** Why a pair could not be named. Part of the protocol: a client may switch on it. */
export type PairReason =
  | 'no-out'
  | 'outside-upstream'
  | 'flat-out'
  | 'outside-out'
  | 'not-a-patch-name'
  | 'unsafe-target'
  | 'two-patches'
  /** the patch is of a format newer than this sir reads: update sir (H3) */
  | 'newer-format'
  /** older than this sir still reads: regenerate the patch (H3) */
  | 'older-format'
  /** the header does not read: a line that is not `Name: value`, a field twice or out
   *  of its place, `Sir` not a number */
  | 'bad-header';

export type CodeLayout = 'upstream' | 'beside' | 'out';

export type Pair =
  | {
      readonly kind: 'code';
      readonly patchPath: string | null;
      readonly exists: boolean;
      readonly how: CodeLayout | null;
      readonly reason?: PairReason;
      /** `two-patches`: both of them — one file, one patch (P7) */
      readonly patchPaths?: readonly string[];
    }
  | {
      readonly kind: 'patch';
      readonly code: string | null;
      readonly exists: boolean;
      readonly how: 'target' | CodeLayout | null;
      readonly reason?: PairReason;
    };

/** A path ending in `.sirp` is a patch; anything else is code. */
export function isPatchPath(path: string): boolean {
  return extname(path).toLowerCase() === PATCH_EXTENSION;
}

export function pairOf(path: string, settings: PairSettings, patch?: string): Pair {
  return isPatchPath(path) ? codeOf(resolve(path), settings, patch) : patchOf(resolve(path), settings);
}

function upstreamOf(settings: PairSettings): UpstreamProject | undefined {
  return withUpstream(settings.project);
}

function layoutOf(settings: PairSettings): CodeLayout {
  return upstreamOf(settings) !== undefined ? 'upstream' : settings.out === null ? 'beside' : 'out';
}

function patchOf(codePath: string, settings: PairSettings): Pair {
  const upstream = upstreamOf(settings);
  if (upstream === undefined && settings.out === '-') {
    return { kind: 'code', patchPath: null, exists: false, how: null, reason: 'no-out' };
  }
  let patchPath: string | undefined;
  try {
    patchPath = resolveOutPath({ inPath: codePath, out: settings.out, project: upstream }).path;
  } catch (e) {
    // a file outside the upstream: the one way resolveOutPath fails on settings the
    // loader has already accepted
    if (e instanceof ConfigError) {
      return { kind: 'code', patchPath: null, exists: false, how: null, reason: 'outside-upstream' };
    }
    throw e;
  }
  if (patchPath === undefined) return { kind: 'code', patchPath: null, exists: false, how: null, reason: 'no-out' };

  // One file, one patch: a patch left beside the file after `out` moved is a second one.
  const beside = `${codePath}${PATCH_EXTENSION}`;
  if (beside !== patchPath && isFile(beside) && isFile(patchPath)) {
    return { kind: 'code', patchPath: null, exists: false, how: null, reason: 'two-patches', patchPaths: [patchPath, beside] };
  }
  return { kind: 'code', patchPath, exists: isFile(patchPath), how: layoutOf(settings) };
}

function codeOf(patchPath: string, settings: PairSettings, patch: string | undefined): Pair {
  const refused = (reason: PairReason): Pair => ({ kind: 'patch', code: null, exists: false, how: null, reason });
  const upstream = upstreamOf(settings);
  const header = targetOf(patch ?? readOrEmpty(patchPath));
  if ('refused' in header) return refused(header.refused);
  const target = header.target;
  if (target !== undefined) {
    const code = upstream !== undefined ? upstreamCode(upstream, target) : join(repoRootAround(patchPath), ...target.split(/[\\/]/));
    if (code === undefined) return refused('unsafe-target');
    return { kind: 'patch', code, exists: isFile(code), how: 'target' };
  }

  const name = basename(patchPath).slice(0, -PATCH_EXTENSION.length);
  if (name === '') return refused('not-a-patch-name');

  const how = layoutOf(settings);
  let code: string;
  if (upstream !== undefined) {
    // the tree under <project root>/<out> repeats the upstream's
    const within = pathWithin(patchTreeRoot(upstream, settings.out ?? ''), patchPath);
    if (within === undefined || within === '') return refused('outside-out');
    code = join(upstream.upstreamRoot, within.slice(0, -PATCH_EXTENSION.length));
  } else if (how === 'beside') {
    code = join(dirname(patchPath), name);
  } else {
    // one directory (or one file) for every patch: where the file was is not kept
    return refused(settings.out === '-' ? 'no-out' : 'flat-out');
  }
  // Checked forward: only a path `generate` would write this patch for is its code.
  let forward: string | undefined;
  try {
    forward = resolveOutPath({ inPath: code, out: settings.out, project: upstream }).path;
  } catch {
    forward = undefined;
  }
  if (forward !== patchPath) return refused(upstream !== undefined ? 'outside-out' : 'not-a-patch-name');
  return { kind: 'patch', code, exists: isFile(code), how };
}

/** `Target` from the header (undefined without one), or why the header names no file:
 *  each way it can fail is its own reason, the format first — a patch from a newer sir
 *  says "update sir", not "unsafe". */
function targetOf(text: string): { readonly target: string | undefined } | { readonly refused: PairReason } {
  let header;
  try {
    header = readHeader(text);
  } catch {
    return { refused: 'bad-header' };
  }
  const side = formatSide(header.format);
  if (side !== undefined) return { refused: side === 'newer' ? 'newer-format' : 'older-format' };
  const target = header.fields.get('target');
  if (target !== undefined && !isContainedPath(target)) return { refused: 'unsafe-target' };
  return { target };
}

/** What lies at `path` where a patch is about to be written: whether a file does, and
 *  the `Target` it names (null for none, or a file that is not a patch that parses). */
export function patchAt(path: string): { readonly exists: boolean; readonly target: string | null } {
  if (!isFile(path)) return { exists: false, target: null };
  const header = targetOf(readOrEmpty(path));
  return { exists: true, target: 'target' in header ? header.target ?? null : null };
}

/** No file, or one that cannot be read, has no header: `readHeader('')` is a header with
 *  no fields, which `targetOf` reads as "names no Target". */
function readOrEmpty(path: string): string {
  return readIfReadable(path) ?? '';
}
