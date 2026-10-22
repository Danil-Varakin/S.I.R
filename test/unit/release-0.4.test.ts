import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { HEADER_FIELDS, parseHeader, printHeader } from '../../src/core/header.ts';
import { parseHatchFile } from '../../src/core/hatch-parser.ts';
import { ConfigError } from '../../src/core/errors.ts';
import { handle } from '../../src/service/handler.ts';
import type { ResponseMessage } from '../../src/service/protocol.ts';
import { CONFIG_ENV, configFileFor, loadProject, projectOf } from '../../src/infra/project.ts';
import { loadConfig, readConfigFile } from '../../src/infra/config/index.ts';
import { patchAt, patchTarget } from '../../src/infra/pair.ts';

// What 0.4 changed, stage by stage (docs/plan-0.4.md), where the tests of each module
// leave a gap: the edges, the refusals and the paths between the stages.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'src', 'bin', 'hatch.ts');
const OLD = 'void f() {\n  int a = 1;\n}\n';
const NEW = 'void f() {\n  int a = 2;\n}\n';

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

function config(dir: string, value: object): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'hatch.config.json');
  writeFileSync(file, JSON.stringify({ version: 2, ...value }));
  return file;
}

function hatch(cwd: string, args: string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function temp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

const call = (method: string, params: object): Promise<ResponseMessage> => handle({ id: 1, method, params });

function ok(response: ResponseMessage): Record<string, unknown> {
  assert.equal(response.ok, true, JSON.stringify(response));
  return (response as { result: Record<string, unknown> }).result;
}

function failed(response: ResponseMessage): { kind: string; message: string; detail?: Record<string, unknown> } {
  assert.equal(response.ok, false, JSON.stringify(response));
  return (response as { error: { kind: string; message: string } }).error;
}

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> {
  const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ── stage 1: the .hatch format and its header ─────────────────────────────────────

test('stage 1: printHeader writes the fields in HEADER_FIELDS order, leaves out the missing ones, and parses back', () => {
  const all = printHeader({
    grammar: 'tree-sitter-c@1',
    hatchVersion: '0.5.0',
    target: 'a/b.c',
    baseBlob: 'f'.repeat(40),
  });
  assert.deepEqual(
    all.trimEnd().split('\n').map((l) => l.split(':')[0]),
    [...HEADER_FIELDS],
    'the order is the list, whatever order the fields were given in',
  );
  assert.ok(all.endsWith('\n\n'), 'a blank line closes the header');
  assert.equal(printHeader({}), 'Hatch: 1\n\n', 'Hatch alone, always');
  assert.equal(printHeader({ grammar: 'g@1' }), 'Hatch: 1\nGrammar: g@1\n\n');

  const parsed = parseHeader(`${all}# match c\n`);
  assert.equal(parsed.format, 1);
  assert.equal(parsed.fields.get('target'), 'a/b.c');
  assert.equal(parsed.endLine, HEADER_FIELDS.length, 'the header ends at its blank line');
});

test('stage 1: blank lines before the header are skipped; CRLF reads alike; a value keeps its inner spaces', () => {
  const file = parseHatchFile('\n\nHatch: 1\r\nHatch-Version: 0.5.0 (dev build)  \r\n\r\n# match c\r\n    a\r\n    >>>\r\n# end\r\n# patch\r\n    b\r\n# end\r\n');
  assert.deepEqual(file.header, { format: 1, hatchVersion: '0.5.0 (dev build)', generatedBy: 'hatch 0.5.0 (dev build)' });
});

test('stage 1: a patch with no Target still applies — apply is told the file by --in', () => {
  const dir = temp('hatch-s1-notarget-');
  try {
    writeFileSync(join(dir, 'a.cc'), OLD);
    writeFileSync(join(dir, 'p.hatch'), 'Hatch: 1\n\n# match cpp\n    ...\n    int a = 1;\n    >>>\n    ...\n# end\n# patch\n      int b = 2;\n# end\n');
    const r = hatch(dir, ['apply', '--match', 'p.hatch', '--in', 'a.cc', '--out', '-', '--no-config']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /int b = 2;/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stage 1: --out P.HATCH — the extension in any case; a .md --match is refused before the file is read', () => {
  const dir = temp('hatch-s1-case-');
  try {
    repoAt(dir, { 'a.cc': OLD });
    writeFileSync(join(dir, 'a.cc'), NEW);
    const r = hatch(dir, ['generate', '--in', 'a.cc', '--head', '--no-config', '--out', 'P.HATCH']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(join(dir, 'P.HATCH'), 'utf8'), /^Hatch: 1\nTarget: a\.cc\n/);
    // the .md does not exist: the refusal is about the name, not a missing file
    const md = hatch(dir, ['apply', '--match', 'missing.md', '--in', 'a.cc', '--dry-run']);
    assert.equal(md.status, 1);
    assert.match(md.stderr, /a patch is a \.hatch file/);
    assert.doesNotMatch(md.stderr, /no such file/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── stage 2: the project and its upstream ─────────────────────────────────────────

test('stage 2: HATCH_CONFIG is taken when nothing claims the file — and never before a config that does', async () => {
  const root = temp('hatch-s2-env-');
  try {
    const proj = join(root, 'proj');
    const file = config(proj, { upstream: '../code', generate: { out: 'patches' } });
    const code = join(root, 'code', 'a.cc');
    repoAt(join(root, 'code'), { 'a.cc': OLD });
    await withEnv({ [CONFIG_ENV]: file }, () => {
      assert.equal(configFileFor(code), file);
    });
    await withEnv({ [CONFIG_ENV]: join(root, 'nope.json') }, () => {
      assert.throws(() => configFileFor(code), (e: unknown) => e instanceof ConfigError && /HATCH_CONFIG/.test(e.message));
    });
    // a config up from the file wins over the variable
    const own = config(join(root, 'code'), { generate: { exact: true } });
    await withEnv({ [CONFIG_ENV]: file }, () => {
      assert.equal(configFileFor(code), own);
    });
    // and the CLI reads it the same way
    rmSync(own);
    writeFileSync(code, NEW);
    const r = hatch(root, ['generate', '--in', code, '--head'], { [CONFIG_ENV]: file });
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(join(proj, 'patches', 'a.cc.hatch'), 'utf8'), /^Hatch: 1\nTarget: a\.cc\n/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stage 2: an upstream that names no directory is refused, with the config file named', () => {
  const root = temp('hatch-s2-noup-');
  try {
    const file = config(root, { upstream: 'missing', generate: { out: 'patches' } });
    assert.throws(
      () => projectOf(loadConfig({ explicitPath: file, startDir: root, useFile: true })),
      (e: unknown) => e instanceof ConfigError && /upstream "missing" names no directory/.test(e.message) && e.file === file,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stage 2: generate.mirror in a v2 config names its replacement; "upstream" must be a non-empty string', () => {
  const root = temp('hatch-s2-mirror-');
  try {
    const file = config(root, { generate: { out: 'patches', mirror: true } });
    assert.throws(() => readConfigFile(file), /"generate\.mirror" is gone: "upstream": "\." keeps the patches in the same tree/);
    const blank = config(root, { upstream: '', generate: { out: 'patches' } });
    assert.throws(() => readConfigFile(blank), /"upstream" must be a non-empty string or null/);
    const none = config(root, { upstream: null });
    assert.deepEqual(readConfigFile(none), { upstream: null }, 'null: no upstream, as a config without the key');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stage 2: a config whose upstream does not hold the file is no claim; one that does not parse is no claim either', () => {
  const root = temp('hatch-s2-claims-');
  try {
    const src = join(root, 'src');
    repoAt(src, { 'a/x.cc': OLD });
    config(join(src, 'tools'), { upstream: '../a/b', generate: { out: 'p' } }); // a/b does not hold a/x.cc
    mkdirSync(join(src, 'broken'));
    writeFileSync(join(src, 'broken', 'hatch.config.json'), '{ not json');
    assert.equal(configFileFor(join(src, 'a', 'x.cc')), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stage 2: patchTarget — from the upstream wherever the patch goes, stdout included; without one, from the repository of the patch', () => {
  const root = temp('hatch-s2-target-');
  try {
    repoAt(root, { 'src/a.cc': OLD });
    const code = join(root, 'src', 'a.cc');
    const project = { configFile: join(root, 'hatch.config.json'), projectRoot: root, upstreamRoot: root };
    assert.equal(patchTarget(project, undefined, code), 'src/a.cc', 'no place (stdout), still a Target');
    assert.equal(patchTarget(undefined, join(root, 'p', 'x.hatch'), code), 'src/a.cc');
    assert.equal(patchTarget(undefined, undefined, code), undefined);
    const outside = temp('hatch-s2-outside-');
    try {
      // the root of a patch outside any repository is its own directory, and the code is
      // not under it — a Target measured from there would be a path out of the root
      assert.equal(patchTarget(undefined, join(outside, 'elsewhere.hatch'), code), undefined, 'a patch outside the repository');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stage 2: patchAt — what lies where a patch is about to go', () => {
  const dir = temp('hatch-s2-at-');
  try {
    assert.deepEqual(patchAt(join(dir, 'none.hatch')), { exists: false, target: null });
    writeFileSync(join(dir, 'a.hatch'), 'Hatch: 1\nTarget: x/a.cc\n\n# match c\n    a\n    >>>\n# end\n# patch\n    b\n# end\n');
    assert.deepEqual(patchAt(join(dir, 'a.hatch')), { exists: true, target: 'x/a.cc' });
    writeFileSync(join(dir, 'b.hatch'), 'hand-written, no header\n');
    assert.deepEqual(patchAt(join(dir, 'b.hatch')), { exists: true, target: null });
    writeFileSync(join(dir, 'c.hatch'), 'Hatch: 99\n\n');
    assert.deepEqual(patchAt(join(dir, 'c.hatch')), { exists: true, target: null }, 'a header that does not parse names nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stage 2: service generate tells another file\'s patch at outPath by outTarget', async () => {
  const root = temp('hatch-s2-clash-');
  try {
    repoAt(root, { 'a/x.cc': OLD, 'b/x.cc': OLD });
    config(root, { generate: { out: 'flat', base: { head: true } } });
    mkdirSync(join(root, 'flat'));
    writeFileSync(join(root, 'flat', 'x.cc.hatch'), 'Hatch: 1\nTarget: a/x.cc\n\n');
    const g = ok(await call('generate', { path: join(root, 'b', 'x.cc'), newText: NEW }));
    assert.equal(g['outExists'], true);
    assert.equal(g['outTarget'], 'a/x.cc', 'not this file\'s: the client asks before writing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stage 2: apply — refusals around --in, --verify and --base-from-disk', () => {
  const dir = temp('hatch-s2-apply-');
  try {
    repoAt(dir, { 'a.cc': OLD });
    const patch = 'Hatch: 1\n\n# match cpp\n    ...\n    int a = 1;\n    >>>\n    ...\n# end\n# patch\n      int b = 2;\n# end\n';
    writeFileSync(join(dir, 'p.hatch'), patch);

    const noIn = hatch(dir, ['apply', '--match', 'p.hatch', '--dry-run']);
    assert.equal(noIn.status, 1, noIn.stderr);
    // no Target and no config: by its name the patch is for `p` beside it, which is not there
    assert.match(noIn.stderr, /missing --in <file>: the patch is for .*[\\/]p \(by its name and place it would be\), and there is no such file/);

    const noConfig = hatch(dir, ['apply', '--match', 'p.hatch', '--dry-run', '--no-config']);
    assert.equal(noConfig.status, 1, noConfig.stderr);
    assert.match(noConfig.stderr, /missing --in/);

    const withGit = hatch(dir, ['apply', '--match', 'p.hatch', '--in', 'a.cc', '--verify', '--head', '--base-from-disk']);
    assert.equal(withGit.status, 1);
    assert.match(withGit.stderr, /--base-from-disk names the base of --verify, and only when no git coordinate does/);
    const notVerify = hatch(dir, ['apply', '--match', 'p.hatch', '--in', 'a.cc', '--dry-run', '--base-from-disk']);
    assert.equal(notVerify.status, 1);

    // --verify against the git base the flags name: the file on disk may be anything
    writeFileSync(join(dir, 'a.cc'), 'garbage that would not fit\n');
    const head = hatch(dir, ['apply', '--match', 'p.hatch', '--in', 'a.cc', '--verify', '--head']);
    assert.equal(head.status, 0, head.stderr);

    // a Target naming a file that is not there says so
    writeFileSync(join(dir, 'gone.hatch'), patch.replace('Hatch: 1\n', 'Hatch: 1\nTarget: gone.cc\n'));
    const gone = hatch(dir, ['apply', '--match', 'gone.hatch', '--dry-run']);
    assert.equal(gone.status, 1, gone.stderr);
    assert.match(gone.stderr, /the patch is for .*gone\.cc \(its Target names\), and there is no such file/);

    // with a Target, --in may be left out
    writeFileSync(join(dir, 'p.hatch'), patch.replace('Hatch: 1\n', 'Hatch: 1\nTarget: a.cc\n'));
    const byTarget = hatch(dir, ['apply', '--match', 'p.hatch', '--verify', '--head']);
    assert.equal(byTarget.status, 0, byTarget.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stage 2: init — --out goes with --upstream; the written config reads back as the project it describes', () => {
  const root = temp('hatch-s2-init-');
  try {
    const brave = join(root, 'src', 'brave');
    repoAt(join(root, 'src'), {});
    mkdirSync(brave);
    assert.equal(hatch(brave, ['init', '--out', 'p', '--dir', '.']).status, 1, '--out alone');
    const r = hatch(brave, ['init', '--upstream', '..', '--out', 'my-patches', '--dir', '.']);
    assert.equal(r.status, 0, r.stderr);
    const { project, config: loaded } = loadProject({ path: join(brave, 'x.hatch'), search: { isPatch: true }, useFile: true });
    assert.equal(project.upstreamRoot, join(root, 'src'));
    assert.equal(loaded.generate.out, 'my-patches');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── stage 3: the protocol ─────────────────────────────────────────────────────────

test('stage 3: configPath must be absolute; the patch\'s path that cannot be read is refused with what to send', async () => {
  const bad = failed(await call('config', { path: '/abs/a.cc', configPath: 'relative.json' }));
  assert.equal(bad.kind, 'BadRequest');
  assert.match(bad.message, /configPath must be an absolute path/);

  const unread = failed(await call('resolve', { path: join(tmpdir(), 'hatch-no-such-dir', 'x.cc.hatch') }));
  assert.equal(unread.kind, 'BadRequest');
  assert.match(unread.message, /cannot read the patch .* send its text as params\.patch/);
});

test('stage 3: config target is null for a file outside the upstream, and for a patch without a header', async () => {
  const root = temp('hatch-s3-target-');
  try {
    const src = join(root, 'src');
    repoAt(src, { 'in/a.cc': OLD, 'out.cc': OLD });
    config(src, { upstream: 'in', generate: { out: 'patches' } });
    assert.equal(ok(await call('config', { path: join(src, 'in', 'a.cc') }))['target'], 'a.cc');
    assert.equal(ok(await call('config', { path: join(src, 'out.cc') }))['target'], null, 'outside the upstream');
    writeFileSync(join(src, 'hand.hatch'), '# match cpp\n    a\n    >>>\n# end\n# patch\n    b\n# end\n');
    assert.equal(ok(await call('config', { path: join(src, 'hand.hatch') }))['target'], null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stage 3: X3 — a path outside the repository: the service names no flag, the CLI puts --repo-path in front', async () => {
  const dir = temp('hatch-s3-x3-');
  try {
    repoAt(dir, { 'a.cc': OLD });
    const e = failed(await call('generate', { path: join(dir, 'a.cc'), newText: NEW, baseGit: { repoPath: '/etc/passwd' } }));
    assert.equal(e.kind, 'GitError');
    assert.match(e.message, /^\/etc\/passwd: outside its repository root/);
    assert.equal((e.detail as Record<string, unknown>)['reason'], 'outside-repository');
    const cli = hatch(dir, ['generate', '--in', 'a.cc', '--repo-path', '/etc/passwd', '--no-config']);
    assert.match(cli.stderr, /--repo-path \/etc\/passwd: outside its repository root/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stage 3: X4 — elapsedMs on the wire, the line that is not JSON included', async () => {
  const child = spawn(process.execPath, ['--experimental-strip-types', join(ROOT, 'src', 'bin', 'service.ts')], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => (out += chunk));
  child.stdin.write('not json\n');
  child.stdin.write(`${JSON.stringify({ id: 2, method: 'version' })}\n`);
  child.stdin.end();
  await new Promise<void>((done) => child.on('close', () => done()));
  const replies = out.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(replies.length, 2, out);
  for (const r of replies) assert.ok(Number.isInteger(r['elapsedMs']), JSON.stringify(r));
  assert.deepEqual(replies.map((r) => r['ok']).sort(), [false, true]);
});

// ── stage 4: grammars inside ──────────────────────────────────────────────────────

test('stage 4: generate --download-grammars is gone (it warned through 0.4, F2)', () => {
  const dir = temp('hatch-s4-flag-');
  try {
    repoAt(dir, { 'a.cc': OLD });
    writeFileSync(join(dir, 'a.cc'), NEW);
    const plain = hatch(dir, ['generate', '--in', 'a.cc', '--head', '--no-config', '--out', '-']);
    assert.equal(plain.status, 0, plain.stderr);
    const flagged = hatch(dir, ['generate', '--in', 'a.cc', '--head', '--no-config', '--out', '-', '--download-grammars']);
    assert.equal(flagged.status, 1);
    assert.match(flagged.stderr, /unknown argument: --download-grammars/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stage 4: the service accepts allowDownload and goes on as without it', async () => {
  const r = ok(await call('resolve', { patch: '# match cpp\n    int a = 1;\n    >>>\n# end\n# patch\n    x\n# end\n', baseText: 'int a = 1;\n', language: 'cpp', allowDownload: true }));
  assert.equal((r['hunks'] as unknown[]).length, 1);
});

test('stage 4: fetch-grammars leaves pinned files alone — no network when grammars/ is complete', () => {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', join(ROOT, 'scripts', 'fetch-grammars.ts')], {
    cwd: ROOT,
    encoding: 'utf8',
    // a proxy that does not exist: any fetch would fail
    env: { ...process.env, HTTPS_PROXY: 'http://127.0.0.1:1', https_proxy: 'http://127.0.0.1:1' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /grammars\/: (\d+) grammar\(s\) — \1 present, 0 copied, 0 downloaded/);
});

test('stage 4: the package ships grammars/ and the fetch script runs before tests and packing', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    files: string[];
    scripts: Record<string, string>;
  };
  assert.ok(pkg.files.includes('grammars'));
  for (const script of ['pretest', 'prepack', 'grammars']) {
    assert.match(pkg.scripts[script]!, /scripts\/fetch-grammars\.ts/, script);
  }
});
