import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  CONFIG_FILE_NAME,
  CONFIG_MIN,
  CONFIG_VERSION,
  FIELDS,
  configTemplate,
  fieldsOf,
  readConfigFile,
  schemaUrl,
  schemaVersions,
  suggestedConfigPath,
} from '../../src/infra/config/index.ts';
import type { FieldSpec } from '../../src/infra/config/index.ts';
import { checkKeysOf } from '../../src/infra/config/schema.ts';
import { olderSchemaNote } from '../../src/cli/init.ts';
import { ConfigError } from '../../src/core/errors.ts';

const CLI = fileURLToPath(new URL('../../src/bin/sir.ts', import.meta.url));

function assertMinimal(text: string): void {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), ['$schema', 'version']);
  assert.equal(parsed['version'], CONFIG_VERSION);
  assert.match(String(parsed['$schema']), new RegExp(`^https://.*/schemas/sir\\.config\\.v${CONFIG_VERSION}\\.schema\\.json$`));
  assert.equal(text, `${JSON.stringify(parsed, null, 2)}\n`);
}

function withTempDir(body: (dir: string) => void): () => void {
  return () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sir-init-')));
    try {
      body(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function sample(spec: FieldSpec): unknown {
  switch (spec.kind) {
    case 'boolean':
      return true;
    case 'count':
      return 7;
    case 'countOrAll':
      return 'all';
    case 'stringOrNull':
      return spec.key === 'out' ? 'patches/' : 'cpp';
    case 'eol':
      return 'worktree';
  }
}

function nested(specs: readonly FieldSpec[]): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const spec of specs) {
    const parts = spec.path.split('.');
    let node = root;
    for (const part of parts.slice(0, -1)) node = (node[part] ??= {}) as Record<string, unknown>;
    node[parts.at(-1)!] = sample(spec);
  }
  return root;
}

function readBack(text: string): Record<string, unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'sir-tpl-'));
  try {
    const file = join(dir, CONFIG_FILE_NAME);
    writeFileSync(file, text);
    return readConfigFile(file) as Record<string, unknown>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('template → loader → the same settings, for every version in the range', () => {
  for (let v = CONFIG_MIN; v <= CONFIG_VERSION; v++) {
    const specs = fieldsOf(v);
    const expected = Object.fromEntries(specs.map((s) => [s.key, sample(s)]));

    const full = configTemplate({ version: v, settings: nested(specs) });
    assert.equal(full.version, v);
    assert.deepEqual(readBack(full.text), expected, `v${v}, nested`);

    const dotted = Object.fromEntries(specs.map((s) => [s.path, sample(s)]));
    assert.equal(configTemplate({ version: v, settings: dotted }).text, full.text, `v${v}, dotted = nested`);

    assert.deepEqual(readBack(configTemplate({ version: v }).text), {}, `v${v}, minimal`);
  }
});

test('the minimal template is $schema and version only, 2-space JSON with a final newline', () => {
  const { text, version } = configTemplate();
  assert.equal(version, CONFIG_VERSION);
  assert.equal(text, `{\n  "$schema": "${schemaUrl(CONFIG_VERSION)}",\n  "version": ${CONFIG_VERSION}\n}\n`);
});

test('keys come out in schema order, whatever order they were given in', () => {
  const { text } = configTemplate({ settings: { 'generate.siblings.max': 2, generate: { exact: true, out: 'p/' } } });
  const order = ['"$schema"', '"version"', '"generate"', '"out"', '"exact"', '"siblings"', '"max"'];
  const at = order.map((k) => text.indexOf(k));
  assert.deepEqual([...at].sort((a, b) => a - b), at);
});

test('a key not in the chosen version: ONE error naming every such key and where each belongs', () => {
  assert.throws(
    () => configTemplate({ settings: { generate: { nope: 1, exact: true, parents: { deep: 2 } }, top: 1 } }),
    (e: unknown) => {
      assert.ok(e instanceof ConfigError);
      for (const key of ['generate.nope', 'generate.parents.deep', 'top']) assert.match(e.message, new RegExp(`${key} \\(no such key\\)`));
      assert.doesNotMatch(e.message, /generate\.exact \(/);
      assert.deepEqual(e.detail()?.['version'], CONFIG_VERSION);
      assert.equal((e.detail()?.['keys'] as unknown[]).length, 3);
      return true;
    },
  );
  assert.throws(
    () => checkKeysOf(['generate.out', 'generate.exact'], 0, undefined),
    /not in config schema v0: generate\.out \(since v1\), generate\.exact \(since v1\)/,
  );
});

test('values are checked as the loader checks them, pairs included', () => {
  assert.throws(() => configTemplate({ settings: { generate: { bridgeGap: -1 } } }), /generate\.bridgeGap/);
  assert.throws(() => configTemplate({ settings: { upstream: '.' } }), /upstream.*set generate\.out .* to a directory/);
  assert.throws(
    () => configTemplate({ settings: { generate: { mirror: true } } }),
    (e: unknown) => {
      assert.ok(e instanceof ConfigError);
      assert.deepEqual(e.detail(), { version: 3, keys: [{ path: 'generate.mirror', since: 1, until: 1 }] });
      assert.match(e.message, /generate\.mirror \(v1–v1; "upstream": "\." keeps the patches/);
      return true;
    },
  );
  assert.throws(() => configTemplate({ settings: [] }), /settings must be an object/);
});

test('C5: a version outside the range names the side to update', () => {
  assert.throws(() => configTemplate({ version: CONFIG_VERSION + 1 }), /does not know yet .*update sir/);
  assert.throws(() => configTemplate({ version: CONFIG_MIN - 1 }), /no longer reads .*move the file to v/);
  assert.throws(() => configTemplate({ version: '1' }), /must be a whole number/);
});

test('the loader holds a file to the keys of the version it names', () => {
  assert.throws(() => readBack('{ "version": 0, "generate": { "exact": true } }'), ConfigError);
  assert.deepEqual(readBack('{ "generate": { "exact": true } }'), { exact: true }, 'no version: the newest');
});

test('every version has a one-line summary naming each of its keys', () => {
  const versions = schemaVersions();
  assert.deepEqual(versions.map((v) => v.version), Array.from({ length: CONFIG_VERSION - CONFIG_MIN + 1 }, (_, i) => CONFIG_MIN + i));
  for (const { version, summary } of versions) {
    assert.ok(summary.startsWith(`v${version}: `));
    assert.ok(!summary.includes('\n'));
    for (const f of fieldsOf(version)) assert.ok(summary.includes(f.path.split('.').slice(-1)[0]!), f.path);
  }
  assert.match(schemaVersions()[0]!.summary, /^v3: upstream; generate: out, /);
  assert.ok(FIELDS.every((f) => Number.isInteger(f.since) && f.since >= 1));
});

test('suggestedConfigPath: the repository root, outside one the directory itself', withTempDir((dir) => {
  mkdirSync(join(dir, 'repo', '.git'), { recursive: true });
  mkdirSync(join(dir, 'repo', 'src', 'deep'), { recursive: true });
  assert.equal(suggestedConfigPath(join(dir, 'repo', 'src', 'deep')), join(dir, 'repo', CONFIG_FILE_NAME));
  mkdirSync(join(dir, 'loose'));
  assert.equal(suggestedConfigPath(join(dir, 'loose')), join(dir, 'loose', CONFIG_FILE_NAME));
}));

function init(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('node', ['--experimental-strip-types', CLI, 'init', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

test('sir init --dry-run prints the template and writes nothing', withTempDir((dir) => {
  const r = init(['--dry-run'], dir);
  assert.equal(r.status, 0, r.stderr);
  assertMinimal(r.stdout);
  assert.throws(() => readFileSync(join(dir, CONFIG_FILE_NAME)));
}));

test('sir init writes at the git root from a subdirectory', withTempDir((dir) => {
  mkdirSync(join(dir, '.git'));
  mkdirSync(join(dir, 'a', 'b'), { recursive: true });
  const r = init([], join(dir, 'a', 'b'));
  assert.equal(r.status, 0, r.stderr);
  assertMinimal(readFileSync(join(dir, CONFIG_FILE_NAME), 'utf8'));
}));

test('sir init: an existing file is kept without --force (exit 5), replaced with it', withTempDir((dir) => {
  const file = join(dir, CONFIG_FILE_NAME);
  writeFileSync(file, 'mine');
  const refused = init(['--dir', dir], dir);
  assert.equal(refused.status, 5);
  assert.match(refused.stderr, /already exists/);
  assert.equal(readFileSync(file, 'utf8'), 'mine');

  const forced = init(['--dir', dir, '--force'], dir);
  assert.equal(forced.status, 0, forced.stderr);
  assertMinimal(readFileSync(file, 'utf8'));
}));

test('sir init --config-version outside the range: exit 5, the side to update', withTempDir((dir) => {
  const r = init(['--config-version', String(CONFIG_VERSION + 1), '--dry-run'], dir);
  assert.equal(r.status, 5);
  assert.match(r.stderr, /update sir/);
}));

test('an older schema written gets one line saying so; the newest none', () => {
  assert.equal(olderSchemaNote(CONFIG_VERSION), undefined);
  assert.equal(olderSchemaNote(CONFIG_VERSION - 1), `wrote config schema v${CONFIG_VERSION - 1}; the newest is v${CONFIG_VERSION}`);
  assert.equal(olderSchemaNote(CONFIG_VERSION - 1, true), `printed config schema v${CONFIG_VERSION - 1}; the newest is v${CONFIG_VERSION}`);
});
