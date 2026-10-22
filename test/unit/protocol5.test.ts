import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { handle } from '../../src/service/handler.ts';
import type { ResponseMessage } from '../../src/service/protocol.ts';
import { packageIdentity } from '../../src/infra/version.ts';

// Protocol 5: `config` answers `language`, the word `generate` writes in `# match` — so a
// client making a patch by hand does not keep the core's table of extensions itself —
// and `header`, the header `generate` would write, so it keeps no list of fields either.

function ok(response: ResponseMessage): Record<string, unknown> {
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.ok(response.ok);
  return response.result as Record<string, unknown>;
}

const call = (method: string, params: object): Promise<ResponseMessage> => handle({ id: 1, method, params });

const OLD = 'void f() {\n  int a = 1;\n}\n';
const NEW = 'void f() {\n  int a = 2;\n}\n';

function inDir(prefix: string, body: (dir: string) => Promise<void>): Promise<void> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return body(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** the word after `# match` in a patch */
function matchWord(patch: string): string {
  const line = patch.split('\n').find((l) => l.startsWith('# match'));
  assert.ok(line !== undefined, patch);
  return line.slice('# match'.length).trim();
}

test('config: language is the language’s own name — .cc is cpp, .mm is objc', async () => {
  await inDir('hatch-p5-lang-', async (dir) => {
    for (const [file, name] of [['a.cc', 'cpp'], ['a.mm', 'objc'], ['a.py', 'python'], ['a.ts', 'typescript']] as const) {
      assert.equal(ok(await call('config', { path: join(dir, file) }))['language'], name, file);
    }
  });
});

test('config: generate.language from the config, then overrides.language, over the extension', async () => {
  await inDir('hatch-p5-lang-', async (dir) => {
    writeFileSync(join(dir, 'hatch.config.json'), JSON.stringify({ version: 2, generate: { language: 'objective-c++' } }));
    const path = join(dir, 'a.cc');
    assert.equal(ok(await call('config', { path }))['language'], 'objc', 'the config');
    assert.equal(ok(await call('config', { path, overrides: { language: 'c++' } }))['language'], 'cpp', 'overrides');
    // an empty name is no name: the config's stands, as in generate
    assert.equal(ok(await call('config', { path, overrides: { language: '' } }))['language'], 'objc', 'empty: none named');
  });
});

test('config: no language picked is null, not an error', async () => {
  await inDir('hatch-p5-lang-', async (dir) => {
    const c = ok(await call('config', { path: join(dir, 'notes.xyz') }));
    assert.equal(c['language'], null);
    assert.equal(ok(await call('config', { path: join(dir, 'Makefile') }))['language'], null);
    // a name no adapter answers to: generate would refuse it, config only says none
    assert.equal(ok(await call('config', { path: join(dir, 'a.cc'), overrides: { language: 'cobol' } }))['language'], null);
  });
});

test('config: a .hatch answers the language of the file pair names for it; no pair — null', async () => {
  await inDir('hatch-p5-lang-', async (dir) => {
    const code = join(dir, 'a.mm');
    writeFileSync(code, NEW);
    const g = ok(await call('generate', { path: code, baseText: OLD, newText: NEW }));
    const out = g['outPath'] as string;
    writeFileSync(out, g['patch'] as string);
    assert.equal(ok(await call('pair', { path: out }))['code'], code);
    assert.equal(ok(await call('config', { path: out }))['language'], 'objc');

    // a format newer than this hatch: pair names no file, so there is no language
    const stray = join(dir, 'newer.hatch');
    writeFileSync(stray, 'Hatch: 99\n\n');
    assert.equal(ok(await call('pair', { path: stray }))['code'], null);
    assert.equal(ok(await call('config', { path: stray }))['language'], null);
  });
});

test('config ≡ generate: language is the word generate writes in # match', async () => {
  await inDir('hatch-p5-lang-', async (dir) => {
    for (const [file, overrides] of [
      ['a.cc', {}],
      ['a.mm', {}],
      ['a.c', {}],
      ['a.h', { language: 'objc' }],
      ['a.cc', { language: 'c++' }],
      ['a.cc', { language: '' }],
    ] as const) {
      const path = join(dir, file);
      const c = ok(await call('config', { path, overrides }));
      const g = ok(await call('generate', { path, baseText: OLD, newText: NEW, ...overrides }));
      assert.equal(c['language'], matchWord(g['patch'] as string), `${file} ${JSON.stringify(overrides)}`);
    }
  });
});

// `config` answers `header`: the header `generate` would write for the file now, so a
// patch made by hand opens with the same fields, in the same order, as a generated one.

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** a repository with `a.cc` committed as OLD and changed to NEW on disk */
function inRepo(body: (dir: string) => Promise<void>): Promise<void> {
  return inDir('hatch-p5-header-', async (dir) => {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 't');
    writeFileSync(join(dir, 'a.cc'), OLD);
    git(dir, 'add', 'a.cc');
    git(dir, 'commit', '-q', '-m', 'base');
    writeFileSync(join(dir, 'a.cc'), NEW);
    await body(dir);
  });
}

/** the names of a header's lines, in order */
function names(header: string): string[] {
  assert.ok(header.endsWith('\n\n'), JSON.stringify(header));
  return header.trimEnd().split('\n').map((line) => line.slice(0, line.indexOf(':')));
}

function field(header: string, name: string): string | undefined {
  const line = header.split('\n').find((l) => l.startsWith(`${name}: `));
  return line?.slice(name.length + 2);
}

test('config: header for a git base — all five fields, in their order', async () => {
  await inRepo(async (dir) => {
    const c = ok(await call('config', { path: join(dir, 'a.cc'), overrides: { baseGit: {} } }));
    const header = c['header'] as string;
    assert.deepEqual(names(header), ['Hatch', 'Target', 'Base-Blob', 'Hatch-Version', 'Grammar']);
    assert.equal(field(header, 'Hatch'), '1');
    assert.equal(field(header, 'Target'), c['target']);
    assert.equal(field(header, 'Base-Blob'), git(dir, 'rev-parse', 'HEAD:a.cc'));
    assert.equal(field(header, 'Hatch-Version'), packageIdentity().version);
    assert.match(field(header, 'Grammar')!, /^tree-sitter-cpp@/);
  });
});

test('config ≡ generate: header is, byte for byte, the start of the patch generate writes', async () => {
  await inRepo(async (dir) => {
    const path = join(dir, 'a.cc');
    for (const [overrides, base] of [
      [{ baseGit: {} }, { baseGit: {} }],
      [{ baseGit: {}, language: 'objc' }, { baseGit: {} }],
      [{ base: 'text' }, { baseText: OLD }],
      [{ base: 'text', language: 'c++' }, { baseText: OLD }],
    ] as const) {
      const c = ok(await call('config', { path, overrides }));
      const { base: _, ...settings } = overrides as Record<string, unknown>;
      const g = ok(await call('generate', { path, newText: NEW, ...settings, ...base }));
      const header = c['header'] as string;
      assert.ok((g['patch'] as string).startsWith(header), `${JSON.stringify(overrides)}\n${header}\n---\n${g['patch'] as string}`);
      assert.equal((g['patch'] as string).slice(header.length).split('\n')[0]!.startsWith('# match'), true);
    }
  });
});

test('config: header for a text base has no Base-Blob', async () => {
  await inRepo(async (dir) => {
    const header = ok(await call('config', { path: join(dir, 'a.cc'), overrides: { base: 'text' } }))['header'] as string;
    assert.deepEqual(names(header), ['Hatch', 'Target', 'Hatch-Version', 'Grammar']);
    // no base at all: the same, and no error
    const none = ok(await call('config', { path: join(dir, 'a.cc') }));
    assert.equal(none['base'], null);
    assert.deepEqual(names(none['header'] as string), ['Hatch', 'Target', 'Hatch-Version', 'Grammar']);
  });
});

test('config: a file not in the base revision — no Base-Blob, no error', async () => {
  await inRepo(async (dir) => {
    writeFileSync(join(dir, 'b.cc'), NEW);
    const c = ok(await call('config', { path: join(dir, 'b.cc'), overrides: { baseGit: {} } }));
    assert.equal((c['base'] as { kind: string }).kind, 'unavailable');
    assert.deepEqual(names(c['header'] as string), ['Hatch', 'Target', 'Hatch-Version', 'Grammar']);
  });
});

test('config: no language picked — no Grammar', async () => {
  await inDir('hatch-p5-header-', async (dir) => {
    const c = ok(await call('config', { path: join(dir, 'notes.xyz'), overrides: { base: 'text' } }));
    assert.equal(c['language'], null);
    assert.deepEqual(names(c['header'] as string), ['Hatch', 'Target', 'Hatch-Version']);
  });
});

test('config: a file outside the upstream — no Target', async () => {
  await inDir('hatch-p5-header-', async (dir) => {
    mkdirSync(join(dir, 'up'));
    writeFileSync(join(dir, 'hatch.config.json'), JSON.stringify({ version: 2, upstream: 'up', generate: { out: 'patches' } }));
    const c = ok(await call('config', { path: join(dir, 'a.cc'), overrides: { base: 'text' } }));
    assert.equal(c['target'], null);
    assert.deepEqual(names(c['header'] as string), ['Hatch', 'Hatch-Version', 'Grammar']);
  });
});

test('config: a .hatch answers the header of its pair; no pair — null', async () => {
  await inRepo(async (dir) => {
    const code = join(dir, 'a.cc');
    const overrides = { baseGit: {} };
    const g = ok(await call('generate', { path: code, newText: NEW, baseGit: {} }));
    const out = g['outPath'] as string;
    writeFileSync(out, g['patch'] as string);
    const ofCode = ok(await call('config', { path: code, overrides }))['header'] as string;
    assert.equal(ok(await call('config', { path: out, overrides }))['header'], ofCode);
    assert.ok((g['patch'] as string).startsWith(ofCode));

    const stray = join(dir, 'newer.hatch');
    writeFileSync(stray, 'Hatch: 99\n\n');
    assert.equal(ok(await call('config', { path: stray, overrides }))['header'], null);
  });
});

test('config ≡ generate: header with baseGit.eol "worktree" — Base-Blob is the blob git stores, as generate writes it', async () => {
  await inRepo(async (dir) => {
    git(dir, 'config', 'core.autocrlf', 'false');
    writeFileSync(join(dir, 'a.cc'), NEW.replace(/\n/g, '\r\n'));
    const baseGit = { eol: 'worktree' };
    const header = ok(await call('config', { path: join(dir, 'a.cc'), overrides: { baseGit } }))['header'] as string;
    assert.equal(field(header, 'Base-Blob'), git(dir, 'rev-parse', 'HEAD:a.cc'), 'the stored blob, not the text as read');
    const g = ok(await call('generate', { path: join(dir, 'a.cc'), newText: NEW.replace(/\n/g, '\r\n'), baseGit }));
    assert.ok((g['patch'] as string).startsWith(header), `${header}\n---\n${g['patch'] as string}`);
  });
});

test('config: a language generate would refuse — header without Grammar, and generate refuses', async () => {
  await inDir('hatch-p5-header-', async (dir) => {
    const path = join(dir, 'a.cc');
    const c = ok(await call('config', { path, overrides: { base: 'text', language: 'cobol' } }));
    assert.equal(c['language'], null);
    assert.deepEqual(names(c['header'] as string), ['Hatch', 'Target', 'Hatch-Version'], 'no Grammar for no language');
    const g = await call('generate', { path, baseText: OLD, newText: NEW, language: 'cobol' });
    assert.equal(g.ok, false);
    assert.equal(!g.ok && g.error.kind, 'LanguageError', 'the header is what config can say; generate writes none');
  });
});
