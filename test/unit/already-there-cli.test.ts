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

const F = (body: string): string => `void f(int x) {\n  a(x);\n  b(x);\n${body}  c(x);\n}\n`;
const DRIFT = '\nvoid g() {\n  d();\n}\n';
const NEW = '  NEW(x);\n';

const patchAt = (blob: string | undefined): string =>
  `${blob !== undefined ? `Sir: 2\nBase-Blob: ${blob}\n\n` : ''}# match cpp\n    ...\n      b(x);\n    >>>\n    ...\n# end\n# patch\n\n      NEW(x);\n# end\n`;

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function repo(base: string, head: string): { dir: string; code: string; blob: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sir-already-')));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'a@b.c');
  git(dir, 'config', 'user.name', 'test');
  const code = join(dir, 'f.cc');
  writeFileSync(code, base);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  const blob = git(dir, 'rev-parse', 'HEAD:f.cc');
  writeFileSync(code, head);
  git(dir, 'commit', '-q', '-am', 'upstream');
  return { dir, code, blob };
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
  const lay = (r: { dir: string; code: string }, patch: string): ReturnType<typeof run> & { out: string } => {
    const md = join(r.dir, 'f.cc.sirp');
    writeFileSync(md, patch);
    const out = join(r.dir, 'out.cc');
    rmSync(out, { force: true });
    const res = run([...runner.apply, '--match', md, '--in', r.code, '--head', '--out', out], r.dir);
    let text = '';
    try {
      text = readFileSync(out, 'utf8');
    } catch {
    }
    return { ...res, out: text };
  };

  test(`${runner.name}: upstream took the change — exit 3, already there, nothing written`, () => {
    const r = repo(F(''), F(NEW) + DRIFT);
    try {
      const res = lay(r, patchAt(r.blob));
      assert.equal(res.status, 3, res.stderr);
      assert.match(res.stderr, /hunk 1 of 1: already there/);
      assert.equal(res.out, '');
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  test(`${runner.name}: a second copy the patch means (its base held one) — laid, no warning`, () => {
    const r = repo(F(NEW), F(NEW) + DRIFT);
    try {
      const res = lay(r, patchAt(r.blob));
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.out, F(NEW + NEW) + DRIFT);
      assert.doesNotMatch(res.stderr, /already stands/);
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  test(`${runner.name}: no Base-Blob, or one not in the repository — laid as before, with a warning`, () => {
    const r = repo(F(''), F(NEW) + DRIFT);
    try {
      for (const patch of [patchAt(undefined), patchAt('0'.repeat(40))]) {
        const res = lay(r, patch);
        assert.equal(res.status, 0, res.stderr);
        assert.equal(res.out, F(NEW + NEW) + DRIFT);
        assert.match(res.stderr, /warning: hunk 1 of 1: the text it inserts already stands at its place/);
      }
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  test(`${runner.name}: nothing like the text at the place — laid, no warning, Base-Blob or not`, () => {
    const r = repo(F(''), F('') + DRIFT);
    try {
      for (const patch of [patchAt(r.blob), patchAt(undefined)]) {
        const res = lay(r, patch);
        assert.equal(res.status, 0, res.stderr);
        assert.equal(res.out, F(NEW) + DRIFT);
        assert.doesNotMatch(res.stderr, /already/);
      }
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });
}

test('sir apply --verify: upstream took the change — exit 3', () => {
  const r = repo(F(''), F(NEW) + DRIFT);
  try {
    const md = join(r.dir, 'f.cc.sirp');
    writeFileSync(md, patchAt(r.blob));
    const res = run([process.execPath, '--experimental-strip-types', SIR, 'apply', '--match', md, '--in', r.code, '--head', '--verify'], r.dir);
    assert.equal(res.status, 3, res.stderr);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

function ok(response: ResponseMessage): Record<string, unknown> {
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.ok(response.ok);
  return response.result as Record<string, unknown>;
}

const call = (method: string, params: object): Promise<ResponseMessage> => handle({ id: 1, method, params });

test('service apply: upstream took the change — the hunk fails with reason already-there, the text holds one copy', async () => {
  const r = repo(F(''), F(NEW) + DRIFT);
  try {
    const res = ok(await call('apply', { path: r.code, patch: patchAt(r.blob), baseGit: {} }));
    const [hunk] = res['hunks'] as { status: string; failure?: { kind: string; reason?: string; mdLine?: number } }[];
    assert.equal(hunk!.status, 'no-match');
    assert.equal(hunk!.failure!.kind, 'MatchError');
    assert.equal(hunk!.failure!.reason, 'already-there');
    assert.equal(hunk!.failure!.mdLine, 4, 'the line of the hunk');
    assert.equal(res['text'], F(NEW) + DRIFT);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test('service resolve: no witness — the hunk lands, and warningsAt says why it may be twice', async () => {
  const r = repo(F(''), F(NEW) + DRIFT);
  try {
    const res = ok(await call('resolve', { path: r.code, patch: patchAt(undefined), baseGit: {} }));
    const [hunk] = res['hunks'] as { status: string }[];
    assert.equal(hunk!.status, 'ok');
    const warnings = res['warningsAt'] as { hunk: number; mdLine: number; message: string }[];
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.hunk, 1);
    assert.match(warnings[0]!.message, /already stands at its place, and the patch names no Base-Blob/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test('service apply: a second copy the patch means — laid, no warning', async () => {
  const r = repo(F(NEW), F(NEW) + DRIFT);
  try {
    const res = ok(await call('apply', { path: r.code, patch: patchAt(r.blob), baseGit: {} }));
    assert.equal(res['text'], F(NEW + NEW) + DRIFT);
    assert.deepEqual(res['warningsAt'], []);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});
