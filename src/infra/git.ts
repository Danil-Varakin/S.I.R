import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { simpleGit } from 'simple-git';
import type { SimpleGit } from 'simple-git';
import { GitError, firstLineOf } from '../core/errors.ts';
import { firstLineEnd, withLineEnds } from '../core/eol.ts';
import { findRepoRoot, pathWithin, toPosixPath } from './fs.ts';
import type { Ask } from './ask.ts';

// By default simple-git calls a task failed only when the exit code is non-zero AND git
// wrote to stderr — so a command that says "no" by its exit code alone
// (`merge-base --is-ancestor`, `rev-parse --quiet`) would come back as a success. Every
// instance here is made with simple-git's `errors` plugin (`gitAt`), which counts any
// non-zero exit as a refusal. `attempt` turns a refusal into `undefined`: one ordinary
// "no", whatever git printed — and a question that needs a value (a sha, a ref name, the
// bytes of a file) reads it from the output.

export interface GitSource {
  readonly branch?: string | undefined;
  readonly commit?: string | undefined;
  readonly path?: string | undefined;
  readonly eol?: GitEol | undefined;
}

export type GitEol = 'repository' | 'worktree';
export const GIT_EOLS: readonly GitEol[] = ['repository', 'worktree'];

const REFUSE: Ask = () => Promise.resolve(false);

export interface GitVersion {
  readonly text: string;
  readonly spec: string;
  readonly blob: string;
}

const BRANCH = '--branch';
const COMMIT = '--commit';
const REPO_PATH = '--repo-path';

export async function fileFromGit(source: GitSource, inPath: string, ask: Ask = REFUSE): Promise<GitVersion> {
  const found = await locate(source, inPath, ask);
  const text = await blob(found.git, found.revision, found.path, found.root);
  const id = (await attempt(found.git, ['rev-parse', '--verify', '--quiet', found.spec]))?.trim();
  if (id === undefined || id === '') throw new GitError(`${found.spec}: git read the file but names no object for it`, 'no-such-file', { revision: found.revision });
  return { text: source.eol === 'worktree' ? asOnDisk(text, found.abs) : text, spec: found.spec, blob: id };
}

export interface GitBase {
  readonly spec: string;
  readonly sha: string;
  readonly root: string;
  readonly blob: string;
  readonly watch: readonly string[];
}

export async function gitBaseOf(source: GitSource, inPath: string, ask: Ask = REFUSE): Promise<GitBase> {
  const found = await locate(source, inPath, ask);
  const sha = found.sha ?? (await shaOf(found.git, found.revision));
  if (sha === undefined) throw new GitError(`${found.revision}: no such commit in ${found.root}`, 'no-such-commit', { revision: found.revision });
  await mustBeFile(found.git, found.revision, found.path, found.root);
  const id = (await attempt(found.git, ['rev-parse', '--verify', '--quiet', found.spec]))?.trim();
  if (id === undefined || id === '') throw new GitError(`${found.spec}: git names no object for the file`, 'no-such-file', { revision: found.revision });
  return { spec: found.spec, sha, root: found.root, blob: id, watch: await refFiles(found.git, found.root, found.revision) };
}

interface Located {
  readonly git: SimpleGit;
  readonly root: string;
  readonly abs: string;
  readonly path: Coordinate;
  readonly revision: string;
  readonly sha: string | undefined;
  readonly spec: string;
}

async function locate(source: GitSource, inPath: string, ask: Ask): Promise<Located> {
  notAnOption(source.branch, BRANCH, 'a branch name');
  notAnOption(source.commit, COMMIT, 'a revision');
  const abs = resolve(inPath);
  const root = repoRootFor(dirname(abs));
  const git = gitAt(root);
  await mustRunGit(git, root);

  const path = repoPath(source, abs, root);
  const { rev: revision, sha } = await revisionOf(git, source, root, ask);
  return { git, root, abs, path, revision, sha, spec: `${revision}:${path.value}` };
}

function asOnDisk(text: string, abs: string): string {
  let disk: string;
  try {
    disk = readFileSync(abs, 'utf8');
  } catch {
    return text;
  }
  const end = firstLineEnd(disk);
  return end === undefined ? text : withLineEnds(text, end);
}

export async function headRefFiles(inPath: string): Promise<string[]> {
  const root = findRepoRoot(dirname(resolve(inPath)));
  return root === undefined ? [] : refFiles(gitAt(root), root, 'HEAD');
}

async function refFiles(git: SimpleGit, root: string, revision: string): Promise<string[]> {
  const refs = new Set<string>(['HEAD', 'packed-refs']);
  const ref = await refName(git, revision);
  if (ref !== undefined && ref.startsWith('refs/')) refs.add(ref);
  else if (revision === 'HEAD') {
    // `symbolic-ref`, not `rev-parse`: it names the branch before its first commit too
    const onBranch = (await attempt(git, ['symbolic-ref', '-q', 'HEAD']))?.trim();
    if (onBranch !== undefined && onBranch.startsWith('refs/')) refs.add(onBranch);
  }
  const paths = await attempt(git, ['rev-parse', ...[...refs].flatMap((name) => ['--git-path', name])]);
  if (paths === undefined) return [];
  return paths.split('\n').map((at) => at.trim()).filter((at) => at !== '').map((at) => resolve(root, at));
}

/** A coordinate reaches git as an argument of its own, and git reads one that starts
 *  with `-` as an OPTION of its own: `--branch --all` made `rev-parse` list every ref.
 *  No branch name and no revision starts with `-` (git refuses such names), so it is
 *  refused here, before git sees it — for the CLI and for a value that came over the
 *  service's pipe alike. The path never needs this: it travels inside `<rev>:<path>`. */
function notAnOption(value: string | undefined, flag: string, what: string): void {
  if (value !== undefined && value.startsWith('-')) {
    throw new GitError(`${value}: ${what} never starts with '-'`, 'bad-coordinate', { revision: value, flag });
  }
}

function repoRootFor(from: string): string {
  const root = findRepoRoot(from);
  if (root !== undefined) return root;
  throw new GitError(
    `the old version from git needs a git repository, and no directory with .git was found above ${from}`,
    'no-repository',
  );
}

interface Coordinate {
  readonly value: string;
  readonly flag: string;
}

function repoPath(source: GitSource, inAbs: string, root: string): Coordinate {
  if (source.path === undefined) return { value: within(root, inAbs, '--in'), flag: '--in' };
  const abs = isAbsolute(source.path) ? source.path : join(root, source.path);
  return { value: within(root, abs, REPO_PATH), flag: REPO_PATH };
}

function within(root: string, abs: string, flag: string): string {
  const inside = pathWithin(root, abs);
  if (inside === undefined) {
    throw new GitError(`${abs}: outside its repository root ${root}`, 'outside-repository', { flag });
  }
  return toPosixPath(inside);
}

interface Revision {
  readonly rev: string;
  readonly label: string;
  readonly sha?: string;
}

async function revisionOf(git: SimpleGit, source: GitSource, root: string, ask: Ask): Promise<{ rev: string; sha: string | undefined }> {
  if (source.commit === undefined) {
    const branch = await branchRevision(git, source.branch, root, ask);
    return { rev: branch.rev, sha: branch.sha };
  }

  const branch = source.branch === undefined ? undefined : await branchRevision(git, source.branch, root, ask);
  const commit = await commitOf(git, source.commit, root);
  if (branch !== undefined) await mustContain(git, branch, commit, root, ask);
  return { rev: commit.spelled, sha: commit.sha };
}

async function branchRevision(
  git: SimpleGit,
  branch: string | undefined,
  root: string,
  ask: Ask,
): Promise<Revision> {
  if (branch === undefined) {
    const sha = await shaOf(git, 'HEAD');
    if (sha === undefined) {
      throw new GitError(`the repository ${root} has no commits yet, so there is no old version to take`, 'no-commits');
    }
    return { rev: 'HEAD', label: 'the branch we are on', sha };
  }

  const ref = await refName(git, branch);
  if (ref === undefined) throw new GitError(`${branch}: no such branch in ${root}`, 'no-such-branch', { revision: branch, flag: BRANCH });
  if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/remotes/')) {
    // A branch may share its name with a tag (`v1.2` the release branch, `v1.2` the tag
    // on it). Git calls the short name ambiguous and names no ref, so the branch is
    // looked for by its full name — and read by it, or git would pick the tag.
    const full = await branchRefNamed(git, branch);
    if (full !== undefined) return { rev: full, label: `branch ${branch}` };

    const names = ref === '' ? 'no ref at all' : ref;
    const question =
      `${BRANCH} ${branch} is not a branch, it names ${names} — going ahead reads it as a ` +
      `plain revision, the way ${COMMIT} would`;
    if (await ask(question)) return { rev: branch, label: branch };
    throw new GitError(
      `${branch}: not a branch, it names ${names} — name any other revision as the commit (${COMMIT})`,
      'not-a-branch',
      { revision: branch, flag: BRANCH },
    );
  }
  return { rev: branch, label: `branch ${branch}` };
}

interface Commit {
  readonly sha: string;
  readonly spelled: string;
}

async function commitOf(git: SimpleGit, spelled: string, root: string): Promise<Commit> {
  const sha = await shaOf(git, spelled);
  if (sha === undefined) throw new GitError(`${spelled}: no such commit in ${root}`, 'no-such-commit', { revision: spelled, flag: COMMIT });
  return { sha, spelled };
}

async function mustContain(
  git: SimpleGit,
  branch: Revision,
  commit: Commit,
  root: string,
  ask: Ask,
): Promise<void> {
  if ((await attempt(git, ['merge-base', '--is-ancestor', commit.sha, branch.rev])) !== undefined) return;
  const question =
    `commit ${commit.spelled} is not on ${branch.label} — going ahead reads that commit all the ` +
    `same, out of a history ${branch.label} never had`;
  if (await ask(question)) return;
  throw new GitError(
    `commit ${commit.spelled} is not on ${branch.label} (repository ${root})\n` +
      `  name the branch that holds it (${BRANCH}), or drop the commit (${COMMIT})`,
    'not-on-branch',
    { revision: commit.spelled },
  );
}

/** `cat-file blob` rather than `show`: it costs the same single call and REFUSES a
 *  directory, which `show` would hand back as a printed tree listing — a "file" that
 *  looks like content and is not. The revision is verified by the time we are here, so
 *  a refusal at this point is always about the path, and can say so. */
async function blob(git: SimpleGit, revision: string, path: Coordinate, root: string): Promise<string> {
  const spec = `${revision}:${path.value}`;
  const text = await attempt(git, ['cat-file', 'blob', spec]);
  if (text !== undefined) return text;
  throw notAFile((await attempt(git, ['cat-file', '-t', spec]))?.trim(), revision, path, root);
}

async function mustBeFile(git: SimpleGit, revision: string, path: Coordinate, root: string): Promise<void> {
  const kind = (await attempt(git, ['cat-file', '-t', `${revision}:${path.value}`]))?.trim();
  if (kind !== 'blob') throw notAFile(kind, revision, path, root);
}

function notAFile(kind: string | undefined, revision: string, path: Coordinate, root: string): GitError {
  const none = kind === undefined || kind === '';
  return new GitError(
    none ? `${path.value}: no such file in ${revision} (repository ${root})` : `${path.value}: not a file in ${revision} — git calls it a ${kind}`,
    none ? 'no-such-file' : 'not-a-file',
    { revision, flag: path.flag },
  );
}

function gitAt(root: string): SimpleGit {
  // NB: never `trimmed: true` here — this instance reads file CONTENT, and trimming
  // would eat the trailing newline of every old version.
  return simpleGit(root, { errors: refusedOnAnyExitCode });
}

function refusedOnAnyExitCode(
  error: Buffer | Error | undefined,
  result: { readonly exitCode: number; readonly stdOut: readonly Buffer[]; readonly stdErr: readonly Buffer[] },
): Buffer | Error | undefined {
  if (error !== undefined) return error;
  return result.exitCode === 0 ? undefined : Buffer.concat([...result.stdOut, ...result.stdErr]);
}

/** Asked once, before any coordinate is put to git, so that every later "no" is really
 *  git saying no. A `.git` next door proves a repository, never that the binary is
 *  there to read it — and without this, an unrunnable git answers every question with
 *  a confident "no such branch". */
async function mustRunGit(git: SimpleGit, root: string): Promise<void> {
  try {
    await git.raw(['rev-parse', '--git-dir']);
  } catch (e) {
    throw new GitError(`cannot run git in ${root}\n  ${firstLineOf(e)}`, 'no-git');
  }
}

/** The output of a command, or undefined when git refused — any non-zero exit. An EMPTY
 *  answer is NOT a refusal and comes back as `''`: `cat-file blob` on an empty file has
 *  to be told apart from `cat-file blob` on a file that is not there. */
async function attempt(git: SimpleGit, args: readonly string[]): Promise<string | undefined> {
  try {
    return await git.raw([...args]);
  } catch {
    return undefined;
  }
}

async function shaOf(git: SimpleGit, revision: string): Promise<string | undefined> {
  const sha = (await attempt(git, ['rev-parse', '--verify', `${revision}^{commit}`]))?.trim();
  return sha === undefined || sha === '' ? undefined : sha;
}

async function refName(git: SimpleGit, revision: string): Promise<string | undefined> {
  return (await attempt(git, ['rev-parse', '--symbolic-full-name', revision]))?.trim();
}

async function branchRefNamed(git: SimpleGit, name: string): Promise<string | undefined> {
  for (const full of [`refs/heads/${name}`, `refs/remotes/${name}`]) {
    if ((await shaOf(git, full)) !== undefined) return full;
  }
  return undefined;
}
