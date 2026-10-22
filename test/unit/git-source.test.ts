import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { fileFromGit } from '../../src/infra/git.ts';
import type { GitSource } from '../../src/infra/git.ts';
import type { Ask } from '../../src/infra/ask.ts';
import { GitError } from '../../src/core/errors.ts';
import { buildRepo, version, OTHER, SIDE_ONLY } from '../git-repo.ts';

// The repository and what each coordinate points at: see test/git-repo.ts.

const R = buildRepo('sir-git-source-');
after(() => rmSync(R.dir, { recursive: true, force: true }));

interface Case {
  readonly name: string;
  readonly source: GitSource;
  readonly text?: string;
  readonly error?: readonly RegExp[];
}

// Every combination of the three coordinates, each one pointing at something that is
// there and at something that is not — the table IS the specification.
const CASES: readonly Case[] = [
  // ── all three defaulted, and one coordinate at a time ──────────────────────
  { name: 'nothing named: the last commit of the branch we are on, the path of --in',
    source: {}, text: version(2) },
  { name: 'branch alone: the last commit of THAT branch',
    source: { branch: 'side' }, text: version(3) },
  { name: 'branch alone: the branch we are on, spelled out, is the default',
    source: { branch: R.branch }, text: version(2) },
  { name: 'branch alone: a remote-tracking branch counts as a branch',
    source: { branch: 'origin/main' }, text: version(2) },
  { name: 'commit alone: that commit, the same file',
    source: { commit: R.a }, text: version(1) },
  { name: 'commit alone: the tip commit itself',
    source: { commit: R.b }, text: version(2) },
  { name: 'commit alone: a tag is a perfectly good commit',
    source: { commit: 'v1.0' }, text: version(2) },
  { name: 'commit alone: any revision git understands, HEAD~1 included',
    source: { commit: 'HEAD~1' }, text: version(1) },
  { name: 'path alone: another file, out of the same commit',
    source: { path: 'src/core/other.cc' }, text: OTHER },
  { name: 'path alone: an absolute path inside the repository',
    source: { path: join(R.dir, 'src', 'core', 'other.cc') }, text: OTHER },

  // ── two and three coordinates together ─────────────────────────────────────
  { name: 'branch + commit: a commit that branch holds',
    source: { branch: R.branch, commit: R.a }, text: version(1) },
  { name: 'branch + commit: the fork point, held by both branches',
    source: { branch: 'side', commit: R.a }, text: version(1) },
  { name: 'branch + commit: a commit only that branch holds',
    source: { branch: 'side', commit: R.s }, text: version(3) },
  { name: 'branch + path: a file that exists only on that branch',
    source: { branch: 'side', path: 'src/core/side-only.cc' }, text: SIDE_ONLY },
  { name: 'commit + path: another file, out of an older commit',
    source: { commit: R.a, path: 'src/core/other.cc' }, text: OTHER },
  { name: 'all three at once',
    source: { branch: 'side', commit: R.s, path: 'src/core/side-only.cc' }, text: SIDE_ONLY },

  // ── coordinates that name nothing ──────────────────────────────────────────
  { name: 'unknown branch',
    source: { branch: 'nope' }, error: [/--branch nope/, /no such branch/] },
  { name: 'unknown commit',
    source: { commit: 'nope' }, error: [/--commit nope/, /no such commit/] },
  { name: 'unknown path',
    source: { path: 'nope.cc' }, error: [/--repo-path nope\.cc/, /no such file in HEAD/] },
  { name: 'a path that exists, but not in THIS commit',
    source: { path: 'src/core/side-only.cc' }, error: [/--repo-path/, /no such file in HEAD/] },
  { name: 'a path that exists in the commit named, but not in the branch named',
    source: { branch: R.branch, path: 'src/core/side-only.cc' }, error: [/no such file/] },

  // ── coordinates that name the wrong KIND of thing ──────────────────────────
  { name: 'a tag is not a branch, and the refusal says which flag takes one',
    source: { branch: 'v1.0' }, error: [/--branch v1\.0/, /not a branch/, /refs\/tags\/v1\.0/, /--commit/] },
  { name: 'a raw sha is not a branch either',
    source: { branch: R.b }, error: [/not a branch/, /no ref at all/, /--commit/] },
  { name: 'a directory is not a file: a tree is refused, not printed as a listing',
    source: { path: 'src/core' }, error: [/--repo-path src\/core/, /not a file/, /tree/] },
  { name: 'a path outside the repository',
    source: { path: '../../etc/passwd' }, error: [/--repo-path/, /outside its repository root/] },

  // ── the combination that can contradict itself ─────────────────────────────
  { name: 'branch + commit: a commit that branch never held',
    source: { branch: R.branch, commit: R.s },
    error: [new RegExp(`commit ${R.s} is not on branch ${R.branch}`), /--branch/, /--commit/] },
  { name: 'commit alone stands on its own: no branch is named, so none is checked',
    source: { commit: R.s }, text: version(3) },

  // ── which coordinate is judged first ───────────────────────────────────────
  { name: 'the branch is judged before the commit',
    source: { branch: 'nope', commit: 'alsonope' }, error: [/--branch nope/] },
  { name: 'the commit is judged before the path',
    source: { commit: 'nope', path: 'nope.cc' }, error: [/--commit nope/] },
  { name: 'branch and commit both fit, and only then is the path judged',
    source: { branch: R.branch, commit: R.a, path: 'nope.cc' }, error: [/--repo-path nope\.cc/] },
];

/** The message as the CLI prints it: the core names no flag, `cli/command.ts` puts it
 *  in front. */
function asTheCliSaysIt(e: GitError): string {
  return e.flag !== undefined ? `${e.flag} ${e.message}` : e.message;
}

test('git source: X2 — every refusal says why in detail.reason; X3 — the message names no flag', async () => {
  const cases = [
    [{ branch: 'nope' }, 'no-such-branch'],
    [{ commit: 'nope' }, 'no-such-commit'],
    [{ path: 'nope.cc' }, 'no-such-file'],
    [{ path: 'src/core' }, 'not-a-file'],
    [{ branch: 'v1.0' }, 'not-a-branch'],
    [{ branch: R.branch, commit: R.s }, 'not-on-branch'],
    [{ path: '../../etc/passwd' }, 'outside-repository'],
  ] as const;
  for (const [source, reason] of cases) {
    await assert.rejects(() => fileFromGit(source, R.inPath), (e: unknown) => {
      assert.ok(e instanceof GitError);
      assert.equal(e.reason, reason, JSON.stringify(source));
      assert.equal(e.detail()!['reason'], reason);
      assert.doesNotMatch(e.message, /^--/, 'no flag in front: the service has none');
      return true;
    });
  }
});

for (const c of CASES) {
  test(`git source — ${c.name}`, async () => {
    if (c.text !== undefined) {
      assert.equal((await fileFromGit(c.source, R.inPath)).text, c.text);
      return;
    }
    // A refusal is judged by what it SAYS: a named error, and the flag to change in it.
    await assert.rejects(
      () => fileFromGit(c.source, R.inPath),
      (e: unknown) => {
        assert.ok(e instanceof GitError, `expected GitError, got ${String(e)}`);
        for (const fragment of c.error ?? []) assert.match(asTheCliSaysIt(e), fragment);
        return true;
      },
    );
  });
}

// ── asking: only a request git CAN carry out, but that may not mean what it says ──

/** An Ask that records every question and answers them all the same way. */
function answering(answer: boolean): { ask: Ask; asked: string[] } {
  const asked: string[] = [];
  return { ask: (q) => (asked.push(q), Promise.resolve(answer)), asked };
}

test('git source: answered yes, a commit off the named branch is read all the same', async () => {
  const { ask, asked } = answering(true);
  assert.equal((await fileFromGit({ branch: R.branch, commit: R.s }, R.inPath, ask)).text, version(3));
  assert.equal(asked.length, 1);
  assert.match(asked[0]!, new RegExp(`commit ${R.s} is not on branch ${R.branch} — going ahead reads`));
});

test('git source: answered yes, a tag or a sha given as --branch is read as a revision', async () => {
  const { ask, asked } = answering(true);
  assert.equal((await fileFromGit({ branch: 'v1.0' }, R.inPath, ask)).text, version(2));
  assert.equal((await fileFromGit({ branch: R.a }, R.inPath, ask)).text, version(1));
  assert.match(asked[0]!, /--branch v1\.0 is not a branch, it names refs\/tags\/v1\.0 — going ahead/);
  assert.match(asked[1]!, /it names no ref at all/);
});

test('git source: a tag accepted as the branch still holds the commit named beside it', async () => {
  const { ask, asked } = answering(true);
  // v1.0 is B, which holds A: one question (the tag), and none about containment
  assert.equal((await fileFromGit({ branch: 'v1.0', commit: R.a }, R.inPath, ask)).text, version(1));
  assert.equal(asked.length, 1);
});

test('git source: answered no, the refusal is the one nobody-to-ask gets', async () => {
  const { ask } = answering(false);
  for (const source of [{ branch: R.branch, commit: R.s }, { branch: 'v1.0' }] as GitSource[]) {
    const quiet = await fileFromGit(source, R.inPath).catch((e: Error) => e.message);
    const declined = await fileFromGit(source, R.inPath, ask).catch((e: Error) => e.message);
    assert.equal(declined, quiet, JSON.stringify(source));
  }
});

test('git source: nothing to read is never a question — unknown names stay refusals', async () => {
  const { ask, asked } = answering(true);
  const sources: GitSource[] = [
    { branch: 'nope' }, { commit: 'nope' }, { path: 'nope.cc' }, { path: 'src/core' },
    { path: '../../etc/passwd' }, { branch: R.branch, commit: 'nope' },
  ];
  for (const source of sources) {
    await assert.rejects(() => fileFromGit(source, R.inPath, ask), GitError, JSON.stringify(source));
  }
  assert.deepEqual(asked, []);
});

test('git source: a request that says what it means asks nothing', async () => {
  const { ask, asked } = answering(false);
  const sources: GitSource[] = [
    {}, { branch: 'side' }, { commit: R.s }, { branch: 'side', commit: R.a }, { path: 'src/core/other.cc' },
  ];
  for (const source of sources) await fileFromGit(source, R.inPath, ask);
  assert.deepEqual(asked, []);
});

test('git source: the spec says exactly what was read', async () => {
  assert.equal((await fileFromGit({}, R.inPath)).spec, 'HEAD:src/core/f.cc');
  assert.equal((await fileFromGit({ branch: 'side' }, R.inPath)).spec, 'side:src/core/f.cc');
  assert.equal((await fileFromGit({ commit: R.a }, R.inPath)).spec, `${R.a}:src/core/f.cc`);
  assert.equal(
    (await fileFromGit({ path: 'src/core/other.cc' }, R.inPath)).spec,
    'HEAD:src/core/other.cc',
  );
});

test('git source: outside a repository, before any coordinate is looked at', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sir-git-norepo-'));
  try {
    writeFileSync(join(dir, 'f.cc'), version(4));
    await assert.rejects(() => fileFromGit({ branch: 'main' }, join(dir, 'f.cc')), (e: unknown) => {
      assert.ok(e instanceof GitError);
      assert.match(e.message, /needs a git repository/);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git source: a .git that git itself cannot read is named as that, not as a missing branch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sir-git-broken-'));
  try {
    writeFileSync(join(dir, '.git'), 'gitdir: nowhere-at-all\n');
    writeFileSync(join(dir, 'f.cc'), version(4));
    await assert.rejects(() => fileFromGit({ branch: 'main' }, join(dir, 'f.cc')), (e: unknown) => {
      assert.ok(e instanceof GitError);
      assert.match(e.message, /cannot run git/);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git source: a repository with no commits yet says so, and does not blame the path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sir-git-empty-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    writeFileSync(join(dir, 'f.cc'), version(4));
    await assert.rejects(() => fileFromGit({}, join(dir, 'f.cc')), (e: unknown) => {
      assert.ok(e instanceof GitError);
      assert.match(e.message, /no commits yet/);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git source: a branch that shares its name with a tag is read as the BRANCH, unasked', async () => {
  // Its own repository: a tag `side` on B (version 2), beside the branch `side` on S
  // (version 3). Git calls the short name ambiguous and, left to itself, reads the tag.
  const repo = buildRepo('sir-git-same-name-');
  try {
    execFileSync('git', ['tag', 'side', repo.b], { cwd: repo.dir, stdio: 'ignore' });
    const { ask, asked } = answering(false);

    const alone = await fileFromGit({ branch: 'side' }, repo.inPath, ask);
    assert.equal(alone.text, version(3));
    assert.equal(alone.spec, 'refs/heads/side:src/core/f.cc', 'the spec names what was read, unambiguously');

    assert.equal((await fileFromGit({ branch: 'side', commit: repo.a }, repo.inPath, ask)).text, version(1));
    await assert.rejects(() => fileFromGit({ branch: 'side', commit: repo.b }, repo.inPath, ask), /is not on branch side/);
    assert.equal(asked.length, 1, 'only the commit off the branch is asked about, never the name');
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('git source: a coordinate that starts with - is refused before git reads it as an option', async () => {
  for (const [source, said] of [
    [{ branch: '--all' }, /--branch --all: a branch name never starts with '-'/],
    [{ branch: '-x' }, /--branch -x: a branch name never starts with '-'/],
    [{ commit: '--output=/tmp/x' }, /--commit --output=\/tmp\/x: a revision never starts with '-'/],
  ] as const) {
    await assert.rejects(() => fileFromGit(source, R.inPath), (e: unknown) => {
      assert.ok(e instanceof GitError, JSON.stringify(source));
      assert.match(asTheCliSaysIt(e), said);
      assert.equal(e.reason, 'bad-coordinate');
      return true;
    });
  }
});
