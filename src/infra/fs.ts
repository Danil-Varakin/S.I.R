import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PathError } from '../core/errors.ts';

const REPO_MARKER = '.git';

/** The contents of a file, or undefined when there is none or it cannot be read: for the
 *  question "what lies here?", where absence is an ANSWER. A path a person named is read
 *  with `readInputFile`, which calls absence an error and names the flag it came from. */
export function readIfReadable(path: string): string | undefined {
  if (!isFile(path)) return undefined;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

export function readInputFile(path: string, argument: string): string {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new Error(`no such file: ${path} (${argument})`);
  }
  if (!stats.isFile()) throw new Error(`${argument} takes a file, and ${path} is a directory`);
  return readFileSync(path, 'utf8');
}

/** Writes through a temp file and a rename, so a run cut short never leaves half a file.
 *  A rename puts a NEW file in place, so what the old one carried is carried over by
 *  hand: its permission bits (a script stays executable), and — for a symlink — the
 *  link itself: the file it points to is written, the link stays a link. Owner, ACLs,
 *  extended attributes and hard links are not kept; a rename cannot keep them. */
export function writeFileAtomic(path: string, data: string): void {
  const target = throughLinks(path);
  const mode = modeOf(target);
  const tmp = join(dirname(target), `.${basename(target)}.sirp-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, data, 'utf8');
    if (mode !== undefined) chmodSync(tmp, mode);
    renameOver(tmp, target);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
    }
    throw e;
  }
}

/** A rename over a file somebody else holds open fails on Windows — EPERM or EBUSY, a
 *  sharing violation while that handle lives, not a refusal of the write. Two runs
 *  writing one `--out` meet exactly there, so the rename is tried again for a short
 *  while before it is given up: the promise above is that each run lands whole and one
 *  of them wins, not that a run gives up when it meets the other. Elsewhere the error
 *  is what it says and goes straight up. */
function renameOver(tmp: string, target: string): void {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      renameSync(tmp, target);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const sharing = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (process.platform !== 'win32' || !sharing || Date.now() >= deadline) throw e;
      // sync: the write is sync, and the run has nothing else to do until the file is in place
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

/** The file a path finally names, following symlinks — also to a target that does not
 *  exist yet, which the write then creates. */
function throughLinks(path: string): string {
  let at = resolve(path);
  for (let hops = 0; hops < 40; hops++) {
    let link: boolean;
    try {
      link = lstatSync(at).isSymbolicLink();
    } catch {
      return at;
    }
    if (!link) return at;
    at = resolve(dirname(at), readlinkSync(at));
  }
  throw new PathError(`${path}: too many levels of symbolic links`, path, at);
}

function modeOf(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o7777;
  } catch {
    return undefined;
  }
}

export function ensureParent(path: string): void {
  checkParent(path);
  mkdirSync(dirname(resolve(path)), { recursive: true });
}

export function checkParent(path: string): void {
  const dir = dirname(resolve(path));
  const blocker = firstNonDirectory(dir);
  if (blocker !== undefined) {
    throw new PathError(
      blocker === dir ? `cannot create ${dir}: it is a file` : `cannot create ${dir}: ${blocker} is a file`,
      dir,
      blocker,
    );
  }
}

/** `startDir` and the directories above it, nearest first — never above the home
 *  directory: from inside it the walk stops below it, from the home directory itself it
 *  stops there. The root of the file system is not one of them. */
export function* upwards(startDir: string): Generator<string> {
  const home = homedir();
  let dir = resolve(startDir);
  for (;;) {
    yield dir;
    const parent = dirname(dir);
    if (dir === home || parent === home || dirname(parent) === parent) return;
    dir = parent;
  }
}

export function findRepoRoot(startDir: string): string | undefined {
  for (const dir of upwards(startDir)) if (isRepoRoot(dir)) return dir;
  return undefined;
}

export function isRepoRoot(dir: string): boolean {
  return existsSync(join(dir, REPO_MARKER));
}

/** The root a relative path beside `file` is measured from: the repository around it,
 *  else its own directory. The writer of a patch (`out-path`) and its reader (`pair`)
 *  both ask here, so `--out` and `Target` cannot come to mean two different roots. */
export function repoRootAround(file: string): string {
  const dir = dirname(resolve(file));
  return findRepoRoot(dir) ?? dir;
}

/** Whether writing to `target` replaces the file `file` is: the same file by identity
 *  (device + inode), not by spelling — `Foo.c` and `foo.c` are one file on a
 *  case-insensitive disk. Followed through symlinks, as `writeFileAtomic` writes through
 *  them. A hard link counts as the same file, which only ever errs towards asking. */
export function replacesFile(target: string, file: string): boolean {
  try {
    const t = statSync(target, { bigint: true });
    const f = statSync(file, { bigint: true });
    return t.dev === f.dev && t.ino === f.ino;
  } catch {
    return false;
  }
}

/** What lies at `path`, in one `stat`: a file, a directory, something else, or nothing
 *  there at all. `isFile`/`isDirectory` answer the common question and fold "not there"
 *  into `false`; a caller that has to tell "a file is in the way" from "nothing is yet"
 *  — and so cannot use them — asks here instead of reaching for `node:fs` of its own. */
export function kindOf(path: string): 'file' | 'directory' | 'other' | undefined {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return undefined;
  }
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';
  return 'other';
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** `path` as seen from `root` when it lies inside it — relative, in the platform's
 *  separators, `''` for the root itself — or undefined when it does not: a `..` step
 *  first, or another drive. A NAME that merely starts with two dots (`..hidden.c`) is
 *  inside. Both paths absolute. */
export function pathWithin(root: string, path: string): string | undefined {
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel;
}

/** A relative path of the platform as a `Target` and git spell it: with `/`. */
export function toPosixPath(relPath: string): string {
  return relPath.split(sep).join('/');
}

function firstNonDirectory(dir: string): string | undefined {
  for (const step of [...upwards(dir)].reverse()) {
    try {
      if (!statSync(step).isDirectory()) return step;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
