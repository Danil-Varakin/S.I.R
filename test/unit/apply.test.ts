import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { parseSirFile } from '../../src/core/sir-parser.ts';
import { cppAdapter } from '../../src/lang/cpp/index.ts';
import { applyAll } from '../../src/core/apply.ts';
import { sirMd } from '../helpers.ts';
import { buildRepo, version } from '../git-repo.ts';
import type { Repo } from '../git-repo.ts';

test('applyAll: a single insertion hunk changes the text', async () => {
  await cppAdapter.init();
  const file = parseSirFile(sirMd([{ match: '... a(); >>> ...', patch: 'X();' }]));
  const { source, edits } = applyAll('void f(){ a(); b(); }', file, cppAdapter);
  assert.equal(edits.length, 1);
  assert.ok(source.includes('a();X(); b();'), source);
});

test('applyAll: the second hunk leans on what the first inserted, in order', async () => {
  await cppAdapter.init();
  const file = parseSirFile(
    sirMd([
      { match: '... namespace f { >>> ...', patch: 'int a;' },
      { match: '... int a; >>> ...', patch: 'int b;' },
    ]),
  );
  const { source, edits } = applyAll('namespace f {\n}\n', file, cppAdapter);
  assert.equal(edits.length, 2);
  assert.ok(source.includes('int a;') && source.includes('int b;'), source);
  assert.ok(source.indexOf('int a;') < source.indexOf('int b;'), source);
});

const SIR = fileURLToPath(new URL('../../src/bin/sir.ts', import.meta.url));

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('node', ['--experimental-strip-types', SIR, 'apply', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

test('CLI apply: success is exit 0 and a written file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sir-apply-'));
  try {
    const src = join(dir, 'src.cc');
    const md = join(dir, 'p.sirp');
    const out = join(dir, 'out.cc');
    writeFileSync(src, 'void f(){ a(); b(); }');
    writeFileSync(md, sirMd([{ match: '... a(); >>> ...', patch: 'X();' }]));

    const r = runCli(['--match', md, '--in', src, '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(readFileSync(out, 'utf8').includes('a();X();'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI apply --verify: a clean fit is exit 0 and nothing written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sir-apply-'));
  try {
    const src = join(dir, 'src.cc');
    const md = join(dir, 'p.sirp');
    writeFileSync(src, 'void f(){ a(); b(); }');
    writeFileSync(md, sirMd([{ match: '... a(); >>> ...', patch: 'X();' }]));

    const asked = runCli(['--match', md, '--in', src, '--verify']);
    assert.equal(asked.status, 1, asked.stderr);
    assert.match(asked.stderr, /--verify needs a clean base/);

    const r = runCli(['--match', md, '--in', src, '--verify', '--base-from-disk']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /verify: ok/);
    assert.equal(runCli(['--match', md, '--in', src, '--verify', '--yes']).status, 0, '--yes answers the question');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI apply: no match is exit 3 (MatchError)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sir-apply-'));
  try {
    const src = join(dir, 'src.cc');
    const md = join(dir, 'p.sirp');
    writeFileSync(src, 'void f(){ a(); }');
    writeFileSync(md, sirMd([{ match: '... nope(); >>> ...', patch: 'X();' }]));

    const r = runCli(['--match', md, '--in', src, '--out', join(dir, 'o.cc')]);
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /MatchError/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI apply: --out as a directory keeps the name, and directories are created', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sir-apply-out-'));
  try {
    const src = join(dir, 'in.cc');
    const md = join(dir, 'p.sirp');
    writeFileSync(src, 'void f() {\n  a();\n}\n');
    writeFileSync(md, sirMd([{ match: '... a(); >>> ...', patch: 'X();' }]));

    const intoDir = runCli([...['--match', md, '--in', src], '--out', `${dir}/built/`]);
    assert.equal(intoDir.status, 0, intoDir.stderr);
    assert.match(readFileSync(join(dir, 'built', 'in.cc'), 'utf8'), /X\(\);/);

    const named = join(dir, 'deep', 'result.cc');
    const intoFile = runCli([...['--match', md, '--in', src], '--out', named]);
    assert.equal(intoFile.status, 0, intoFile.stderr);
    assert.match(readFileSync(named, 'utf8'), /X\(\);/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function patchAfter(repo: Repo, line: string, name = 'p.sirp'): string {
  const md = join(repo.dir, name);
  writeFileSync(md, sirMd([{ match: `... ${line} >>> ...`, patch: 'X();' }]));
  return md;
}

function withRepo(prefix: string, body: (repo: Repo) => void): void {
  const repo = buildRepo(prefix);
  try {
    body(repo);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
}

test('CLI apply --head: the file is patched as of the last commit, not as it is on disk', () => {
  withRepo('sir-apply-head-', (repo) => {
    const md = patchAfter(repo, 'int a = 2;');
    const out = join(repo.dir, 'out.cc');

    const fromDisk = runCli(['--match', md, '--in', repo.inPath, '--out', out]);
    assert.equal(fromDisk.status, 3, 'the working file is version 4, the patch does not fit it');

    const fromGit = runCli(['--match', md, '--in', repo.inPath, '--head', '--out', out]);
    assert.equal(fromGit.status, 0, fromGit.stderr);
    assert.ok(readFileSync(out, 'utf8').includes('int a = 2;X();'));
  });
});

test('CLI apply: each coordinate flag reaches the coordinate it belongs to', () => {
  withRepo('sir-apply-coords-', (repo) => {
    const cases: readonly (readonly [string, readonly string[]])[] = [
      ['int a = 1;', ['--commit', repo.a]],
      ['int a = 3;', ['--branch', 'side']],
      ['int b = 7;', ['--repo-path', 'src/core/other.cc']],
      ['int side = 1;', ['-b', 'side', '-c', repo.s, '--repo-path', 'src/core/side-only.cc']],
    ];
    for (const [line, coordinates] of cases) {
      const out = join(repo.dir, 'out.cc');
      const r = runCli(['--match', patchAfter(repo, line), '--in', repo.inPath, ...coordinates, '--out', out]);
      assert.equal(r.status, 0, `${coordinates.join(' ')}: ${r.stderr}`);
      assert.ok(readFileSync(out, 'utf8').includes(`${line}X();`), coordinates.join(' '));
    }
  });
});

test('CLI apply: with a git source --in is only a name, the file need not be on disk', () => {
  withRepo('sir-apply-gone-', (repo) => {
    rmSync(repo.inPath);
    const out = join(repo.dir, 'out.cc');
    const r = runCli(['--match', patchAfter(repo, 'int a = 2;'), '--in', repo.inPath, '--head', '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(readFileSync(out, 'utf8').includes('int a = 2;X();'));
  });
});

test('CLI apply: the result is named after --in, whichever path it was read from', () => {
  withRepo('sir-apply-name-', (repo) => {
    const dir = join(repo.dir, 'result') + '/';
    const r = runCli([
      '--match', patchAfter(repo, 'int b = 7;'), '--in', repo.inPath,
      '--repo-path', 'src/core/other.cc', '--out', dir,
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(dir, 'f.cc')), 'the name of --in, not of --repo-path');
    assert.ok(!existsSync(join(dir, 'other.cc')));
  });
});

test('CLI apply --verify against a branch: does the patch still fit THERE', () => {
  withRepo('sir-apply-verify-', (repo) => {
    const md = patchAfter(repo, 'int a = 2;');
    assert.equal(runCli(['--match', md, '--in', repo.inPath, '--branch', repo.branch, '--verify']).status, 0);
    const off = runCli(['--match', md, '--in', repo.inPath, '--branch', 'side', '--verify']);
    assert.equal(off.status, 3, 'side holds version 3, the patch was written for 2');
    assert.match(off.stderr, /file: side:src\/core\/f\.cc/, 'the report names what was read');
  });
});

test('CLI apply: writing a git version over --in never throws local edits away', () => {
  withRepo('sir-apply-inplace-', (repo) => {
    const md = patchAfter(repo, 'int a = 2;');

    const lossy = runCli(['--match', md, '--in', repo.inPath, '--head', '--out', repo.inPath]);
    assert.equal(lossy.status, 1);
    assert.match(lossy.stderr, /the result would go over .*f\.cc, which holds changes that HEAD:src\/core\/f\.cc does not/);
    assert.match(lossy.stderr, /write the result elsewhere \(--out\), or patch the file as it is on disk \(no git coordinate\)/);
    assert.equal(readFileSync(repo.inPath, 'utf8'), version(4));

    writeFileSync(repo.inPath, version(2));
    const clean = runCli(['--match', md, '--in', repo.inPath, '--head', '--out', repo.inPath]);
    assert.equal(clean.status, 0, clean.stderr);
    assert.ok(readFileSync(repo.inPath, 'utf8').includes('int a = 2;X();'));
  });
});

test('CLI apply: --out spelled in another case is --in all the same on a case-insensitive disk', (t) => {
  withRepo('sir-apply-case-', (repo) => {
    const upper = join(repo.dir, 'src', 'core', 'F.cc');
    if (!existsSync(upper)) {
      t.skip('the file system here tells F.cc from f.cc');
      return;
    }
    const r = runCli(['--match', patchAfter(repo, 'int a = 2;'), '--in', repo.inPath, '--head', '--out', upper]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /holds changes that HEAD:src\/core\/f\.cc does not/);
    assert.equal(readFileSync(repo.inPath, 'utf8'), version(4));
  });
});

test('CLI apply: in place over --in is fine when the result IS the working file', () => {
  withRepo('sir-apply-noop-', (repo) => {
    const md = join(repo.dir, 'back.sirp');
    execFileSync('node', ['--experimental-strip-types', SIR, 'generate', '--in', repo.inPath, '--head', '--out', md,
      '--language', 'cpp'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const r = runCli(['--match', md, '--in', repo.inPath, '--head', '--out', repo.inPath]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(repo.inPath, 'utf8'), version(4));
  });
});

test('CLI apply: in place from DISK is untouched by the git rule', () => {
  withRepo('sir-apply-disk-', (repo) => {
    const r = runCli(['--match', patchAfter(repo, 'int a = 4;'), '--in', repo.inPath, '--out', repo.inPath]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(readFileSync(repo.inPath, 'utf8').includes('int a = 4;X();'));
  });
});

test('CLI apply: git refusals and slips are answered as in generate', () => {
  withRepo('sir-apply-wrong-', (repo) => {
    const md = patchAfter(repo, 'int a = 2;');
    const base = ['--match', md, '--in', repo.inPath];
    const cases: readonly (readonly [readonly string[], RegExp])[] = [
      [['--branch', 'nope', '--verify'], /GitError: --branch nope: no such branch/],
      [['--branch', repo.branch, '--commit', repo.s, '--verify'], /is not on branch/],
      [['--branch', 'v1.0', '--verify'], /not a branch/],
      [['--repo-path', 'src/core', '--verify'], /not a file/],
      [['--brnach', 'side', '--verify'], /did you mean --branch\?/],
      [['-c', '--verify'], /option -c needs a value, and --verify is another option/],
    ];
    for (const [args, expected] of cases) {
      const r = runCli([...base, ...args]);
      assert.equal(r.status, 1, args.join(' '));
      assert.match(r.stderr, expected, args.join(' '));
    }
  });
});

test('CLI apply --yes: the loss of local edits is agreed in advance, and said out loud', () => {
  withRepo('sir-apply-yes-', (repo) => {
    const md = patchAfter(repo, 'int a = 2;');
    const r = runCli(['--match', md, '--in', repo.inPath, '--head', '--out', repo.inPath, '--yes']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /warning: writing over .* whatever of its current content is not committed is lost/);
    assert.match(r.stderr, /--yes: going ahead/);
    assert.ok(readFileSync(repo.inPath, 'utf8').includes('int a = 2;X();'), 'HEAD, patched, in its place');
  });
});

test('CLI apply: with no terminal to ask, the loss is refused and the way round is named', () => {
  withRepo('sir-apply-pipe-', (repo) => {
    const r = runCli(['--match', patchAfter(repo, 'int a = 2;'), '--in', repo.inPath, '--head', '--out', repo.inPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not a terminal, so nobody can answer: stopping \(pass --yes to go ahead\)/);
    assert.equal(readFileSync(repo.inPath, 'utf8'), version(4), 'left alone');
  });
});

test('CLI apply --yes: a commit off the named branch is patched all the same', () => {
  withRepo('sir-apply-offbranch-', (repo) => {
    const md = patchAfter(repo, 'int a = 3;');
    const base = ['--match', md, '--in', repo.inPath, '--branch', repo.branch, '--commit', repo.s, '--verify'];
    assert.equal(runCli(base).status, 1, 'without --yes: refused');
    const r = runCli([...base, '-y']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /warning: commit .* is not on branch/);
  });
});
