import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { handle } from '../../src/service/handler.ts';
import type { ResponseMessage, ServiceError } from '../../src/service/protocol.ts';
import { isContainedPath } from '../../src/core/header.ts';
import { pairOf, patchAt, targetFor } from '../../src/infra/pair.ts';
import type { Project } from '../../src/infra/project.ts';
import { resolveOutPath } from '../../src/infra/out-path.ts';
import { buildRepo, version } from '../git-repo.ts';

// Protocol 4: what the core answers so that a client does not compute it itself —
// `config`, `pair`, `resolve.baseText`, `warningsAt`, `NoChanges`, `baseGit.eol` and
// the header's Target.

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'bin', 'sir.ts');

function ok(response: ResponseMessage): Record<string, unknown> {
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.ok(response.ok);
  return response.result as Record<string, unknown>;
}

function failed(response: ResponseMessage): ServiceError {
  assert.equal(response.ok, false, JSON.stringify(response));
  assert.ok(!response.ok);
  return response.error;
}

const call = (method: string, params: object): Promise<ResponseMessage> => handle({ id: 1, method, params });

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tempRepo(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'a@b.c');
  git(dir, 'config', 'user.name', 'test');
  return dir;
}

function commitAll(dir: string): void {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'c');
}

// ── config ≡ generate ────────────────────────────────────────────────────────────

const CONFIGS: Record<string, string | undefined> = {
  none: undefined,
  v2: JSON.stringify({ version: 3, generate: { bridgeGap: 2, base: { head: true, eol: 'worktree' } } }),
  'v2 upstream': JSON.stringify({ version: 3, upstream: '.', generate: { out: 'patches', base: { branch: 'trunk' } } }),
};

for (const [name, text] of Object.entries(CONFIGS)) {
  test(`config ≡ generate: the settings, origins and file generate applies — ${name}`, async () => {
    const R = buildRepo('sir-p4-config-');
    try {
      git(R.dir, 'branch', 'trunk', R.b);
      if (text !== undefined) writeFileSync(join(R.dir, 'sir.config.json'), text);
      const requests: { generate: object; overrides: object }[] = [
        { generate: { baseText: version(2) }, overrides: { base: 'text' } },
        { generate: { baseGit: { commit: R.a } }, overrides: { baseGit: { commit: R.a } } },
        { generate: { baseText: version(2), exact: false, limits: { maxSiblings: 1 } }, overrides: { base: 'text', exact: false, limits: { maxSiblings: 1 } } },
      ];
      for (const r of requests) {
        const g = ok(await call('generate', { path: R.inPath, newText: version(9), ...r.generate }));
        const c = ok(await call('config', { path: R.inPath, overrides: r.overrides }));
        assert.deepEqual({ file: c['file'], settings: c['settings'], origins: c['origins'] }, g['config']);
        assert.equal(c['repoRoot'], R.dir);
      }
      // no base sent: generate takes the config's, and config says which
      const c = ok(await call('config', { path: R.inPath }));
      if (text?.includes('"base"')) {
        const g = ok(await call('generate', { path: R.inPath, newText: version(9) }));
        assert.deepEqual({ file: c['file'], settings: c['settings'], origins: c['origins'] }, g['config']);
        assert.equal((c['base'] as { spec: string }).spec, g['baseSpec']);
      } else {
        assert.equal(c['base'], null);
        assert.equal(failed(await call('generate', { path: R.inPath, newText: version(9) })).kind, 'BadRequest');
      }
      assert.equal(c['schemaVersion'], text === undefined ? null : JSON.parse(text).version);
    } finally {
      rmSync(R.dir, { recursive: true, force: true });
    }
  });
}

test('config: the base out of git is resolved — spec as baseSpec, the full sha; watch names what could change it', async () => {
  const R = buildRepo('sir-p4-base-');
  try {
    const c = ok(await call('config', { path: R.inPath, overrides: { baseGit: {} } }));
    assert.deepEqual(c['base'], { kind: 'git', spec: 'HEAD:src/core/f.cc', sha: R.b, eol: 'repository' });
    const watch = c['watch'] as string[];
    const root = R.dir;
    assert.ok(watch.includes(join(root, 'src', 'core', 'sir.config.json')), 'the nearest place a config could be made');
    assert.ok(watch.includes(join(root, 'sir.config.json')), 'the repository root');
    assert.ok(watch.includes(join(root, '.git', 'HEAD')));
    assert.ok(watch.includes(join(root, '.git', 'packed-refs')));
    assert.ok(watch.includes(join(root, '.git', 'refs', 'heads', R.branch)), 'the branch HEAD is on');

    const side = ok(await call('config', { path: R.inPath, overrides: { baseGit: { branch: 'side' } } }));
    assert.equal((side['base'] as { sha: string }).sha, R.s);
    assert.ok((side['watch'] as string[]).includes(join(root, '.git', 'refs', 'heads', 'side')));

    assert.deepEqual(ok(await call('config', { path: R.inPath, overrides: { base: 'text' } }))['base'], { kind: 'text' });
    const nope = ok(await call('config', { path: R.inPath, overrides: { baseGit: { branch: 'nope' } } }));
    const unavailable = nope['base'] as { kind: string; error: ServiceError };
    assert.equal(unavailable.kind, 'unavailable');
    assert.equal(unavailable.error.kind, 'GitError');
    assert.match(unavailable.error.message, /no such branch/);
    assert.equal(failed(await call('config', { path: R.inPath, overrides: { base: 'text', baseGit: {} } })).kind, 'BadRequest');
    assert.equal(failed(await call('config', { path: 'relative.cc' })).kind, 'BadRequest');
  } finally {
    rmSync(R.dir, { recursive: true, force: true });
  }
});

test('config: a file git does not know yet — settings answered, the base unavailable, the next commit watched', async () => {
  const dir = tempRepo('sir-p4-untracked-');
  try {
    const file = join(dir, 'new.cc');
    writeFileSync(file, 'int f() { return 1; }\n');
    // no commit at all: the branch HEAD is on does not exist yet, and is watched all the same
    const unborn = ok(await call('config', { path: file, overrides: { baseGit: {} } }));
    assert.equal((unborn['base'] as { kind: string }).kind, 'unavailable');
    const branch = git(dir, 'symbolic-ref', '--short', 'HEAD');
    assert.ok((unborn['watch'] as string[]).includes(join(dir, '.git', 'refs', 'heads', branch)), JSON.stringify(unborn['watch']));

    writeFileSync(join(dir, 'other.cc'), 'int g();\n');
    git(dir, 'add', 'other.cc');
    git(dir, 'commit', '-q', '-m', 'c');
    const c = ok(await call('config', { path: file, overrides: { baseGit: {} } }));
    const base = c['base'] as { kind: string; error: ServiceError };
    assert.equal(base.kind, 'unavailable');
    assert.equal(base.error.kind, 'GitError');
    assert.match(base.error.message, /no such file in HEAD/);
    assert.equal((c['settings'] as { baseHead: boolean }).baseHead, true, 'the settings are there');
    assert.ok((c['watch'] as string[]).includes(join(dir, '.git', 'HEAD')));
    assert.ok((c['watch'] as string[]).includes(join(dir, '.git', 'refs', 'heads', branch)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config: a linked worktree watches its own HEAD and the common refs', async () => {
  const R = buildRepo('sir-p4-wt-');
  const wt = `${R.dir}-wt`;
  try {
    git(R.dir, 'worktree', 'add', '-q', '-b', 'wtb', wt, R.b);
    const inPath = join(realpathSync(wt), 'src', 'core', 'f.cc');
    const c = ok(await call('config', { path: inPath, overrides: { baseGit: {} } }));
    const watch = c['watch'] as string[];
    const ownHead = realpathSync(git(wt, 'rev-parse', '--path-format=absolute', '--git-path', 'HEAD'));
    assert.ok(watch.includes(ownHead), `the worktree's own HEAD ${ownHead}: ${JSON.stringify(watch)}`);
    const branchRef = realpathSync(git(wt, 'rev-parse', '--path-format=absolute', '--git-path', 'refs/heads/wtb'));
    assert.ok(watch.includes(branchRef), `the branch's ref ${branchRef}: ${JSON.stringify(watch)}`);
    assert.equal(c['repoRoot'], realpathSync(wt));
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(R.dir, { recursive: true, force: true });
  }
});

test('config: a ConfigError as the loader gives it (C5)', async () => {
  const R = buildRepo('sir-p4-cfgerr-');
  try {
    writeFileSync(join(R.dir, 'sir.config.json'), JSON.stringify({ version: 99 }));
    const error = failed(await call('config', { path: R.inPath }));
    assert.equal(error.kind, 'ConfigError');
    assert.match(error.message, /update sir/);
  } finally {
    rmSync(R.dir, { recursive: true, force: true });
  }
});

// ── pair ─────────────────────────────────────────────────────────────────────────

test('pair: code → patch → code, beside, out and upstream — the same outPath generate names', async () => {
  const R = buildRepo('sir-p4-pair-');
  try {
    const one: Project = { configFile: join(R.dir, 'sir.config.json'), projectRoot: R.dir, upstreamRoot: R.dir };
    const layouts = [
      { settings: { out: null }, how: 'beside' },
      { settings: { out: 'patches', project: one }, how: 'upstream' },
    ] as const;
    for (const { settings, how } of layouts) {
      const code = pairOf(R.inPath, settings);
      assert.equal(code.kind, 'code');
      assert.ok(code.kind === 'code');
      assert.equal(code.how, how);
      assert.equal(code.patchPath, resolveOutPath({ inPath: R.inPath, ...settings }).path);
      const back = pairOf(code.patchPath!, settings, '');
      assert.deepEqual(back, { kind: 'patch', code: R.inPath, exists: true, how });
    }
    const flat = pairOf(join(R.dir, 'out', 'f.cc.sirp'), { out: 'out/' }, '');
    assert.deepEqual(flat, { kind: 'patch', code: null, exists: false, how: null, reason: 'flat-out' });
    assert.equal(pairOf(R.inPath, { out: 'out/' }).kind, 'code');
    assert.equal((pairOf(R.inPath, { out: '-' }) as { reason: string }).reason, 'no-out');
    const astray = pairOf(join(R.dir, 'elsewhere', 'f.cc.sirp'), { out: 'patches', project: one }, '');
    assert.equal((astray as { reason: string }).reason, 'outside-out');

    // over the wire, with the project's config
    writeFileSync(join(R.dir, 'sir.config.json'), JSON.stringify({ version: 3, upstream: '.', generate: { out: 'patches' } }));
    const wire = ok(await call('pair', { path: R.inPath }));
    assert.equal(wire['patchPath'], join(R.dir, 'patches', 'src', 'core', 'f.cc.sirp'));
    const g = ok(await call('generate', { path: R.inPath, newText: version(9), baseText: version(2) }));
    assert.equal(wire['patchPath'], g['outPath']);
    assert.match(String(g['patch']), /^Sir: 2\nTarget: src\/core\/f\.cc\n/);
  } finally {
    rmSync(R.dir, { recursive: true, force: true });
  }
});

test('pair: one file, one patch — a patch beside the file and one in the tree are both named', () => {
  const R = buildRepo('sir-p4-two-');
  try {
    const one: Project = { configFile: join(R.dir, 'sir.config.json'), projectRoot: R.dir, upstreamRoot: R.dir };
    const tree = join(R.dir, 'patches', 'src', 'core', 'f.cc.sirp');
    mkdirSync(dirname(tree), { recursive: true });
    writeFileSync(tree, '');
    writeFileSync(`${R.inPath}.sirp`, '');
    assert.deepEqual(pairOf(R.inPath, { out: 'patches', project: one }), {
      kind: 'code', patchPath: null, exists: false, how: null, reason: 'two-patches', patchPaths: [tree, `${R.inPath}.sirp`],
    });
    const outside: Project = { ...one, upstreamRoot: join(R.dir, 'src', 'other') };
    mkdirSync(outside.upstreamRoot!, { recursive: true });
    assert.equal((pairOf(R.inPath, { out: 'patches', project: outside }) as { reason: string }).reason, 'outside-upstream');
  } finally {
    rmSync(R.dir, { recursive: true, force: true });
  }
});

test('pair: Target comes first, measured from the repository root; a path out of it is refused', async () => {
  const R = buildRepo('sir-p4-target-');
  try {
    const patch = join(R.dir, 'anywhere', 'x.sirp');
    const headed = (target: string): string => `Sir: 2\nTarget: ${target}\n\n# match cpp\n    a\n# end\n# patch\n    b\n# end\n`;
    assert.deepEqual(pairOf(patch, { out: null }, headed('src/core/f.cc')), {
      kind: 'patch', code: R.inPath, exists: true, how: 'target',
    });
    for (const bad of ['../outside.cc', 'src/../../x', '/etc/passwd', '\\\\server\\share', 'C:\\x.cc', 'c:/x']) {
      assert.deepEqual(pairOf(patch, { out: null }, headed(bad)), {
        kind: 'patch', code: null, exists: false, how: null, reason: 'unsafe-target',
      }, bad);
    }
    // read from disk when the client sends no text
    mkdirSync(dirname(patch), { recursive: true });
    writeFileSync(patch, headed('src/core/other.cc'));
    const wire = ok(await call('pair', { path: patch }));
    assert.equal(wire['code'], join(R.dir, 'src', 'core', 'other.cc'));
    // a .md is code, not a patch
    assert.equal(pairOf(join(R.dir, 'README.md'), { out: null }).kind, 'code');
  } finally {
    rmSync(R.dir, { recursive: true, force: true });
  }
});

test('pair: a header that names no file says why — a newer or older format, a header that does not read, an unsafe Target', () => {
  const patch = join(tmpdir(), 'sir-p4-reasons', 'x.sirp');
  const body = '\n# match cpp\n    a\n# end\n# patch\n    b\n# end\n';
  const reason = (text: string): unknown => (pairOf(patch, { out: null }, text) as { reason?: string }).reason;
  assert.equal(reason(`Sir: 3\nTarget: a.cc\n${body}`), 'newer-format', 'update sir, not "unsafe"');
  assert.equal(reason(`Sir: 0\nTarget: a.cc\n${body}`), 'older-format');
  assert.equal(reason(`Sir: x\n${body}`), 'bad-header');
  assert.equal(reason(`Sir: 2\nTarget: a.cc\nTarget: b.cc\n${body}`), 'bad-header');
  assert.equal(reason(`Sir: 2\nTarget: ../a.cc\n${body}`), 'unsafe-target');
  assert.equal(patchAt(patch).target, null, 'nothing there yet');
});

test('Target: contained paths only', () => {
  assert.equal(isContainedPath('a/b.cc'), true);
  assert.equal(isContainedPath('a/../b'), false);
  assert.equal(isContainedPath(''), false);
});

// ── generate: the header, warningsAt, NoChanges ─────────────────────────────────

test('generate writes the header: Target from the repository root, Base-Blob for a git base', async () => {
  const R = buildRepo('sir-p4-gen-');
  try {
    const g = ok(await call('generate', { path: R.inPath, newText: version(9), baseText: version(2) }));
    const md = String(g['patch']);
    assert.match(md, /^Sir: 2\nTarget: src\/core\/f\.cc\nSir-Version: \d\S*\nGrammar: tree-sitter-cpp@\S+\n\n# match cpp\n/, md);
    assert.deepEqual((g['hunks'] as { mdSpan: number[] }[])[0]!.mdSpan[0], 6, 'mdSpan counts the header lines');
    assert.equal(targetFor(String(g['outPath']), R.inPath), 'src/core/f.cc');

    const fromGit = ok(await call('generate', { path: R.inPath, newText: version(9), baseGit: {} }));
    const blob = git(R.dir, 'rev-parse', 'HEAD:src/core/f.cc');
    assert.match(String(fromGit['patch']), new RegExp(`^Sir: 2\nTarget: src/core/f\\.cc\nBase-Blob: ${blob}\n`));

    const noPath = ok(await call('generate', { language: 'cpp', newText: version(9), baseText: version(2) }));
    assert.match(String(noPath['patch']), /^Sir: 2\nSir-Version: /, 'no path, no file to name');
  } finally {
    rmSync(R.dir, { recursive: true, force: true });
  }
});

test('generate: warningsAt places each hunk warning on its .md line, with the text of warnings', async () => {
  const R = buildRepo('sir-p4-warn-');
  try {
    const g = ok(
      await call('generate', { path: R.inPath, baseText: version(2), newText: 'void f() {\n  int a = 3;   \n}\n' }),
    );
    const warnings = g['warnings'] as string[];
    const at = g['warningsAt'] as { hunk: number; mdLine: number; message: string }[];
    assert.equal(at.length, 1);
    assert.equal(at[0]!.message, warnings[0]);
    assert.equal(at[0]!.hunk, 1);
    const line = String(g['patch']).split('\n')[at[0]!.mdLine - 1]!;
    assert.match(line, /[ \t]$/, `line ${at[0]!.mdLine} is the one with the trailing space`);
  } finally {
    rmSync(R.dir, { recursive: true, force: true });
  }
});

test('NoChanges: the same after normalization, from text and from git; exact compares bytes', async () => {
  const R = buildRepo('sir-p4-same-');
  try {
    const spaced = 'void f() {\n\n    int  a = 2;\n\n}\n';
    const fromText = failed(await call('generate', { path: R.inPath, baseText: version(2), newText: spaced }));
    assert.equal(fromText.kind, 'NoChanges');
    assert.equal(fromText.exitCode, 7);
    assert.deepEqual(fromText.detail, { baseSpec: null });

    const fromGit = failed(await call('generate', { path: R.inPath, baseGit: {}, newText: version(2) }));
    assert.equal(fromGit.kind, 'NoChanges');
    assert.deepEqual(fromGit.detail, { baseSpec: 'HEAD:src/core/f.cc' });

    ok(await call('generate', { path: R.inPath, baseText: version(2), newText: spaced, exact: true }));
    assert.equal(failed(await call('generate', { path: R.inPath, baseText: version(2), newText: version(2), exact: true })).kind, 'NoChanges');
  } finally {
    rmSync(R.dir, { recursive: true, force: true });
  }
});

test('CLI: no changes — exit 7, a message, and no patch written', () => {
  const R = buildRepo('sir-p4-cli-');
  try {
    writeFileSync(R.inPath, version(2));
    const run = spawnSync(process.execPath, ['--experimental-strip-types', CLI, 'generate', '--in', R.inPath, '--head', '--no-config'], {
      encoding: 'utf8',
    });
    assert.equal(run.status, 7, run.stderr);
    assert.match(run.stderr, /NoChanges: the new version is the base/);
    assert.equal(existsSync(`${R.inPath}.sirp`), false);
  } finally {
    rmSync(R.dir, { recursive: true, force: true });
  }
});

test('CLI: generate writes the header; --no-marker is gone', () => {
  const R = buildRepo('sir-p4-clihead-');
  try {
    const args = ['--experimental-strip-types', CLI, 'generate', '--in', R.inPath, '--head', '--no-config'];
    const gen = (...extra: string[]): string =>
      execFileSync(process.execPath, [...args, ...extra], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    gen();
    assert.match(readFileSync(`${R.inPath}.sirp`, 'utf8'), /^Sir: 2\nTarget: src\/core\/f\.cc\nBase-Blob: [0-9a-f]{40}\n/);
    assert.match(gen('--out', '-'), /^Sir: 2\nBase-Blob: /, 'stdout: no patch location, no Target');
    assert.equal(spawnSync(process.execPath, [...args, '--no-marker'], { encoding: 'utf8' }).status, 1);
  } finally {
    rmSync(R.dir, { recursive: true, force: true });
  }
});

// ── resolve / apply: baseText, the config's base ────────────────────────────────

test('resolve: baseText when the base came out of git, none when it was sent', async () => {
  const R = buildRepo('sir-p4-resolve-');
  try {
    const g = ok(await call('generate', { path: R.inPath, baseGit: {}, newText: version(9) }));
    const fromGit = ok(await call('resolve', { path: R.inPath, patch: g['patch'], baseGit: {} }));
    assert.equal(fromGit['baseText'], version(2));
    assert.equal(fromGit['baseSpec'], 'HEAD:src/core/f.cc');
    const fromText = ok(await call('resolve', { path: R.inPath, patch: g['patch'], baseText: version(2) }));
    assert.equal('baseText' in fromText, false);
  } finally {
    rmSync(R.dir, { recursive: true, force: true });
  }
});

test('resolve/apply: a hunk with a `# note` carries `note` and `noteSpan`; one without carries neither', async () => {
  const md = [
    '# match c', '    int a;', '    >>>', '# end', '# patch', '    int b;', '# end', '',
    '# note', 'Why c: see the review.', '# end',
    '# match c', '    int b;', '    >>>', '# end', '# patch', '    int c;', '# end', '',
  ].join('\n');
  for (const method of ['resolve', 'apply']) {
    const hunks = ok(await call(method, { patch: md, baseText: 'int a;\n', language: 'c' }))['hunks'] as Record<string, unknown>[];
    assert.equal(hunks.length, 2);
    assert.equal('note' in hunks[0]!, false);
    assert.equal('noteSpan' in hunks[0]!, false);
    assert.equal(hunks[1]!['note'], 'Why c: see the review.');
    assert.deepStrictEqual(hunks[1]!['noteSpan'], [9, 11]);
    assert.deepStrictEqual(hunks[1]!['mdSpan'], [12, 18]);
  }
});

test('resolve/apply with no base take the config\'s generate.base, as generate does; none is refused as before', async () => {
  const R = buildRepo('sir-p4-cfgbase-');
  try {
    const md = String(ok(await call('generate', { path: R.inPath, baseGit: { commit: R.a }, newText: version(9) }))['patch']);
    assert.equal(failed(await call('apply', { path: R.inPath, patch: md })).kind, 'BadRequest');
    writeFileSync(join(R.dir, 'sir.config.json'), JSON.stringify({ version: 3, generate: { base: { commit: R.a } } }));
    const applied = ok(await call('apply', { path: R.inPath, patch: md }));
    assert.equal(applied['text'], version(9));
    assert.equal(applied['baseSpec'], `${R.a}:src/core/f.cc`);
    const resolved = ok(await call('resolve', { path: R.inPath, patch: md }));
    assert.equal(resolved['baseText'], version(1));
  } finally {
    rmSync(R.dir, { recursive: true, force: true });
  }
});

// ── baseGit.eol ──────────────────────────────────────────────────────────────────

test('baseGit.eol: with core.autocrlf the base comes as the file on disk has it — "worktree" — or as stored', async () => {
  const dir = tempRepo('sir-p4-crlf-');
  try {
    git(dir, 'config', 'core.autocrlf', 'true');
    const file = join(dir, 'a.cc');
    const crlf = 'int a() {\r\n  return 1;\r\n}\r\n';
    writeFileSync(file, crlf);
    commitAll(dir);
    assert.equal(git(dir, 'cat-file', 'blob', 'HEAD:a.cc').includes('\r'), false, 'the repository stores LF');

    const md = '# match cpp\n    ...\n    >>>\n    return 1;\n    <<<\n    ...\n# end\n# patch\n    return 2;\n# end\n';
    const stored = ok(await call('resolve', { path: file, patch: md, baseGit: {} }));
    assert.equal(stored['baseText'], crlf.replace(/\r\n/g, '\n'));
    const worktree = ok(await call('resolve', { path: file, patch: md, baseGit: { eol: 'worktree' } }));
    assert.equal(worktree['baseText'], crlf);
    const applied = ok(await call('apply', { path: file, patch: md, baseGit: { eol: 'worktree' } }));
    assert.equal(applied['text'], crlf.replace('return 1;', 'return 2;'));

    // exact: every line differs as stored, nothing does as on disk
    ok(await call('generate', { path: file, newText: crlf, baseGit: {}, exact: true }));
    assert.equal(failed(await call('generate', { path: file, newText: crlf, baseGit: { eol: 'worktree' }, exact: true })).kind, 'NoChanges');

    // the config names it once for the project
    writeFileSync(join(dir, 'sir.config.json'), JSON.stringify({ version: 3, generate: { base: { head: true, eol: 'worktree' } } }));
    const c = ok(await call('config', { path: file }));
    assert.equal((c['base'] as { eol: string }).eol, 'worktree');
    assert.equal(ok(await call('resolve', { path: file, patch: md }))['baseText'], crlf);

    assert.equal(failed(await call('resolve', { path: file, patch: md, baseGit: { eol: 'crlf' } })).kind, 'BadRequest');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --eol worktree: generate --head --exact on an unchanged autocrlf file is no change', () => {
  const dir = tempRepo('sir-p4-crlf-cli-');
  try {
    git(dir, 'config', 'core.autocrlf', 'true');
    const file = join(dir, 'a.cc');
    writeFileSync(file, 'int a() {\r\n  return 1;\r\n}\r\n');
    commitAll(dir);
    const run = (...extra: string[]) =>
      spawnSync(process.execPath, ['--experimental-strip-types', CLI, 'generate', '--in', file, '--head', '--exact', '--no-config', '--out', '-', ...extra], {
        encoding: 'utf8',
      });
    assert.equal(run().status, 0, 'as stored: every line changed');
    assert.equal(run('--eol', 'worktree').status, 7);
    assert.equal(run('--eol', 'crlf').status, 1, 'a usage error, naming the values');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── generate: a change it cannot anchor ─────────────────────────────────────────

test('generate: a change no pattern anchors fails with SynthesisError (exit 8), the line of the new version in detail', async () => {
  const old = 'void f() {\n  if (cond) {\n    a();\n    work();\n  }\n  if (cond) {\n    a();\n    work();\n  }\n}\n';
  const neu = old.replace(/work\(\);(?![\s\S]*work\(\);)/, 'work(2);');
  const error = failed(await call('generate', { baseText: old, newText: neu, language: 'cpp' }));
  assert.equal(error.kind, 'SynthesisError');
  assert.equal(error.exitCode, 8);
  // the fields of protocol 4; protocol 5 adds `draft` and the rest beside them (R4)
  assert.deepEqual({ reason: error.detail?.['reason'], newLine: error.detail?.['newLine'] }, { reason: 'ambiguous', newLine: 8 });
  assert.match(error.message, /could not anchor the change at line 8 of the new version/);
});

test('generate: a place the .md cannot go is refused before synthesis — before NoChanges too', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sir-p4-blocked-')));
  try {
    writeFileSync(join(dir, 'blocker'), 'a file where a directory should be');
    const path = join(dir, 'a.cc');
    const error = failed(await call('generate', { path, baseText: 'int a;\n', newText: 'int a;\n', out: join(dir, 'blocker', 'x.sirp') }));
    assert.equal(error.kind, 'PathError');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('generate: --out naming a file that is not .sirp is refused before anything is read', async () => {
  const R = buildRepo('sir-p4-outext-');
  try {
    // --in-old does not exist: the refusal comes first all the same
    const run = spawnSync(process.execPath, ['--experimental-strip-types', CLI, 'generate', '--in', R.inPath, '--in-old', 'nope.cc', '--no-config', '--out', 'p.md'], { encoding: 'utf8' });
    assert.equal(run.status, 5, run.stderr);
    assert.match(run.stderr, /a patch is a \.sirp file — name it p\.sirp/);
    assert.equal(existsSync(join(R.dir, 'p.md')), false);
    // a directory is fine, with or without an extension-less name
    assert.equal(resolveOutPath({ inPath: R.inPath, out: 'patches' }).path, join(R.dir, 'patches', 'f.cc.sirp'));

    const wire = failed(await call('generate', { path: R.inPath, newText: version(9), baseGit: { branch: 'nope' }, out: join(R.dir, 'x.txt') }));
    assert.equal(wire.kind, 'ConfigError', 'refused before the base is looked for');
  } finally {
    rmSync(R.dir, { recursive: true, force: true });
  }
});
