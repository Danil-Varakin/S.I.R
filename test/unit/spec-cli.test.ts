import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { sirMd } from '../helpers.ts';

// Audit 2026-10-05: the CLI against README — "Exit codes", "apply options", "generate
// options", the --out table, "Grammars", "Known limitations". Expectations come from those
// sentences, not from what the code prints today.

const CLI = fileURLToPath(new URL('../../src/bin/sir.ts', import.meta.url));

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function sir(cwd: string, args: readonly string[], env: Record<string, string> = {}): Run {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function sirAsync(cwd: string, args: readonly string[]): Promise<Run> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', CLI, ...args], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}

function inTemp(prefix: string, body: (dir: string) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    try {
      await body(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function repoAt(dir: string, files: Record<string, string>): void {
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'a@b.c');
  git(dir, 'config', 'user.name', 'test');
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'c');
}

const SRC = 'void f() {\n  a();\n}\n';
const INSERT = sirMd([{ match: '...\na();\n>>>\n...', patch: '\n  b();' }]);
const PATCHED = 'void f() {\n  a();\n  b();\n}\n';

// ── README "Exit codes": the ones no test ran through the CLI ────────────────────────

test('exit 2: a .sirp that does not parse', inTemp('sir-x2-', (dir) => {
  writeFileSync(join(dir, 'a.cc'), SRC);
  writeFileSync(join(dir, 'p.sirp'), '# match cpp\nno gutter\n# end\n');
  const r = sir(dir, ['apply', '--match', 'p.sirp', '--in', 'a.cc', '--out', '-', '--no-config']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /ParseError/);
  assert.match(r.stderr, /line 2/, 'the line of the .sirp is named');
}));

test('exit 4: an ambiguous match — "you get exit 4 and the positions"', inTemp('sir-x4-', (dir) => {
  writeFileSync(join(dir, 'a.cc'), 'void f() {\n  ping();\n  ping();\n}\n');
  writeFileSync(join(dir, 'p.sirp'), sirMd([{ match: '...\nping();\n>>>\n...', patch: 'X();' }]));
  const r = sir(dir, ['apply', '--match', 'p.sirp', '--in', 'a.cc', '--out', '-', '--no-config']);
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /AmbiguityError/);
  assert.ok((r.stderr.match(/line \d+/g) ?? []).length >= 2, `both positions are reported:\n${r.stderr}`);
  assert.equal(r.stdout, '', 'nothing written to stdout');
}));

test('exit 6: "a file with another sha256 fails the run" — SIR_GRAMMAR_DIR holding a grammar that is not the pin', inTemp('sir-x6-', (dir) => {
  const grammars = join(dir, 'grammars');
  mkdirSync(grammars);
  writeFileSync(join(grammars, 'tree-sitter-cpp.wasm'), 'not the pinned bytes');
  writeFileSync(join(dir, 'a.cc'), SRC);
  writeFileSync(join(dir, 'p.sirp'), INSERT);
  const r = sir(dir, ['apply', '--match', 'p.sirp', '--in', 'a.cc', '--out', '-', '--no-config'], { SIR_GRAMMAR_DIR: grammars });
  assert.equal(r.status, 6, r.stderr);
  assert.match(r.stderr, /GrammarError/);
}));

test('exit 1: "a wrong invocation, a missing file, an unknown language"', inTemp('sir-x1-', (dir) => {
  writeFileSync(join(dir, 'a.cc'), SRC);
  writeFileSync(join(dir, 'p.sirp'), INSERT);
  const cases: readonly (readonly [string, readonly string[]])[] = [
    ['unknown language', ['apply', '--match', 'p.sirp', '--in', 'a.cc', '--out', '-', '--no-config', '--language', 'cobol']],
    ['missing --match file', ['apply', '--match', 'nope.sirp', '--in', 'a.cc', '--out', '-', '--no-config']],
    ['missing --in file', ['apply', '--match', 'p.sirp', '--in', 'nope.cc', '--out', '-', '--no-config']],
    ['missing --in-old file', ['generate', '--in', 'a.cc', '--in-old', 'nope.cc', '--out', '-', '--no-config']],
  ];
  for (const [name, args] of cases) {
    const r = sir(dir, args);
    assert.equal(r.status, 1, `${name}: ${r.stderr}`);
  }
}));

test('exit 1: git cannot be run — "never a question", and not a crash', inTemp('sir-nogit-', (dir) => {
  repoAt(dir, { 'a.cc': SRC });
  const empty = join(dir, 'empty-path');
  mkdirSync(empty);
  const r = sir(dir, ['generate', '--in', 'a.cc', '--head', '--out', '-', '--no-config', '--yes'], { PATH: empty });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /GitError/);
}));

// ── apply options ────────────────────────────────────────────────────────────────────

test('apply --dry-run: "show planned edits, write nothing" — not even with --out', inTemp('sir-dry-', (dir) => {
  writeFileSync(join(dir, 'a.cc'), SRC);
  writeFileSync(join(dir, 'p.sirp'), INSERT);
  const r = sir(dir, ['apply', '--match', 'p.sirp', '--in', 'a.cc', '--out', 'out.cc', '--dry-run', '--no-config']);
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(r.stdout + r.stderr, '', 'the planned edits are shown');
  assert.equal(existsSync(join(dir, 'out.cc')), false, 'nothing written');
  assert.equal(readFileSync(join(dir, 'a.cc'), 'utf8'), SRC, 'the input untouched');
}));

test('apply: "a file that already holds the result is not written at all (already so: not written): it keeps its mtime"', inTemp('sir-already-', (dir) => {
  repoAt(dir, { 'a.cc': SRC });
  writeFileSync(join(dir, 'p.sirp'), INSERT);
  writeFileSync(join(dir, 'a.cc'), PATCHED);
  const before = statSync(join(dir, 'a.cc'), { bigint: true });
  const r = sir(dir, ['apply', '--match', 'p.sirp', '--in', 'a.cc', '--head', '--out', 'a.cc', '--no-config']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout + r.stderr, /already so: not written/);
  const after = statSync(join(dir, 'a.cc'), { bigint: true });
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.ino, before.ino);
  assert.equal(readFileSync(join(dir, 'a.cc'), 'utf8'), PATCHED);
}));

test('F2: apply --download-grammars is gone — it warned through 0.4', inTemp('sir-dlg-', (dir) => {
  writeFileSync(join(dir, 'a.cc'), SRC);
  writeFileSync(join(dir, 'p.sirp'), INSERT);
  const r = sir(dir, ['apply', '--match', 'p.sirp', '--in', 'a.cc', '--out', '-', '--no-config', '--download-grammars']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown argument: --download-grammars/);
  assert.doesNotMatch(sir(dir, ['apply', '--help']).stdout, /download-grammars/, 'and out of the help');
}));

test('apply --log <dir>/: "every run gets its own file, mode 0600" — two runs at once', inTemp('sir-log-', async (dir) => {
  writeFileSync(join(dir, 'a.cc'), SRC);
  writeFileSync(join(dir, 'p.sirp'), INSERT);
  const logs = join(dir, 'logs');
  const args = ['apply', '--match', 'p.sirp', '--in', 'a.cc', '--out', '-', '--no-config', '--log', `${logs}/`];
  const runs = await Promise.all([sirAsync(dir, args), sirAsync(dir, args)]);
  for (const r of runs) assert.equal(r.status, 0, r.stderr);
  const files = readdirSync(logs);
  assert.equal(files.length, 2, `two runs, two files: ${files.join(', ')}`);
  if (process.platform !== 'win32') {
    for (const f of files) assert.equal(statSync(join(logs, f)).mode & 0o777, 0o600, f);
  }
}));

test('apply: two runs writing one --out at once — "a run cut short never leaves half a file"; each run whole, one wins', inTemp('sir-race-', async (dir) => {
  writeFileSync(join(dir, 'a.cc'), SRC);
  writeFileSync(join(dir, 'p1.sirp'), sirMd([{ match: '...\na();\n>>>\n...', patch: `\n  ${'one();'.repeat(2000)}` }]));
  writeFileSync(join(dir, 'p2.sirp'), sirMd([{ match: '...\na();\n>>>\n...', patch: `\n  ${'two();'.repeat(2000)}` }]));
  const expected = (p: string): string => sir(dir, ['apply', '--match', p, '--in', 'a.cc', '--out', '-', '--no-config']).stdout;
  const one = expected('p1.sirp');
  const two = expected('p2.sirp');
  for (let round = 0; round < 5; round++) {
    const out = `out${round}.cc`;
    const runs = await Promise.all(
      ['p1.sirp', 'p2.sirp', 'p1.sirp', 'p2.sirp'].map((p) =>
        sirAsync(dir, ['apply', '--match', p, '--in', 'a.cc', '--out', out, '--no-config']),
      ),
    );
    for (const r of runs) assert.equal(r.status, 0, `round ${round}: ${r.stderr}`);
    const text = readFileSync(join(dir, out), 'utf8');
    assert.ok(text === one || text === two, `round ${round}: the file is one whole result, not a mix (${text.length} chars)`);
  }
  assert.deepEqual(readdirSync(dir).filter((f) => !/^(a\.cc|p[12]\.sirp|out\d\.cc)$/.test(f)), [], 'no temp files left behind');
}));

test('apply: an --out that cannot be written is exit 1, and leaves nothing', inTemp('sir-ro-', (dir) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return;
  writeFileSync(join(dir, 'a.cc'), SRC);
  writeFileSync(join(dir, 'p.sirp'), INSERT);
  const ro = join(dir, 'ro');
  mkdirSync(ro);
  chmodSync(ro, 0o555);
  try {
    const r = sir(dir, ['apply', '--match', 'p.sirp', '--in', 'a.cc', '--out', join(ro, 'out.cc'), '--no-config']);
    assert.equal(r.status, 1, r.stderr);
    assert.deepEqual(readdirSync(ro), []);
    assert.doesNotMatch(r.stderr, /^\s+at .+:\d+:\d+\)?$/m, 'a sentence, not a stack trace');
  } finally {
    chmodSync(ro, 0o755);
  }
}));

// ── generate options and the --out table ─────────────────────────────────────────────

const OLD = 'void f() {\n  int a = 1;\n}\n';
const NEW = 'void f() {\n  int a = 2;\n}\n';

test('--out table: "p.md, p.txt — refused, exit 5", and before a single file is read', inTemp('sir-ext-', (dir) => {
  writeFileSync(join(dir, 'a.cc'), NEW);
  for (const out of ['p.txt', 'p.patch', 'deep/p.diff']) {
    const r = sir(dir, ['generate', '--in', 'a.cc', '--in-old', 'missing.cc', '--out', out, '--no-config']);
    assert.equal(r.status, 5, `${out}: ${r.stderr}`);
    assert.equal(existsSync(join(dir, out)), false, out);
  }
}));

test('--out table: the same refusal when generate.out in the config names a file that is not .sirp', inTemp('sir-ext-cfg-', (dir) => {
  writeFileSync(join(dir, 'a.cc'), NEW);
  writeFileSync(join(dir, 'sir.config.json'), JSON.stringify({ version: 3, generate: { out: 'p.txt' } }));
  const r = sir(dir, ['generate', '--in', 'a.cc', '--in-old', 'missing.cc']);
  assert.equal(r.status, 5, r.stderr);
}));

test('--out table: "an absolute path — Target none when the patch is outside the repository"', inTemp('sir-abs-', (dir) => {
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  repoAt(repo, { 'a.cc': OLD });
  writeFileSync(join(repo, 'a.cc'), NEW);
  const outside = join(dir, 'elsewhere', 'a.sirp');
  const r = sir(repo, ['generate', '--in', 'a.cc', '--head', '--out', outside, '--no-config']);
  assert.equal(r.status, 0, r.stderr);
  const text = readFileSync(outside, 'utf8');
  assert.match(text, /^Sir: 2\n/);
  assert.doesNotMatch(text.slice(0, text.indexOf('\n\n')), /^Target:/m);
}));

test('--out table: "with upstream and - … refused, exit 5"', inTemp('sir-up-stdout-', (dir) => {
  mkdirSync(join(dir, '.git'));
  writeFileSync(join(dir, 'sir.config.json'), JSON.stringify({ version: 3, upstream: '.', generate: { out: 'patches' } }));
  writeFileSync(join(dir, 'old.cc'), OLD);
  writeFileSync(join(dir, 'a.cc'), NEW);
  const r = sir(dir, ['generate', '--in', 'a.cc', '--in-old', 'old.cc', '--out', '-']);
  assert.equal(r.status, 5, r.stderr);
  assert.equal(r.stdout, '', 'nothing on stdout');
}));

test('generate twice into the same place: the same file, byte for byte', inTemp('sir-gen-twice-', (dir) => {
  writeFileSync(join(dir, 'old.cc'), OLD);
  writeFileSync(join(dir, 'a.cc'), NEW);
  const args = ['generate', '--in', 'a.cc', '--in-old', 'old.cc', '--out', 'p.sirp', '--no-config'];
  assert.equal(sir(dir, args).status, 0);
  const first = readFileSync(join(dir, 'p.sirp'), 'utf8');
  assert.equal(sir(dir, args).status, 0);
  assert.equal(readFileSync(join(dir, 'p.sirp'), 'utf8'), first);
}));

test('generate: "generate warns when it emits such a line" — a payload line of significant trailing whitespace', inTemp('sir-trail-', (dir) => {
  writeFileSync(join(dir, 'old.cc'), OLD);
  writeFileSync(join(dir, 'a.cc'), 'void f() {\n  int a = 2;   \n}\n');
  const r = sir(dir, ['generate', '--in', 'a.cc', '--in-old', 'old.cc', '--out', '-', '--no-config', '--exact']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /warning/i);
  assert.match(r.stderr, /trailing|whitespace/i);
}));

test('generate exit 7: "spacing and blank lines alone are no change" — and no .sirp is written', inTemp('sir-x7-', (dir) => {
  writeFileSync(join(dir, 'old.cc'), OLD);
  writeFileSync(join(dir, 'a.cc'), '\nvoid  f()  {\n\n      int a=1;\n}\n\n');
  const r = sir(dir, ['generate', '--in', 'a.cc', '--in-old', 'old.cc', '--no-config']);
  assert.equal(r.status, 7, r.stderr);
  assert.equal(existsSync(join(dir, 'a.cc.sirp')), false);
  assert.equal(sir(dir, ['generate', '--in', 'a.cc', '--in-old', 'old.cc', '--no-config', '--exact', '--out', '-']).status, 0, 'with --exact it is a change');
}));
