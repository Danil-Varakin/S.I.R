import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { handle } from '../../src/service/handler.ts';
import type { ResponseMessage } from '../../src/service/protocol.ts';
import { configFileFor } from '../../src/infra/project.ts';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'bin', 'sir.ts');
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
  const file = join(dir, 'sir.config.json');
  writeFileSync(file, JSON.stringify({ version: 3, ...value }));
  return file;
}

function sir(cwd: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', CLI, ...args], { cwd, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function ok(response: ResponseMessage): Record<string, unknown> {
  assert.equal(response.ok, true, JSON.stringify(response));
  return (response as { result: Record<string, unknown> }).result;
}

const call = (method: string, params: object): Promise<ResponseMessage> => handle({ id: 1, method, params });

function brave(): { root: string; src: string; braveDir: string; browser: string; v8File: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sir-l1-')));
  const src = join(root, 'src');
  repoAt(src, { 'chrome/browser/ui/browser.h': OLD });
  repoAt(join(src, 'v8'), { 'src/objects/js-objects.cc': OLD });
  const braveDir = join(src, 'brave');
  repoAt(braveDir, { 'README': 'brave\n' });
  config(braveDir, { upstream: '..', generate: { out: 'patches', base: { head: true } } });
  const browser = join(src, 'chrome', 'browser', 'ui', 'browser.h');
  const v8File = join(src, 'v8', 'src', 'objects', 'js-objects.cc');
  writeFileSync(browser, NEW);
  writeFileSync(v8File, NEW);
  return { root, src, braveDir, browser, v8File };
}

test('L1 Brave: the config of a Chromium file is the one whose upstream claims it', () => {
  const L = brave();
  try {
    assert.equal(configFileFor(L.browser), join(L.braveDir, 'sir.config.json'));
    assert.equal(configFileFor(L.v8File), join(L.braveDir, 'sir.config.json'), 'v8 is a repository of its own, under src');
    assert.equal(configFileFor(join(L.braveDir, 'patches', 'x.sirp'), { isPatch: true }), join(L.braveDir, 'sir.config.json'));
  } finally {
    rmSync(L.root, { recursive: true, force: true });
  }
});

test('L1 Brave: generate puts the patch in src/brave/patches, Target from src, base from git', () => {
  const L = brave();
  try {
    const r = sir(L.src, 'generate', '--in', L.browser);
    assert.equal(r.status, 0, r.stderr);
    const patch = join(L.braveDir, 'patches', 'chrome', 'browser', 'ui', 'browser.h.sirp');
    const blob = git(L.src, 'rev-parse', 'HEAD:chrome/browser/ui/browser.h');
    assert.match(readFileSync(patch, 'utf8'), new RegExp(`^Sir: 2\nTarget: chrome/browser/ui/browser\\.h\nBase-Blob: ${blob}\n`));

    const v8 = sir(L.src, 'generate', '--in', L.v8File);
    assert.equal(v8.status, 0, v8.stderr);
    const v8Patch = join(L.braveDir, 'patches', 'v8', 'src', 'objects', 'js-objects.cc.sirp');
    assert.match(readFileSync(v8Patch, 'utf8'), /^Sir: 2\nTarget: v8\/src\/objects\/js-objects\.cc\n/);
    assert.match(readFileSync(v8Patch, 'utf8'), new RegExp(`Base-Blob: ${git(join(L.src, 'v8'), 'rev-parse', 'HEAD:src/objects/js-objects.cc')}`));

    const verify = sir(L.braveDir, 'apply', '--verify', '--match', 'patches/chrome/browser/ui/browser.h.sirp');
    assert.equal(verify.status, 0, verify.stderr);
    assert.match(verify.stdout, /verify: ok/);
  } finally {
    rmSync(L.root, { recursive: true, force: true });
  }
});

test('L1 Brave: the service pairs both ways and resolves against the config\'s base', async () => {
  const L = brave();
  try {
    const code = ok(await call('pair', { path: L.browser }));
    const patch = join(L.braveDir, 'patches', 'chrome', 'browser', 'ui', 'browser.h.sirp');
    assert.deepEqual(code, { kind: 'code', patchPath: patch, exists: false, how: 'upstream' });

    const g = ok(await call('generate', { path: L.browser, newText: NEW }));
    assert.equal(g['outPath'], patch);
    assert.equal(g['baseSpec'], 'HEAD:chrome/browser/ui/browser.h');
    mkdirSync(dirname(patch), { recursive: true });
    writeFileSync(patch, String(g['patch']));

    assert.deepEqual(ok(await call('pair', { path: patch })), { kind: 'patch', code: L.browser, exists: true, how: 'target' });
    const c = ok(await call('config', { path: L.browser }));
    assert.equal(c['file'], join(L.braveDir, 'sir.config.json'));
    assert.equal(c['upstreamRoot'], L.src);
    assert.ok((c['watch'] as string[]).includes(join(L.braveDir, 'sir.config.json')));

    const resolved = ok(await call('resolve', { path: L.browser, patch: g['patch'] }));
    assert.equal(resolved['baseSpec'], 'HEAD:chrome/browser/ui/browser.h');

    const again = ok(await call('generate', { path: L.browser, newText: NEW }));
    assert.equal(again['outExists'], true);
    assert.equal(again['outTarget'], 'chrome/browser/ui/browser.h');
  } finally {
    rmSync(L.root, { recursive: true, force: true });
  }
});

test('L2: the upstream inside the project — the config above the upstream\'s repository claims it', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sir-l2-')));
  try {
    const proj = join(root, 'proj');
    repoAt(proj, { 'README': 'x\n' });
    config(proj, { upstream: 'chromium', generate: { out: 'patches', base: { head: true } } });
    const chromium = join(proj, 'chromium');
    repoAt(chromium, { 'base/a.cc': OLD });
    writeFileSync(join(chromium, 'base', 'a.cc'), NEW);

    assert.equal(configFileFor(join(chromium, 'base', 'a.cc')), join(proj, 'sir.config.json'));
    const r = sir(root, 'generate', '--in', join(chromium, 'base', 'a.cc'));
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(join(proj, 'patches', 'base', 'a.cc.sirp'), 'utf8'), /^Sir: 2\nTarget: base\/a\.cc\n/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('L3: beside — nothing claims the file from where it is; --config, SIR_CONFIG or the current directory do', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sir-l3-')));
  try {
    const proj = join(root, 'proj');
    const file = config(proj, { upstream: '../chromium/src', generate: { out: 'patches', base: { head: true } } });
    const src = join(root, 'chromium', 'src');
    repoAt(src, { 'base/a.cc': OLD });
    const code = join(src, 'base', 'a.cc');
    writeFileSync(code, NEW);

    assert.equal(configFileFor(code), undefined);
    assert.equal(configFileFor(code, { cwd: proj }), file, 'the current directory, when its config claims the file');
    assert.equal(configFileFor(code, { cwd: root }), undefined);
    const r = sir(root, 'generate', '--in', code, '--config', file);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(proj, 'patches', 'base', 'a.cc.sirp')));
    const fromProj = sir(proj, 'generate', '--in', code);
    assert.equal(fromProj.status, 0, fromProj.stderr);

    const away = join(root, 'away.cc.sirp');
    writeFileSync(away, readFileSync(join(proj, 'patches', 'base', 'a.cc.sirp'), 'utf8'));
    assert.equal(sir(root, 'apply', '--match', away, '--verify').status, 1);
    const named = sir(root, 'apply', '--match', away, '--verify', '--config', file);
    assert.equal(named.status, 0, named.stderr);
    assert.match(named.stdout, /verify: ok/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('two configs that claim one file are an error that names both', () => {
  const L = brave();
  try {
    const other = config(join(L.src, 'other'), { upstream: '..', generate: { out: 'patches' } });
    assert.throws(
      () => configFileFor(L.browser),
      (e: unknown) => e instanceof Error && e.message.includes(other) && e.message.includes(join(L.braveDir, 'sir.config.json')),
    );
  } finally {
    rmSync(L.root, { recursive: true, force: true });
  }
});

test('one repository: "upstream": "." gives the tree generate.mirror gave; no upstream — as before', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sir-one-')));
  try {
    repoAt(root, { 'src/a.cc': OLD });
    writeFileSync(join(root, 'src', 'a.cc'), NEW);
    config(root, { upstream: '.', generate: { out: 'patches', base: { head: true } } });
    assert.equal(sir(root, 'generate', '--in', 'src/a.cc').status, 0);
    assert.match(readFileSync(join(root, 'patches', 'src', 'a.cc.sirp'), 'utf8'), /^Sir: 2\nTarget: src\/a\.cc\n/);

    config(root, { generate: { base: { head: true } } });
    assert.equal(sir(root, 'generate', '--in', 'src/a.cc').status, 0);
    assert.ok(existsSync(join(root, 'src', 'a.cc.sirp')), 'beside the file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('overwrite: a computed place holding another file\'s patch is asked about; --out x.sirp is not', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sir-over-')));
  try {
    repoAt(root, { 'a/x.cc': OLD, 'b/x.cc': OLD });
    writeFileSync(join(root, 'a', 'x.cc'), NEW);
    writeFileSync(join(root, 'b', 'x.cc'), NEW);
    config(root, { generate: { out: 'flat', base: { head: true } } });
    assert.equal(sir(root, 'generate', '--in', 'a/x.cc').status, 0);
    assert.equal(sir(root, 'generate', '--in', 'a/x.cc').status, 0, 'the same file again: written over');

    const clash = sir(root, 'generate', '--in', 'b/x.cc');
    assert.equal(clash.status, 5, clash.stderr);
    assert.match(clash.stderr, /holds the patch of a\/x\.cc/);
    assert.match(readFileSync(join(root, 'flat', 'x.cc.sirp'), 'utf8'), /Target: a\/x\.cc/, 'not written over');

    assert.equal(sir(root, 'generate', '--in', 'b/x.cc', '--yes').status, 0);
    assert.match(readFileSync(join(root, 'flat', 'x.cc.sirp'), 'utf8'), /Target: b\/x\.cc/);
    assert.equal(sir(root, 'generate', '--in', 'a/x.cc', '--out', 'flat/x.cc.sirp').status, 0, 'a file named outright');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('init --upstream writes the layout, and refuses an upstream that is not there', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sir-init-')));
  try {
    const braveDir = join(root, 'src', 'brave');
    repoAt(braveDir, { README: 'x\n' });
    const r = sir(braveDir, 'init', '--upstream', '..');
    assert.equal(r.status, 0, r.stderr);
    const written = JSON.parse(readFileSync(join(braveDir, 'sir.config.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(written['upstream'], '..');
    assert.deepEqual(written['generate'], { out: 'patches' });
    assert.equal(sir(braveDir, 'init', '--upstream', 'nope', '--force').status, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('3.2/3.3 Brave: config answers the project and the Target; resolve and apply take the patch\'s path', async () => {
  const L = brave();
  try {
    const c = ok(await call('config', { path: L.browser }));
    assert.equal(c['projectRoot'], L.braveDir);
    assert.equal(c['upstreamRoot'], L.src);
    assert.equal(c['target'], 'chrome/browser/ui/browser.h');

    const g = ok(await call('generate', { path: L.browser, newText: NEW }));
    const patchPath = String(g['outPath']);
    mkdirSync(dirname(patchPath), { recursive: true });
    writeFileSync(patchPath, String(g['patch']));
    assert.equal(ok(await call('config', { path: patchPath }))['target'], 'chrome/browser/ui/browser.h');

    const r = ok(await call('resolve', { path: patchPath }));
    assert.equal(r['code'], L.browser);
    assert.equal(r['baseSpec'], 'HEAD:chrome/browser/ui/browser.h');
    const header = r['header'] as Record<string, unknown>;
    assert.equal(header['format'], 2);
    assert.equal(header['target'], 'chrome/browser/ui/browser.h');
    assert.equal(header['generatedBy'], undefined, 'the names of protocol 4 are gone');
    assert.match(String(header['sirVersion']), /^\d/);
    assert.deepEqual(r['warningsAt'], []);
    const a = ok(await call('apply', { path: patchPath }));
    assert.equal(a['text'], NEW);
    assert.equal(a['code'], L.browser);

    const old = ok(await call('resolve', { path: L.browser, patch: g['patch'] }));
    assert.equal(old['code'], L.browser);

    const nameless = join(L.braveDir, 'elsewhere', 'x.cc.sirp');
    mkdirSync(dirname(nameless), { recursive: true });
    writeFileSync(nameless, '# match cpp\n    a\n    >>>\n# end\n# patch\n    b\n# end\n');
    const refused = await call('resolve', { path: nameless });
    assert.equal(refused.ok, false);
    assert.match((refused as { error: { message: string } }).error.message, /names no file it is for \(outside-out\)/);
  } finally {
    rmSync(L.root, { recursive: true, force: true });
  }
});

test('3.1 beside (L3): configPath names the project for config, pair, generate and resolve', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sir-l3s-')));
  try {
    const proj = join(root, 'proj');
    const file = config(proj, { upstream: '../chromium/src', generate: { out: 'patches', base: { head: true } } });
    const src = join(root, 'chromium', 'src');
    repoAt(src, { 'base/a.cc': OLD });
    const code = join(src, 'base', 'a.cc');
    writeFileSync(code, NEW);

    assert.equal(ok(await call('config', { path: code }))['file'], null, 'nothing claims it from where it is');
    const c = ok(await call('config', { path: code, configPath: file }));
    assert.equal(c['file'], file);
    assert.equal(c['target'], 'base/a.cc');
    const patchPath = join(proj, 'patches', 'base', 'a.cc.sirp');
    assert.equal(ok(await call('pair', { path: code, configPath: file }))['patchPath'], patchPath);
    const g = ok(await call('generate', { path: code, newText: NEW, configPath: file }));
    assert.equal(g['outPath'], patchPath);
    const r = ok(await call('resolve', { path: code, patch: g['patch'], configPath: file }));
    assert.equal(r['baseSpec'], 'HEAD:base/a.cc');
    const bad = await call('config', { path: code, configPath: file, overrides: { configPath: join(root, 'x.json') } });
    assert.equal(bad.ok, false, 'two configs named');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('X1: resolve and apply answer warningsAt for a patch edited by hand, headings spelled any way', async () => {
  const patch = 'Sir: 2\n\n## match cpp\n    ...\n    int a = 1;\n    >>>\n    ...\n## end\n## patch:\n    int b = 2;   \n## end\n';
  for (const method of ['resolve', 'apply']) {
    const r = ok(await call(method, { patch, baseText: 'int a = 1;\n', language: 'cpp' }));
    const at = r['warningsAt'] as { hunk: number; mdLine: number; message: string }[];
    assert.equal(at.length, 1, method);
    assert.equal(at[0]!.hunk, 1);
    assert.equal(at[0]!.mdLine, 10, 'the line with the trailing spaces');
    assert.deepEqual(r['header'], { format: 2 });
    assert.equal(r['code'], null, 'no path, no file');
  }
});

test('X4: every reply carries elapsedMs, a failure too', async () => {
  const good = await call('version', {});
  assert.ok(good.ok && Number.isInteger(good.elapsedMs) && good.elapsedMs >= 0);
  const bad = await call('nope', {});
  assert.ok(!bad.ok && Number.isInteger(bad.elapsedMs));
});
