import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { synthesize } from '../../src/generate/synth.ts';
import { printSirFile } from '../../src/generate/printer.ts';
import { parseSirFile } from '../../src/core/sir-parser.ts';
import { applyAll } from '../../src/core/apply.ts';
import { cppAdapter } from '../../src/lang/cpp/index.ts';
import { pythonAdapter } from '../../src/lang/python/index.ts';
import { generatePatch, patchHeader } from '../../src/generate/pipeline.ts';
import { NoChanges, SynthesisError } from '../../src/core/errors.ts';
import { hunksOf } from '../../src/generate/steer.ts';
import type { LanguageAdapter } from '../../src/lang/source-map.ts';
import { buildRepo, version } from '../git-repo.ts';
import type { Repo } from '../git-repo.ts';

// ── the round trip THROUGH .md: synth → print → parse → apply == new ──────────

async function pipelineRoundtrip(oldStr: string, newStr: string, adapter: LanguageAdapter = cppAdapter): Promise<void> {
  await adapter.init();
  const md = printSirFile(synthesize(oldStr, newStr, adapter), adapter.name);
  const { source } = applyAll(oldStr, parseSirFile(md), adapter);
  assert.equal(source, newStr);
}

test('printer round trip: a replacement', async () => {
  await pipelineRoundtrip(
    'namespace net {\nvoid Fetch() {\n  int timeout = 30;\n  Connect(timeout);\n}\n}\n',
    'namespace net {\nvoid Fetch() {\n  int timeout = 60;\n  Connect(timeout);\n}\n}\n',
  );
});

test('printer round trip: insertion, deletion and several hunks', async () => {
  await pipelineRoundtrip(
    'void f() {\n  a();\n  b();\n  c();\n}\n',
    'void f() {\n  a();\n  X();\n  c();\n  d();\n}\n',
  );
});

test('printer round trip: a hunk\'s # note is printed before its # match and read back to the same text', () => {
  const text = [
    '# note', 'first: why it is here', '', '  indented, any column', '# end',
    '# match cpp', '    ...', '    a();', '    >>>', '    ...', '# end', '# patch', '    x();', '# end',
    '',
    '# match cpp', '    ...', '    b();', '    >>>', '    ...', '# end', '# patch', '    y();', '# end',
    '',
    '# note', '# end',
    '# match cpp', '    ...', '    c();', '    >>>', '    ...', '# end', '# patch', '    z();', '# end',
    '',
  ].join('\n');
  const hunks = parseSirFile(text).hunks;
  const again = parseSirFile(printSirFile(hunks, 'cpp')).hunks;
  assert.deepEqual(again.map((h) => h.note?.text), ['first: why it is here\n\n  indented, any column', undefined, '']);
  assert.deepEqual(again.map((h) => h.patch), hunks.map((h) => h.patch));
});

test('printer round trip: a literal holding ... is escaped and survives parsing', async () => {
  await pipelineRoundtrip('int a = f(x, y);\nint z = 0;\n', 'int a = f(x, ...);\nint z = 0;\n');
});

// A .md carries no line endings of its own (git and editors turn them either way), so
// the lines a hunk writes into a CRLF file must come out CRLF — byte for byte, not only
// after normalization, which would hide a mixed file.
test('printer round trip: a CRLF file gets CRLF on every line the hunks write', async () => {
  await pipelineRoundtrip(
    'int f() {\r\n  int a = 1;\r\n  return a;\r\n}\r\n',
    'int f() {\r\n  int a = 5;\r\n  int b = 6;\r\n  int c = 7;\r\n  return a;\r\n}\r\n',
  );
  await pipelineRoundtrip(
    'int f() {\r\n  a();\r\n}\r\n\r\nint g() {\r\n  b();\r\n}\r\n',
    'int f() {\r\n  a();\r\n  a2();\r\n}\r\n\r\nint g() {\r\n}\r\n',
  );
});

test('printer round trip: a CRLF Python file, where the indent is the structure', async () => {
  await pipelineRoundtrip(
    'def f():\r\n    a = 1\r\n    return a\r\n',
    'def f():\r\n    a = 5\r\n    if a:\r\n        a += 1\r\n    return a\r\n',
    pythonAdapter,
  );
});

test('generatePatch: a heading apply would read as another language is refused up front', async () => {
  await assert.rejects(
    () => generatePatch({ oldText: 'int a;\n', newText: 'int b;\n', language: 'cpp', label: 'c' }),
    /'# match c' would be read back by apply as language 'c', not as 'cpp'/,
  );
});

test('printSirFile: the parser reads back the headings it writes', async () => {
  await cppAdapter.init();
  const md = printSirFile(synthesize('int a = 1;\n', 'int a = 2;\n', cppAdapter), 'cpp');
  assert.match(md, /^# match cpp$/m);
  assert.match(md, /^# patch$/m);
  assert.match(md, /^# end$/m);
  assert.match(md, /^ {4}int a = 2;$/m);
  const file = parseSirFile(md);
  assert.equal(file.hunks.length, 1);
  assert.equal(file.language, 'cpp');
});

// ── CLI generate end to end, and apply back again ─────────────────────────────

const SIR = fileURLToPath(new URL('../../src/bin/sir.ts', import.meta.url));
const GEN_CLI = [SIR, 'generate'];
const APPLY_CLI = [SIR, 'apply'];

interface CliRun {
  status: number;
  stdout: string;
  stderr: string;
}

/** Both streams, whatever the exit: a warning printed on the way to success is part of
 *  what a run says, and has to be there to be checked. */
function runCli(cli: readonly string[], args: string[], cwd?: string): CliRun {
  const r = spawnSync('node', ['--experimental-strip-types', ...cli, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(cwd !== undefined ? { cwd } : {}),
  });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

test('CLI generate --in-old writes the .md, and apply brings the new file back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sir-gen-'));
  try {
    const oldF = join(dir, 'old.cc');
    const newF = join(dir, 'new.cc');
    const md = join(dir, 'patch.sirp');
    const oldStr = 'void f() {\n  int a = 1;\n  return a;\n}\n';
    const newStr = 'void f() {\n  int a = 2;\n  return a;\n}\n';
    writeFileSync(oldF, oldStr);
    writeFileSync(newF, newStr);

    const gen = runCli(GEN_CLI, ['--in', newF, '--in-old', oldF, '--out', md, '--language', 'cpp']);
    assert.equal(gen.status, 0, gen.stderr);

    const out = join(dir, 'result.cc');
    const ap = runCli(APPLY_CLI, ['--match', md, '--in', oldF, '--out', out]);
    assert.equal(ap.status, 0, ap.stderr);
    assert.equal(readFileSync(out, 'utf8'), newStr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI generate → apply with no --language: the heading is the language\'s own name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sir-gen-'));
  try {
    const cases = [
      { ext: '.m', name: 'objc', from: '@implementation Foo\n- (void)bar {\n  int a = 1;\n}\n@end\n', to: '2;' },
      { ext: '.mm', name: 'objc', from: '@implementation Foo\n- (void)bar {\n  int a = 1;\n}\n@end\n', to: '2;' },
      { ext: '.pyi', name: 'python', from: 'def f() -> int:\n    return 1\n', to: '2\n' },
      { ext: '.kts', name: 'kotlin', from: 'fun f() {\n  val a = 1\n}\n', to: '2\n' },
      { ext: '.mts', name: 'typescript', from: 'function f() {\n  const a = 1;\n}\n', to: '2;' },
    ];
    for (const c of cases) {
      const oldF = join(dir, `old${c.ext}`);
      const newF = join(dir, `new${c.ext}`);
      const md = join(dir, `patch${c.ext}.sirp`);
      const out = join(dir, `result${c.ext}`);
      const newStr = c.from.replace(/1(;|\n)/, c.to);
      writeFileSync(oldF, c.from);
      writeFileSync(newF, newStr);

      const gen = runCli(GEN_CLI, ['--in', newF, '--in-old', oldF, '--out', md]);
      assert.equal(gen.status, 0, `${c.ext}: ${gen.stderr}`);
      const printed = readFileSync(md, 'utf8');
      assert.match(printed, new RegExp(`^# match ${c.name}$`, 'm'), c.ext);

      const ap = runCli(APPLY_CLI, ['--match', md, '--in', oldF, '--out', out]);
      assert.equal(ap.status, 0, `${c.ext}: ${ap.stderr}`);
      assert.equal(readFileSync(out, 'utf8'), newStr, c.ext);

      // sir 0.2.0 wrote the extension there instead: that .md applies the same
      writeFileSync(md, printed.replace(`# match ${c.name}`, `# match ${c.ext.slice(1)}`));
      const old = runCli(APPLY_CLI, ['--match', md, '--in', oldF, '--out', out]);
      assert.equal(old.status, 0, `${c.ext} as 0.2.0 wrote it: ${old.stderr}`);
      assert.equal(readFileSync(out, 'utf8'), newStr, `${c.ext} as 0.2.0 wrote it`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI generate → apply on a CRLF file: the result is the new file byte for byte', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sir-gen-'));
  try {
    const oldF = join(dir, 'old.c');
    const newF = join(dir, 'new.c');
    const md = join(dir, 'patch.sirp');
    const out = join(dir, 'result.c');
    const newStr = 'int f() {\r\n  int a = 5;\r\n  int b = 6;\r\n  int c = 7;\r\n  return a;\r\n}\r\n';
    writeFileSync(oldF, 'int f() {\r\n  int a = 1;\r\n  return a;\r\n}\r\n');
    writeFileSync(newF, newStr);

    const gen = runCli(GEN_CLI, ['--in', newF, '--in-old', oldF, '--out', md]);
    assert.equal(gen.status, 0, gen.stderr);
    const ap = runCli(APPLY_CLI, ['--match', md, '--in', oldF, '--out', out]);
    assert.equal(ap.status, 0, ap.stderr);
    assert.equal(readFileSync(out, 'utf8'), newStr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── -a: one answer per hunk, from a terminal or a pipe ─────────────────────────

function runCliWithInput(cli: readonly string[], args: string[], input: string): CliRun {
  const r = spawnSync('node', ['--experimental-strip-types', ...cli, ...args], {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

const TWO_OLD = 'void f() {\n  a();\n}\n\nvoid g() {\n  b();\n}\n';
const TWO_NEW = 'void f() {\n  a2();\n}\n\nvoid g() {\n  b2();\n}\n';

function withTwoHunks(body: (files: { oldF: string; newF: string; md: string; dir: string }) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sir-review-'));
  try {
    const oldF = join(dir, 'old.cc');
    const newF = join(dir, 'new.cc');
    writeFileSync(oldF, TWO_OLD);
    writeFileSync(newF, TWO_NEW);
    body({ oldF, newF, md: join(dir, 'patch.sirp'), dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('CLI generate -a: y keeps a hunk; n offers the editor, and with no terminal the run stops', () => {
  withTwoHunks(({ oldF, newF, md }) => {
    const r = runCliWithInput(GEN_CLI, ['--in', newF, '--in-old', oldF, '--out', md, '-a'], 'y\nn\n');
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /hunk 1\/2:[\s\S]*keep this hunk\? \[Y\/n\][\s\S]*hunk 2\/2:/);
    assert.match(r.stderr, /hunk 2: declined/);
    assert.match(r.stderr, /writing hunks by hand needs a terminal: stopping, nothing is written/);
    assert.equal(existsSync(md), false, 'no .sirp');

    const all = runCliWithInput(GEN_CLI, ['--in', newF, '--in-old', oldF, '--out', md, '-a'], 'y\n\n');
    assert.equal(all.status, 0, all.stderr);
    assert.equal(parseSirFile(readFileSync(md, 'utf8')).hunks.length, 2, 'y and Enter keep');
  });
});

test('CLI generate -a: an input that closes early stops the run and writes nothing', () => {
  withTwoHunks(({ oldF, newF, md }) => {
    for (const [input, at] of [['', 1], ['y\n', 2]] as const) {
      const r = runCliWithInput(GEN_CLI, ['--in', newF, '--in-old', oldF, '--out', md, '-a'], input);
      assert.equal(r.status, 1, JSON.stringify(input));
      assert.match(r.stderr, new RegExp(`the input closed at hunk ${at} of 2, before it was answered — nothing was written`));
      assert.match(r.stderr, /answer every hunk \(one line each, Enter keeps it\), or drop -a/);
      assert.equal(existsSync(md), false, `${JSON.stringify(input)}: no .sirp`);
    }
  });
});

test('CLI generate: a change that cannot be anchored, with no terminal, is a SynthesisError, exit 8', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sir-unanchored-'));
  try {
    const oldF = join(dir, 'old.cc');
    const newF = join(dir, 'new.cc');
    const old = 'void f() {\n  if (cond) {\n    a();\n    work();\n  }\n  if (cond) {\n    a();\n    work();\n  }\n}\n';
    writeFileSync(oldF, old);
    writeFileSync(newF, old.replace(/work\(\);(?![\s\S]*work\(\);)/, 'work(2);'));

    const plain = runCli(GEN_CLI, ['--in', newF, '--in-old', oldF, '--out', '-']);
    assert.equal(plain.status, 8, plain.stderr);
    assert.match(plain.stderr, /SynthesisError: could not anchor the change at line 8 of the new version — ambiguous match/);
    assert.ok(!plain.stderr.includes('by hand'), 'a script is not offered the editor');

    const reviewed = runCliWithInput(GEN_CLI, ['--in', newF, '--in-old', oldF, '--out', '-', '-a'], '');
    assert.equal(reviewed.status, plain.status, 'the same error, the same code');
    assert.match(reviewed.stderr, /could not be anchored/);
    assert.match(reviewed.stderr, /writing hunks by hand needs a terminal: stopping, nothing is written/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI generate: with and without --out the name is <name of --in>.sirp', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sir-gen-out-'));
  try {
    const oldF = join(dir, 'old.cc');
    const newF = join(dir, 'in.cc');
    writeFileSync(oldF, 'void f() {\n  int a = 1;\n}\n');
    writeFileSync(newF, 'void f() {\n  int a = 2;\n}\n');

    const g1 = runCli(GEN_CLI, ['--in', newF, '--in-old', oldF, '--language', 'cpp']);
    assert.equal(g1.status, 0, g1.stderr);
    assert.match(readFileSync(join(dir, 'in.cc.sirp'), 'utf8'), /# match/);

    const sub = join(dir, 'sub');
    mkdirSync(sub);
    const g2 = runCli(GEN_CLI, ['--in', newF, '--in-old', oldF, '--out', sub, '--language', 'cpp']);
    assert.equal(g2.status, 0, g2.stderr);
    assert.match(readFileSync(join(sub, 'in.cc.sirp'), 'utf8'), /# match/);

    const g3 = runCli(GEN_CLI, ['--in', newF, '--in-old', oldF, '--out', `${dir}/nope/`, '--language', 'cpp']);
    assert.equal(g3.status, 0, g3.stderr);
    assert.match(readFileSync(join(dir, 'nope', 'in.cc.sirp'), 'utf8'), /# match/, 'the directory is created');

    const asDir = runCli(GEN_CLI, ['--in', newF, '--in-old', oldF, '--out', join(dir, 'patches'), '--language', 'cpp']);
    assert.equal(asDir.status, 0, asDir.stderr);
    assert.match(
      readFileSync(join(dir, 'patches', 'in.cc.sirp'), 'utf8'),
      /# match/,
      'a name without an extension is a directory, not a file called that',
    );

    const named = join(dir, 'deep', 'named.sirp');
    const g5 = runCli(GEN_CLI, ['--in', newF, '--in-old', oldF, '--out', named, '--language', 'cpp']);
    assert.equal(g5.status, 0, g5.stderr);
    assert.match(readFileSync(named, 'utf8'), /# match/, 'a path naming a file is written as is');

    const g4 = runCli(GEN_CLI, ['--in', newF, '--in-old', oldF, '--out', '-', '--language', 'cpp']);
    assert.equal(g4.status, 0, g4.stderr);
    assert.match(g4.stdout, /# match/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI generate --branch takes the old version from a git branch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sir-git-'));
  try {
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init', '-q']);
    git(['config', 'user.email', 'a@b.c']);
    git(['config', 'user.name', 'test']);

    const rel = 'f.cc';
    const oldStr = 'void f() {\n  int a = 1;\n}\n';
    const newStr = 'void f() {\n  int a = 2;\n}\n';
    writeFileSync(join(dir, rel), oldStr);
    git(['add', rel]);
    git(['commit', '-q', '-m', 'old']);
    writeFileSync(join(dir, rel), newStr);

    const md = join(dir, 'patch.sirp');
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const gen = runCli(GEN_CLI, ['--in', rel, '--branch', branch, '--out', md, '--language', 'cpp'], dir);
    assert.equal(gen.status, 0, gen.stderr);

    const oldCopy = join(dir, 'oldcopy.cc');
    const out = join(dir, 'result.cc');
    writeFileSync(oldCopy, oldStr);
    const ap = runCli(APPLY_CLI, ['--match', md, '--in', oldCopy, '--out', out]);
    assert.equal(ap.status, 0, ap.stderr);
    assert.equal(readFileSync(out, 'utf8'), newStr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the old version from git ─────────────────────────────────────────────────
//
// WHICH version each coordinate names is settled in test/unit/git-source.test.ts,
// against the resolver itself. What is left for the CLI is its own business: that
// every flag reaches the coordinate it belongs to, that the two sources cannot be
// asked for at once, and that a refusal comes out named.

function generateIn(repo: Repo, args: readonly string[], from = join(repo.dir, 'src', 'core')): CliRun {
  return runCli(GEN_CLI, ['--in', 'f.cc', ...args, '--out', '-', '--language', 'cpp'], from);
}

function assertReplaces(md: string, removed: string, added: string): void {
  assert.match(md, new RegExp(`>>>\\n\\s+${removed}\\n\\s+<<<`), md);
  assert.match(md, new RegExp(`# patch\\n\\s+${added}`), md);
}

test('CLI generate --branch works from a SUBDIRECTORY, not only from the repository root', () => {
  const repo = buildRepo('sir-git-sub-');
  try {
    const gen = generateIn(repo, ['--branch', repo.branch]);
    assert.equal(gen.status, 0, gen.stderr);

    const md = join(repo.dir, 'patch.sirp');
    writeFileSync(md, gen.stdout);
    const src = join(repo.dir, 'copy.cc');
    const out = join(repo.dir, 'result.cc');
    writeFileSync(src, version(2));
    const ap = runCli(APPLY_CLI, ['--match', md, '--in', src, '--out', out]);
    assert.equal(ap.status, 0, ap.stderr);
    assert.equal(readFileSync(out, 'utf8'), version(4));
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('CLI generate --branch takes an ABSOLUTE --in as well', () => {
  const repo = buildRepo('sir-git-abs-');
  try {
    const gen = runCli(GEN_CLI, [
      '--in', repo.inPath, '--branch', repo.branch, '--out', '-', '--language', 'cpp',
    ]);
    assert.equal(gen.status, 0, gen.stderr);
    assert.match(gen.stdout, /^Sir: 2\n(.+\n)*\n# match cpp/);
    assertReplaces(gen.stdout, 'int a = 2;', 'int a = 4;');
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('CLI generate --head: the old version is the last commit of the current branch', () => {
  const repo = buildRepo('sir-git-head-');
  try {
    const gen = generateIn(repo, ['--head']);
    assert.equal(gen.status, 0, gen.stderr);
    assertReplaces(gen.stdout, 'int a = 2;', 'int a = 4;');
    assert.equal(generateIn(repo, ['-H']).stdout, gen.stdout, '-H is the same flag');
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('CLI generate: each coordinate flag reaches the coordinate it belongs to', () => {
  const repo = buildRepo('sir-git-coords-');
  try {
    // All three at once, each naming something only IT can reach: the branch and the
    // commit are `side`, the path is a file no other commit holds. A flag wired to the
    // wrong coordinate cannot produce this answer.
    const all = generateIn(repo, [
      '--branch', 'side', '--commit', repo.s, '--repo-path', 'src/core/side-only.cc',
    ]);
    assert.equal(all.status, 0, all.stderr);
    assert.ok(all.stdout.includes('int side = 1;'), all.stdout);

    const short = generateIn(repo, ['-b', 'side', '-c', repo.s, '--repo-path', 'src/core/side-only.cc']);
    assert.equal(short.stdout, all.stdout, '-b and -c are the same flags');
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('CLI generate: a git refusal comes out named, with a non-zero exit code', () => {
  const repo = buildRepo('sir-git-refusal-');
  try {
    const off = generateIn(repo, ['--branch', repo.branch, '--commit', repo.s]);
    assert.equal(off.status, 1);
    assert.match(off.stderr, /GitError/);
    assert.match(off.stderr, /is not on branch/);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('CLI generate: --in-old and a git coordinate together are refused, and so is neither', () => {
  const repo = buildRepo('sir-git-both-');
  try {
    for (const args of [['--in-old', 'other.cc', '--head'], ['--in-old', 'other.cc', '-b', 'side'], []]) {
      const r = generateIn(repo, args);
      assert.equal(r.status, 1, `expected a refusal for ${args.join(' ')}`);
      assert.match(r.stderr, /exactly one source of the OLD version/);
    }
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('CLI generate: a source asked for twice, or not at all, is answered by naming both', () => {
  const repo = buildRepo('sir-cli-source-');
  const old = ['--in-old', join(repo.dir, 'src', 'core', 'other.cc')];
  const cases: readonly (readonly [readonly string[], RegExp])[] = [
    [[...old, '--head'], /exactly one source of the OLD version[\s\S]*not both/],
    [[...old, '-b', 'side'], /not both/],
    [[...old, '-c', repo.a], /not both/],
    [[...old, '--repo-path', 'src/core/other.cc'], /not both/],
    [[...old, '--head', '-b', 'side', '-c', repo.a], /not both/],
    [[], /exactly one source of the OLD version/],
  ];
  try {
    for (const [args, expected] of cases) {
      const r = generateIn(repo, args);
      assert.equal(r.status, 1, `expected a refusal for: ${args.join(' ')}`);
      assert.match(r.stderr, expected, `for: ${args.join(' ')}`);
      // The message names every flag involved, so the whole usage is not dumped on top
      // of it — that is kept for a slip of the FINGERS, where the list is the answer.
      assert.doesNotMatch(r.stderr, /sir generate —/, `for: ${args.join(' ')}`);
    }
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('CLI generate: a misspelt or valueless option is answered with the option and the usage', () => {
  const repo = buildRepo('sir-cli-spelling-');
  // generateIn appends `--out - --language cpp`, so an option left without a value here
  // runs into --out — which is exactly the slip being tested.
  const cases: readonly (readonly [readonly string[], RegExp])[] = [
    [['--brnach', 'side'], /unknown argument: --brnach[\s\S]*did you mean --branch\?/],
    [['--repo_path', 'src/core/other.cc'], /did you mean --repo-path\?/],
    [['--heat'], /did you mean --head\?/],
    [['--comit', 'x'], /did you mean --commit\?/],
    [['--head', 'stray'], /unknown argument: stray[\s\S]*a value goes after its option/],
    [['-b'], /option -b needs a value, and --out is another option/],
    [['--commit'], /option --commit needs a value, and --out is another option/],
    [['--repo-path'], /option --repo-path needs a value, and --out is another option/],
  ];
  try {
    for (const [args, expected] of cases) {
      const r = generateIn(repo, args);
      assert.equal(r.status, 1, `expected a refusal for: ${args.join(' ')}`);
      assert.match(r.stderr, expected, `for: ${args.join(' ')}`);
      assert.match(r.stderr, /sir generate —/, `the usage follows a slip: ${args.join(' ')}`);
    }
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('CLI generate --head sits beside the coordinates rather than fighting them', () => {
  const repo = buildRepo('sir-cli-head-with-');
  try {
    const withHead = generateIn(repo, ['--head', '--repo-path', 'src/core/side-only.cc', '--branch', 'side']);
    const without = generateIn(repo, ['--repo-path', 'src/core/side-only.cc', '--branch', 'side']);
    assert.equal(withHead.status, 0, withHead.stderr);
    assert.equal(withHead.stdout, without.stdout, '--head asks for git, the coordinates say which version');
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('CLI generate --yes: what would be asked about is read, the rest is still refused', () => {
  const repo = buildRepo('sir-cli-yes-');
  try {
    const off = generateIn(repo, ['--branch', repo.branch, '--commit', repo.s, '--yes']);
    assert.equal(off.status, 0, off.stderr);
    assert.match(off.stderr, /warning: commit .* is not on branch/);
    assertReplaces(off.stdout, 'int a = 3;', 'int a = 4;');

    const tag = generateIn(repo, ['--branch', 'v1.0', '-y']);
    assert.equal(tag.status, 0, tag.stderr);
    assertReplaces(tag.stdout, 'int a = 2;', 'int a = 4;');

    const none = generateIn(repo, ['--branch', 'nope', '--yes']);
    assert.equal(none.status, 1, 'nothing to read is not a question --yes can answer');
    assert.match(none.stderr, /no such branch/);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('CLI generate --head outside a repository fails with a named error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sir-git-nohead-'));
  try {
    writeFileSync(join(dir, 'f.cc'), version(4));
    const gen = runCli(GEN_CLI, ['--in', 'f.cc', '--head', '--out', '-', '--language', 'cpp'], dir);
    assert.equal(gen.status, 1);
    assert.match(gen.stderr, /GitError/);
    assert.match(gen.stderr, /needs a git repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('README "The file format": generate never writes notes — rerun over a .sirp, the notes go with the rest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sir-gen-note-'));
  try {
    const oldF = join(dir, 'old.cc');
    const newF = join(dir, 'a.cc');
    const out = join(dir, 'a.cc.sirp');
    writeFileSync(oldF, 'void f() {\n  int a = 1;\n}\n');
    writeFileSync(newF, 'void f() {\n  int a = 2;\n}\n');
    const first = runCli(GEN_CLI, ['--in', newF, '--in-old', oldF, '--out', out, '--no-config']);
    assert.equal(first.status, 0, first.stderr);
    const noted = readFileSync(out, 'utf8').replace('# match', '# note\nwhy: a person wrote this\n# end\n# match');
    writeFileSync(out, noted);
    const again = runCli(GEN_CLI, ['--in', newF, '--in-old', oldF, '--out', out, '--no-config']);
    assert.equal(again.status, 0, again.stderr);
    assert.doesNotMatch(readFileSync(out, 'utf8'), /# note/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI generate with "upstream": ".": the patch tree repeats the path inside the repository; --mirror is gone', () => {
  const root = mkdtempSync(join(tmpdir(), 'sir-gen-tree-'));
  try {
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'chromium_src', 'browser', 'core'), { recursive: true });
    const oldF = join(root, 'old.cc');
    const newF = join(root, 'chromium_src', 'browser', 'core', 'apdate.cc');
    writeFileSync(oldF, 'void f() {\n  int a = 1;\n}\n');
    writeFileSync(newF, 'void f() {\n  int a = 2;\n}\n');
    writeFileSync(join(root, 'sir.config.json'), JSON.stringify({ version: 3, upstream: '.', generate: { out: 'patches' } }));

    const ok = runCli(GEN_CLI, ['--in', newF, '--in-old', oldF, '--language', 'cpp']);
    assert.equal(ok.status, 0, ok.stderr);
    const written = join(root, 'patches', 'chromium_src', 'browser', 'core', 'apdate.cc.sirp');
    assert.match(readFileSync(written, 'utf8'), /^Sir: 2\nTarget: chromium_src\/browser\/core\/apdate\.cc\n/, 'missing directories are created');

    const mirror = runCli(GEN_CLI, ['--in', newF, '--in-old', oldF, '--mirror', '--out', 'patches']);
    assert.equal(mirror.status, 1, mirror.stderr);
    assert.match(mirror.stderr, /--mirror/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI generate: a plain refusal for a missing input and for a directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sir-gen-in-'));
  try {
    const oldF = join(dir, 'old.cc');
    writeFileSync(oldF, 'void f() {\n  a();\n}\n');
    mkdirSync(join(dir, 'sub'));

    const missing = runCli(GEN_CLI, ['--in', join(dir, 'nope.cc'), '--in-old', oldF, '--language', 'cpp']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /no such file: .*nope\.cc \(--in\)/);

    const isDir = runCli(GEN_CLI, ['--in', join(dir, 'sub'), '--in-old', oldF, '--language', 'cpp']);
    assert.equal(isDir.status, 1);
    assert.match(isDir.stderr, /--in takes a file, and .*sub is a directory/);

    const oldIsDir = runCli(GEN_CLI, ['--in', oldF, '--in-old', join(dir, 'sub'), '--language', 'cpp']);
    assert.equal(oldIsDir.status, 1);
    assert.match(oldIsDir.stderr, /--in-old takes a file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── generatePatch: what it passes on, and how it prints `keep` ─────────────────────

const HEAD = (s: string): string => s.slice(s.indexOf('# match'));
const F_OLD = 'void f() {\n  a();\n}\n';
const F_NEW = 'void f() {\n  a2();\n}\n';
const KEEP_F = '# match cpp\n    ...\n    void f() {\n    ...\n    >>>\n      a();\n    <<<\n    ...\n# end\n# patch\n    a2();\n# end\n';

test('generatePatch: no change says which comparison found none — normalized, or byte for byte', async () => {
  await assert.rejects(
    generatePatch({ oldText: 'int a;\n', newText: 'int  a;\n', language: 'cpp' }),
    (e) => e instanceof NoChanges && e.message === 'the new version is the base once normalized (spacing, blank lines) — no patch to write',
  );
  await assert.rejects(
    generatePatch({ oldText: 'int a;\n', newText: 'int a;\n', language: 'cpp', exact: true }),
    (e) => e instanceof NoChanges && e.message === 'the new version is the base, byte for byte — no patch to write',
  );
  const spacing = await generatePatch({ oldText: 'int a;\n', newText: 'int  a;\n', language: 'cpp', exact: true });
  assert.equal(spacing.hunkCount, 1, 'with exact, spacing alone is a change');
});

test('generatePatch: blank lines alone are no change in Python either, though its canon keeps them inside a line', async () => {
  await assert.rejects(generatePatch({ oldText: 'x = 1\n\ny = 2\n', newText: 'x = 1\ny = 2\n', language: 'python' }), NoChanges);
});

test('generatePatch: bridgeGap is passed on — two changes one line apart become one hunk', async () => {
  const oldText = 'void f() {\n  a();\n  k();\n  b();\n}\n';
  const newText = 'void f() {\n  a2();\n  k();\n  b2();\n}\n';
  assert.equal((await generatePatch({ oldText, newText, language: 'cpp' })).hunkCount, 2);
  assert.equal((await generatePatch({ oldText, newText, language: 'cpp', bridgeGap: 1 })).hunkCount, 1);
});

// a CRLF base, and a new line ending in LF: a patch writes the base's endings, so only a
// normalized comparison is met
const CR_OLD = 'void f() {\r\n  a();\r\n  b();\r\n}\r\n';
const CR_NEW = 'void f() {\r\n  a();\n  x();\r\n  b();\r\n}\r\n';

test('generatePatch: exact is passed on to synthesis — what cannot be written byte for byte is refused, with no draft', async () => {
  assert.equal((await generatePatch({ oldText: CR_OLD, newText: CR_NEW, language: 'cpp' })).hunkCount, 1);
  await assert.rejects(
    generatePatch({ oldText: CR_OLD, newText: CR_NEW, language: 'cpp', exact: true }),
    (e) => e instanceof SynthesisError && e.reason === 'unreproduced' && e.draft === undefined && !('draft' in e.detail()),
  );
});

test('generatePatch: review is handed the hunks synthesis made, and what it returns is printed', async () => {
  const seen: number[] = [];
  const out = await generatePatch({
    oldText: F_OLD,
    newText: F_NEW,
    language: 'cpp',
    review: async (hunks) => (seen.push(hunks.length), []),
  });
  assert.deepEqual(seen, [1]);
  assert.equal(out.hunkCount, 0);
  assert.ok(!out.md.includes('# match'));
});

test('generatePatch with keep: a keep that gives the new version warns of nothing', async () => {
  const out = await generatePatch({ oldText: F_OLD, newText: F_NEW, language: 'cpp', keep: KEEP_F, provenance: true });
  assert.deepEqual(out.warnings, []);
  assert.equal(out.reproducesNew, true);
});

test('generatePatch with keep: exact is passed on — a keep met only once normalized warns', async () => {
  const oldText = 'void f() {\r\n  a();\r\n}\r\n';
  const newText = 'void f() {\r\n  a2();\n}\r\n';
  assert.deepEqual((await generatePatch({ oldText, newText, language: 'cpp', keep: KEEP_F })).warnings, []);
  assert.deepEqual((await generatePatch({ oldText, newText, language: 'cpp', keep: KEEP_F, exact: true })).warnings, [
    'the patch does not give the new version: changes were left out, or hunks edited by hand make it differ',
  ]);
});

test('generatePatch with keep: its hunks are printed as written — the blank lines between them too — and end in one newline', async () => {
  const oldText = 'void f() {\n  a();\n}\nvoid g() {\n  b();\n}\n';
  const newText = 'void f() {\n  a2();\n}\nvoid g() {\n  b2();\n}\n';
  const second = KEEP_F.replace('void f()', 'void g()').replace('  a();', '  b();').replace('a2();', 'b2();');
  const keep = `prose a person left\n\n${KEEP_F}\n\n\n${second}\n\n\n`;
  const out = await generatePatch({ oldText, newText, language: 'cpp', keep });
  assert.equal(HEAD(out.md), `${KEEP_F}\n\n\n${second}`);
});

test('generatePatch with keep: the hunks made after it follow one blank line below, however keep ended', async () => {
  const oldText = 'void f() {\n  a();\n}\nvoid g() {\n  b();\n}\n';
  const newText = 'void f() {\n  a2();\n}\nvoid g() {\n  b2();\n}\n';
  const out = await generatePatch({ oldText, newText, language: 'cpp', keep: `${KEEP_F}\n\n\n` });
  assert.ok(HEAD(out.md).startsWith(`${KEEP_F}\n# match cpp\n    ...\n    void g() {`), HEAD(out.md));
});

test('patchHeader: Grammar is <package>@<version>; a grammar with no package, or no version, is named by its file', () => {
  const header = (grammar: object): string => patchHeader({ adapter: { grammar } as never });
  assert.match(header({ file: 'a.wasm', package: 'tree-sitter-a', version: '1.2.3' }), /^Grammar: tree-sitter-a@1\.2\.3$/m);
  assert.match(header({ file: 'b.wasm' }), /^Grammar: b\.wasm$/m);
  assert.match(header({ file: 'c.wasm', package: 'tree-sitter-c' }), /^Grammar: c\.wasm$/m);
  assert.match(header({ file: 'd.wasm', version: '1.0.0' }), /^Grammar: d\.wasm$/m);
});

test('hunksOf: a .sirp from its first heading on — header and prose dropped, every byte after kept', () => {
  assert.equal(hunksOf('Sir: 2\n\nprose\n# match cpp\n    x\n# end\n\n\n'), '# match cpp\n    x\n# end\n\n\n');
  assert.equal(hunksOf('Sir: 2\r\n\r\n# note\r\nwhy\r\n# end\r\n# match cpp\r\n'), '# note\r\nwhy\r\n# end\r\n# match cpp\r\n');
  assert.equal(hunksOf('no heading at all\n  # match cpp\n'), 'no heading at all\n  # match cpp\n', 'a heading not at column 0 is none');
});
