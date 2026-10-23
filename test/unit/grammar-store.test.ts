import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { digest, grammarDirs, packageGrammarDir, resolveGrammar } from '../../src/infra/grammar-store.ts';
import { adaptersByName } from '../../src/lang/adapter.ts';
import { GrammarError } from '../../src/core/errors.ts';

const CLI = fileURLToPath(new URL('../../src/bin/sir.ts', import.meta.url));
const BYTES = new TextEncoder().encode('not really wasm');
const SOURCE = { file: 'tree-sitter-nonesuch.wasm', package: 'tree-sitter-nonesuch', version: '1.2.3', sha256: digest(BYTES) };

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
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

test('every pinned grammar is in grammars/ of the package, with its pinned bytes', async () => {
  await withEnv({ SIR_GRAMMAR_DIR: undefined }, async () => {
    for (const adapter of new Set(adaptersByName().values())) {
      if (adapter.grammar === undefined) continue;
      assert.ok(existsSync(join(packageGrammarDir(), adapter.grammar.file)), adapter.name);
      assert.ok((await resolveGrammar(adapter.grammar)).byteLength > 0, adapter.name);
    }
  });
});

test('SIR_GRAMMAR_DIR comes first; its file must be the pinned one, or it is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sir-grammar-dir-'));
  await writeFile(join(dir, SOURCE.file), BYTES);
  await withEnv({ SIR_GRAMMAR_DIR: dir }, async () => {
    assert.deepEqual(grammarDirs(), [dir, packageGrammarDir()]);
    assert.equal(digest(await resolveGrammar(SOURCE)), SOURCE.sha256);
    await assert.rejects(
      () => resolveGrammar({ ...SOURCE, sha256: 'b'.repeat(64) }),
      (e: unknown) => e instanceof GrammarError && /is not the grammar tree-sitter-nonesuch@1\.2\.3 pins/.test(e.message),
    );
  });
});

test('a grammar nowhere is a fault of the build, named with where it was looked for — nothing is fetched', async () => {
  await withEnv({ SIR_GRAMMAR_DIR: undefined }, async () => {
    await assert.rejects(
      () => resolveGrammar({ ...SOURCE, file: 'tree-sitter-absent.wasm' }, 'absent'),
      (e: unknown) =>
        e instanceof GrammarError &&
        /the absent grammar .* is missing from this build of sir/.test(e.message) &&
        e.message.includes(packageGrammarDir()) &&
        !/download|fetch/.test(e.message),
    );
  });
});

test('an explicit path is that file, checked the same way', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sir-grammar-path-'));
  const path = join(dir, 'g.wasm');
  await writeFile(path, BYTES);
  assert.equal(digest(await resolveGrammar({ ...SOURCE, path })), SOURCE.sha256);
  await assert.rejects(() => resolveGrammar({ ...SOURCE, path: 'relative.wasm' }), /must be absolute/);
});

test('F2: the command `sir grammars` and the flag --download-grammars are both gone', () => {
  const grammars = spawnSync(process.execPath, ['--experimental-strip-types', CLI, 'grammars'], { encoding: 'utf8' });
  assert.equal(grammars.status, 1, 'an unknown command is a usage error');
  assert.match(grammars.stderr, /unknown command 'grammars'/);
  assert.doesNotMatch(grammars.stderr, /known commands: [^\n]*\bgrammars\b/, 'and it is not offered back');

  const apply = spawnSync(
    process.execPath,
    ['--experimental-strip-types', CLI, 'apply', '--match', 'nope.sirp', '--in', 'x.cc', '--dry-run', '--download-grammars'],
    { encoding: 'utf8' },
  );
  assert.equal(apply.status, 1);
  assert.match(apply.stderr, /unknown argument: --download-grammars/);
});
