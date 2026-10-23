import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { SPEC as APPLY_SPEC } from '../../src/cli/apply.ts';
import { binSpec } from '../../src/cli/sir-apply.ts';
import { knownOptions } from '../../src/cli/args.ts';

const ENTRY = fileURLToPath(new URL('../../src/bin/sir-apply.ts', import.meta.url));
const BINARY = process.env['SIR_APPLY_BIN'];
const RUNNERS: { name: string; argv: string[] }[] = [
  { name: 'node', argv: [process.execPath, '--experimental-strip-types', ENTRY] },
  ...(BINARY !== undefined && BINARY !== '' ? [{ name: 'binary', argv: [resolve(BINARY)] }] : []),
];

const OLD = 'void f() {\n  int a = 1;\n}\n';
const NEW = 'void f() {\n  int a = 2;\n}\n';
const PATCH = (target?: string): string =>
  `Sir: 2\n${target !== undefined ? `Target: ${target}\n` : ''}\n# match cpp\n    ...\n    int a = 1;\n    >>>\n    ...\n# end\n# patch\n      int b = 2;\n# end\n`;

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function repoAt(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'a@b.c');
  git(dir, 'config', 'user.name', 'test');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'c', '--allow-empty');
}

function temp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

test('F2: every option of sir-apply is an option of sir apply, with the same meaning', () => {
  const groups = ['flags', 'negated', 'values', 'counts', 'optional'] as const;
  const meaning = (spec: typeof APPLY_SPEC, option: string): string | undefined => {
    for (const g of groups) if (spec[g]?.[option] !== undefined) return `${g}:${spec[g]![option]}`;
    return undefined;
  };
  for (const command of ['apply', 'verify'] as const) {
    const bin = binSpec(command);
    for (const option of knownOptions(bin)) {
      assert.equal(meaning(bin, option), meaning(APPLY_SPEC, option), `${command} ${option}`);
    }
  }
  assert.ok(knownOptions(binSpec('apply')).has('--config'), 'sir-apply takes --config');
  assert.ok(knownOptions(APPLY_SPEC).has('--config'), 'so sir apply takes it too');
  assert.ok(!knownOptions(binSpec('verify')).has('--out'), 'verify writes nothing');
});

for (const runner of RUNNERS) {
  const run = (cwd: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } => {
    const [cmd, ...pre] = runner.argv;
    const r = spawnSync(cmd!, [...pre, ...args], { cwd, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  test(`sir-apply (${runner.name}): --version names the version, the Node inside and every grammar pin`, () => {
    const r = run(tmpdir(), '--version');
    assert.equal(r.status, 0, r.stderr);
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as { version: string };
    assert.match(r.stdout, new RegExp(`^sir-apply ${pkg.version.replace(/\./g, '\\.')} \\(patch format 2–2, node \\d+`));
    assert.match(r.stdout, /tree-sitter-cpp\.wasm tree-sitter-cpp@0\.23\.4 sha256:[0-9a-f]{64}/);
    assert.match(r.stdout, /tree-sitter-tsx\.wasm /);
  });

  test(`sir-apply (${runner.name}): two commands, a subset of sir apply's flags`, () => {
    assert.equal(run(tmpdir(), '--help').status, 0);
    const unknown = run(tmpdir(), 'generate');
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown command 'generate' — apply or verify/);
    for (const flag of ['--yes', '--dry-run', '--download-grammars']) {
      const r = run(tmpdir(), 'apply', '--match', 'p.sirp', flag);
      assert.equal(r.status, 1, flag);
      assert.match(r.stderr, new RegExp(`unknown argument: ${flag}`), flag);
    }
    assert.match(run(tmpdir(), 'verify', '--match', 'p.sirp', '--out', 'x').stderr, /unknown argument: --out/, 'verify writes nothing');
  });

  test(`sir-apply (${runner.name}): no clean base is exit 5 and says how to name one — never a question`, () => {
    const dir = temp('sir-bin-nobase-');
    try {
      writeFileSync(join(dir, 'a.cc'), OLD);
      writeFileSync(join(dir, 'a.cc.sirp'), PATCH('a.cc'));
      for (const command of ['verify', 'apply']) {
        const r = run(dir, command, '--match', 'a.cc.sirp');
        assert.equal(r.status, 5, `${command}: ${r.stderr}`);
        assert.match(r.stderr, /no base — name it \(--head \/ --branch \/ --commit \/ --repo-path or generate\.base\), or confirm the files on disk are the clean base: --base-from-disk/);
      }
      assert.equal(readFileSync(join(dir, 'a.cc'), 'utf8'), OLD, 'nothing written');
      const ok = run(dir, 'verify', '--match', 'a.cc.sirp', '--base-from-disk');
      assert.equal(ok.status, 0, ok.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`sir-apply (${runner.name}): apply without --out patches the file in place; with --out it is left alone`, () => {
    const dir = temp('sir-bin-inplace-');
    try {
      writeFileSync(join(dir, 'a.cc'), OLD);
      writeFileSync(join(dir, 'a.cc.sirp'), PATCH('a.cc'));
      const copy = run(dir, 'apply', '--match', 'a.cc.sirp', '--base-from-disk', '--out', 'out/');
      assert.equal(copy.status, 0, copy.stderr);
      assert.match(readFileSync(join(dir, 'out', 'a.cc'), 'utf8'), /int b = 2;/);
      assert.equal(readFileSync(join(dir, 'a.cc'), 'utf8'), OLD);
      const inPlace = run(dir, 'apply', '--match', 'a.cc.sirp', '--base-from-disk');
      assert.equal(inPlace.status, 0, inPlace.stderr);
      assert.match(readFileSync(join(dir, 'a.cc'), 'utf8'), /int b = 2;/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`sir-apply (${runner.name}): what sir would ask about is refused, and said`, () => {
    const dir = temp('sir-bin-ask-');
    try {
      repoAt(dir, { 'a.cc': OLD });
      git(dir, 'tag', 'v1');
      writeFileSync(join(dir, 'a.cc.sirp'), PATCH('a.cc'));
      const tag = run(dir, 'verify', '--match', 'a.cc.sirp', '--branch', 'v1');
      assert.equal(tag.status, 1, tag.stderr);
      assert.match(tag.stderr, /sir-apply asks nothing: stopping/);
      assert.match(tag.stderr, /--branch v1: not a branch/);
      const elsewhere = run(dir, 'apply', '--match', 'a.cc.sirp', '--head', '--out', 'patched.cc');
      assert.equal(elsewhere.status, 0, elsewhere.stderr);
      assert.match(readFileSync(join(dir, 'patched.cc'), 'utf8'), /int b = 2;/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`sir-apply (${runner.name}): in place over a git base — the clean base is patched, the result already there is not rewritten, anything else is written over and said`, () => {
    const dir = temp('sir-bin-rebuild-');
    try {
      repoAt(dir, { 'a.cc': OLD });
      writeFileSync(join(dir, 'a.cc.sirp'), PATCH('a.cc'));
      const first = run(dir, 'apply', '--match', 'a.cc.sirp', '--head');
      assert.equal(first.status, 0, first.stderr);
      assert.match(readFileSync(join(dir, 'a.cc'), 'utf8'), /int b = 2;/);

      const before = statSync(join(dir, 'a.cc'), { bigint: true });
      const again = run(dir, 'apply', '--match', 'a.cc.sirp', '--head');
      assert.equal(again.status, 0, again.stderr);
      assert.match(again.stdout, /already so: not written/);
      const after = statSync(join(dir, 'a.cc'), { bigint: true });
      assert.equal(after.ino, before.ino);
      assert.equal(after.mtimeNs, before.mtimeNs);

      writeFileSync(join(dir, 'a.cc.sirp'), PATCH('a.cc').replace('int b = 2;', 'int c = 3;'));
      const changed = run(dir, 'apply', '--match', 'a.cc.sirp', '--head');
      assert.equal(changed.status, 0, changed.stderr);
      assert.match(changed.stderr, /held changes HEAD:a\.cc does not — written over/);
      const text = readFileSync(join(dir, 'a.cc'), 'utf8');
      assert.match(text, /int c = 3;/);
      assert.doesNotMatch(text, /int b = 2;/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`sir-apply (${runner.name}): in place with --in relative to a subdirectory: the file named is the file written`, () => {
    const dir = temp('sir-bin-subdir-');
    try {
      repoAt(dir, { 'a/sub/a.cc': OLD });
      writeFileSync(join(dir, 'p.sirp'), PATCH());
      const r = run(join(dir, 'a'), 'apply', '--match', join(dir, 'p.sirp'), '--in', 'sub/a.cc', '--base-from-disk');
      assert.equal(r.status, 0, r.stderr);
      assert.match(readFileSync(join(dir, 'a', 'sub', 'a.cc'), 'utf8'), /int b = 2;/);
      assert.equal(existsSync(join(dir, 'sub')), false, 'nothing written at the repository root');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`sir-apply (${runner.name}): --base-from-disk works, and warns that the files on disk are taken as the base`, () => {
    const dir = temp('sir-bin-disk-');
    try {
      writeFileSync(join(dir, 'a.cc'), OLD);
      writeFileSync(join(dir, 'a.cc.sirp'), PATCH('a.cc'));
      const r = run(dir, 'verify', '--match', 'a.cc.sirp', '--base-from-disk');
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /warning: --base-from-disk: .*a\.cc is taken as the clean base/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`sir-apply (${runner.name}): Brave — verify --match <patch> alone: the file by Target, the base from generate.base`, () => {
    const root = temp('sir-bin-brave-');
    try {
      const src = join(root, 'src');
      repoAt(src, { 'chrome/browser/ui/browser.h': OLD });
      const brave = join(src, 'brave');
      repoAt(brave, { README: 'x\n' });
      writeFileSync(join(brave, 'sir.config.json'), JSON.stringify({ version: 3, upstream: '..', generate: { out: 'patches', base: { head: true } } }));
      const patch = join(brave, 'patches', 'chrome', 'browser', 'ui', 'browser.h.sirp');
      mkdirSync(dirname(patch), { recursive: true });
      writeFileSync(patch, PATCH('chrome/browser/ui/browser.h'));
      writeFileSync(join(src, 'chrome', 'browser', 'ui', 'browser.h'), NEW);

      const verify = run(brave, 'verify', '--match', 'patches/chrome/browser/ui/browser.h.sirp');
      assert.equal(verify.status, 0, verify.stderr);
      assert.match(verify.stdout, /verify: ok — 1 hunk\(s\) apply cleanly/);

      const out = run(brave, 'apply', '--match', 'patches/chrome/browser/ui/browser.h.sirp', '--out', '-');
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /int a = 1;\s*int b = 2;/, 'the HEAD version, patched');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
