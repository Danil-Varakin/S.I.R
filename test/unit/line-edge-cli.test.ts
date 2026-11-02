import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { handle } from '../../src/service/handler.ts';
import type { ResponseMessage } from '../../src/service/protocol.ts';

const SIR = fileURLToPath(new URL('../../src/bin/sir.ts', import.meta.url));
const SIR_APPLY = fileURLToPath(new URL('../../src/bin/sir-apply.ts', import.meta.url));
const BINARY = process.env['SIR_APPLY_BIN'];

const BASE = 'void f(int x) {\n  if (x)\n    b(x);\n}\n';
const UPSTREAM = 'void f(int x) {\n  if (x) {\n    b(x);\n  }\n}\n';
const PATCH = '# match cpp\n    ...\n      if (x)\n    >>>\n    ...\n# end\n# patch\n\n      NEW(x);\n# end\n';

function git(dir: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
}

function repo(): { dir: string; code: string; patch: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sir-edge-')));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'a@b.c');
  git(dir, 'config', 'user.name', 'test');
  const code = join(dir, 'f.cc');
  writeFileSync(code, UPSTREAM);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'upstream');
  const patch = join(dir, 'f.cc.sirp');
  writeFileSync(patch, PATCH);
  return { dir, code, patch };
}

function run(argv: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const [cmd, ...rest] = argv;
  const r = spawnSync(cmd!, rest, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const RUNNERS: { name: string; apply: string[] }[] = [
  { name: 'sir apply', apply: [process.execPath, '--experimental-strip-types', SIR, 'apply'] },
  { name: 'sir-apply', apply: [process.execPath, '--experimental-strip-types', SIR_APPLY, 'apply'] },
  ...(BINARY !== undefined && BINARY !== '' ? [{ name: 'sir-apply binary', apply: [resolve(BINARY), 'apply'] }] : []),
];

for (const runner of RUNNERS) {
  const lay = (r: { dir: string; code: string; patch: string }, ...extra: string[]): ReturnType<typeof run> & { out: string } => {
    const out = join(r.dir, 'out.cc');
    rmSync(out, { force: true });
    const res = run([...runner.apply, '--match', r.patch, '--in', r.code, '--head', '--out', out, ...extra], r.dir);
    let text = '';
    try {
      text = readFileSync(out, 'utf8');
    } catch {
    }
    return { ...res, out: text };
  };

  test(`${runner.name}: a literal against the end of its line — laid, exit 0, a warning says so`, () => {
    const r = repo();
    try {
      const res = lay(r);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stderr, /warning: hunk 1 of 1: 'if \(x\)' stands in the middle of a line/);
      assert.match(res.out, /NEW\(x\);/);
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  test(`${runner.name}: --strict — exit 3, reason line-edge, nothing written`, () => {
    const r = repo();
    try {
      const res = lay(r, '--strict');
      assert.equal(res.status, 3, res.stderr);
      assert.match(res.stderr, /refused by --strict/);
      assert.equal(res.out, '');
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });
}

test('sir apply: a patch whose literal keeps its line — no warning, --strict lets it through', () => {
  const r = repo();
  try {
    writeFileSync(r.code, BASE);
    git(r.dir, 'commit', '-q', '-am', 'base again');
    const out = join(r.dir, 'out.cc');
    const res = run([process.execPath, '--experimental-strip-types', SIR, 'apply', '--match', r.patch, '--in', r.code, '--head', '--out', out, '--strict'], r.dir);
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stderr, /warning/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

const ok = (res: ResponseMessage): Record<string, unknown> => {
  assert.ok('result' in res, JSON.stringify(res));
  return res.result as Record<string, unknown>;
};

test('service apply: a literal against the end of its line — the hunk lands, warningsAt names it', async () => {
  const r = repo();
  try {
    const res = ok(await handle({ id: 1, method: 'apply', params: { path: r.code, patch: PATCH, baseGit: {} } }));
    const [hunk] = res['hunks'] as { status: string }[];
    assert.equal(hunk!.status, 'ok');
    const warnings = res['warningsAt'] as { hunk: number; mdLine: number; message: string }[];
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.hunk, 1);
    assert.match(warnings[0]!.message, /stands in the middle of a line/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});
