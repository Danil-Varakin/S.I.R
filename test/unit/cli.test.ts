import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = fileURLToPath(new URL('../../src/bin/hatch.ts', import.meta.url));
const PKG = fileURLToPath(new URL('../../package.json', import.meta.url));

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('node', ['--experimental-strip-types', CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

test('bare invocation prints the usage and succeeds', () => {
  const r = run([]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /hatch <command>/);
  for (const name of ['apply', 'generate', 'init']) assert.match(r.stdout, new RegExp(`\\b${name}\\b`));
  assert.doesNotMatch(r.stdout, /\bgrammars\b/, 'the command is gone (F2: it warned through 0.4)');
});

test('--version reports the package version AND the config schema version', () => {
  const pkg = JSON.parse(readFileSync(PKG, 'utf8')) as { version: string; name: string };
  const r = run(['--version']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, new RegExp(pkg.version.replace(/\./g, '\\.')));
  assert.match(r.stdout, /config schema v\d+/);
});

test('help and version work as words, not only as flags', () => {
  assert.match(run(['help']).stdout, /hatch <command>/);
  assert.match(run(['version']).stdout, /config schema v\d+/);
  assert.match(run(['help', 'generate']).stdout, /hatch generate —/);
});

test('an unknown command names the known ones and exits 1', () => {
  const r = run(['aply']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown command 'aply'/);
  assert.match(r.stderr, /known commands: apply, generate, init/);
});

test('a name every object inherits is an unknown command, not a crash', () => {
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const r = run([name]);
    assert.equal(r.status, 1, name);
    assert.match(r.stderr, new RegExp(`unknown command '${name}'`), name);
    const help = run(['help', name]);
    assert.equal(help.status, 0, `help ${name}: ${help.stderr}`);
    assert.match(help.stdout, /hatch <command>/, `help ${name}`);
  }
});

test('a flag in the command slot gets its own sentence, not the list', () => {
  const r = run(['--in', 'x.cc']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /options come AFTER the command/);
});

test('a command forwards its own --help, not the dispatcher\'s', () => {
  const r = run(['generate', '--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /hatch generate —/);
  assert.match(r.stdout, /--in-old/);
});

test('a command keeps its own exit code through the dispatcher', () => {
  const r = run(['generate']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing --in/);
});

test('the dispatcher lists exactly the commands it can load', async () => {
  const usage = run([]).stdout;
  const listed = [...usage.matchAll(/^ {2}(\w+) {2,}/gm)].map((m) => m[1] ?? '');
  for (const name of listed) {
    if (name === '' || name === 'hatch') continue;
    const r = run([name, '--help']);
    assert.equal(r.status, 0, `${name} --help failed: ${r.stderr}`);
  }
});

test('apply --eol: checked always, and refused with no version out of git to apply it to', () => {
  const bad = run(['apply', '-m', 'a.hatch', '-i', 'a.cc', '--dry-run', '--eol', 'crlf']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--eol crlf: one of repository, worktree/);

  const alone = run(['apply', '-m', 'a.hatch', '-i', 'a.cc', '--dry-run', '--eol', 'worktree']);
  assert.equal(alone.status, 1);
  assert.match(alone.stderr, /--eol sets the line endings of a version read out of git, and none is named/);
});

test('apply: a patch is a .hatch file — a .md is refused before it is read', () => {
  const r = run(['apply', '-m', 'p.md', '-i', 'a.cc', '--dry-run']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /a patch is a \.hatch file/);
  assert.match(r.stderr, /git mv x\.md x\.hatch/);
});

// ── apply: what it needs, and what it says when it is missing ────────────────────────

function runIn(dir: string, args: string[]): { status: number; stderr: string } {
  const r = spawnSync('node', ['--experimental-strip-types', '--no-warnings', CLI, ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status ?? -1, stderr: r.stderr };
}

test('apply: no --match, no --out — each named, exit 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hatch-cli-'));
  try {
    writeFileSync(join(dir, 'a.cc'), 'int a;\n');
    writeFileSync(join(dir, 'p.hatch'), '# match cpp\n    >>>\n    ...\n# end\n# patch\n    x\n# end\n');
    assert.deepEqual(runIn(dir, ['apply', '--in', 'a.cc', '--out', 'o.cc']), { status: 1, stderr: 'error: missing --match <file.hatch>\n' });
    assert.deepEqual(runIn(dir, ['apply', '--match', 'p.hatch', '--in', 'a.cc']), {
      status: 1,
      stderr: 'error: missing --out <file> (or use --dry-run / --verify)\n',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply without --in: a patch with no Target outside the patch tree names no file, and says why', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hatch-cli-'));
  try {
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, 'hatch.config.json'), JSON.stringify({ version: 2, upstream: '.', generate: { out: 'patches' } }));
    mkdirSync(join(dir, 'elsewhere'));
    writeFileSync(join(dir, 'elsewhere', 'x.cc.hatch'), '# match cpp\n    >>>\n    ...\n# end\n# patch\n    x\n# end\n');
    const r = runIn(dir, ['apply', '--match', join('elsewhere', 'x.cc.hatch'), '--dry-run']);
    assert.equal(r.status, 1);
    assert.equal(r.stderr, 'error: missing --in <file>: the patch names no file it is for (outside-out) — give --in\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply without --in: the file the patch is for, and how it was found, when it is not there', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hatch-cli-'));
  try {
    const body = '# match cpp\n    >>>\n    ...\n# end\n# patch\n    x\n# end\n';
    writeFileSync(join(dir, 'named.hatch'), `Hatch: 1\nTarget: nosuch.cc\n\n${body}`);
    mkdirSync(join(dir, 'd'));
    writeFileSync(join(dir, 'd', 'zz.cc.hatch'), body);
    const byTarget = runIn(dir, ['apply', '--match', 'named.hatch', '--dry-run']);
    assert.equal(byTarget.status, 1);
    assert.match(byTarget.stderr, /^error: missing --in <file>: the patch is for .*nosuch\.cc \(its Target names\), and there is no such file — give --in\n$/);
    const byPlace = runIn(join(dir, 'd'), ['apply', '--match', 'zz.cc.hatch', '--dry-run']);
    assert.equal(byPlace.status, 1);
    assert.match(byPlace.stderr, /^error: missing --in <file>: the patch is for .*d\/zz\.cc \(by its name and place it would be\), and there is no such file — give --in\n$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
