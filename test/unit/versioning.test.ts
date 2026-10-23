import { test } from 'node:test';
import { FORMAT_MIN, FORMAT_VERSION, HEADER_FIELDS } from '../../src/core/header.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { PROTOCOL_MIN, PROTOCOL_VERSION } from '../../src/service/protocol.ts';
import { CONFIG_MIN, CONFIG_VERSION, fieldsOf } from '../../src/infra/config/schema.ts';
import { SCHEMA_RELEASED_IN, schemaUrl } from '../../src/infra/config/template.ts';
import { handle } from '../../src/service/handler.ts';
import { FIELDS } from '../../src/infra/config/schema.ts';
import { SPEC as GENERATE_SPEC } from '../../src/cli/generate.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (name: string): string => readFileSync(join(ROOT, name), 'utf8');
const json = (name: string): Record<string, unknown> => JSON.parse(read(name)) as Record<string, unknown>;

const PACKAGE = json('package.json')['version'] as string;

test('R1/C1: both ranges are ranges of positive whole numbers, minimum first', () => {
  for (const [name, min, max] of [
    ['protocol', PROTOCOL_MIN, PROTOCOL_VERSION],
    ['config schema', CONFIG_MIN, CONFIG_VERSION],
  ] as const) {
    assert.ok(Number.isInteger(min) && min >= 1, `${name}: minimum ${min}`);
    assert.ok(Number.isInteger(max) && max >= min, `${name}: ${min}–${max}`);
  }
});

test('R1: the service announces the range it serves, not a single number', async () => {
  const response = await handle({ id: 1, method: 'version' });
  assert.ok(response.ok);
  const result = response.result as Record<string, unknown>;
  assert.equal(result['protocol'], PROTOCOL_VERSION);
  assert.equal(result['protocolMin'], PROTOCOL_MIN);
  assert.equal(result['configSchema'], CONFIG_VERSION);
  assert.equal(result['configSchemaMin'], CONFIG_MIN);
});

test('C1: sir.config.schema.json states the range the code reads', () => {
  const schema = json('sir.config.schema.json') as { properties: { version: Record<string, unknown> } };
  const version = schema.properties.version;
  assert.equal(version['minimum'], CONFIG_MIN, 'minimum = CONFIG_MIN');
  assert.equal(version['maximum'], CONFIG_VERSION, 'maximum = CONFIG_VERSION');
  assert.equal(version['const'], undefined, 'a range, never a single value');
});

test('P5: package-lock.json carries the same version as package.json', () => {
  const lock = json('package-lock.json') as { version: string; packages: Record<string, { version: string }> };
  assert.equal(lock.version, PACKAGE);
  assert.equal(lock.packages['']!.version, PACKAGE);
});

test('P6: CHANGELOG.md has the entry of the version package.json names', () => {
  assert.match(read('CHANGELOG.md'), new RegExp(`^## ${PACKAGE.replace(/\./g, '\\.')} — \\d{4}-\\d{2}-\\d{2}$`, 'm'));
});

test('P6: the newest CHANGELOG entry states the ranges the code has now', () => {
  const changelog = read('CHANGELOG.md');
  const newest = changelog.slice(changelog.indexOf('\n## '));
  const line = /\*\*Protocol (\d+)–(\d+) · config schema (\d+)–(\d+) · patch format (\d+)–(\d+)\*\*/.exec(newest);
  assert.ok(line !== null, 'the newest entry opens with its ranges');
  assert.deepEqual(
    line.slice(1).map(Number),
    [PROTOCOL_MIN, PROTOCOL_VERSION, CONFIG_MIN, CONFIG_VERSION, FORMAT_MIN, FORMAT_VERSION],
    'protocol, config and patch format M–N in the newest entry match src/',
  );
});

test('R10: every protocol a client may still speak has its section in PROTOCOL.md', () => {
  const protocol = read('PROTOCOL.md');
  for (let n = PROTOCOL_MIN; n <= PROTOCOL_VERSION; n++) {
    assert.match(protocol, new RegExp(`^### Protocol ${n}$`, 'm'), `PROTOCOL.md has "### Protocol ${n}"`);
  }
});

test('R10: every number the code speaks has its row in VERSIONING.md', () => {
  const versioning = read('VERSIONING.md');
  const section = (title: string): string => {
    const from = versioning.indexOf(`### ${title}`);
    assert.ok(from !== -1, `VERSIONING.md has "### ${title}"`);
    const to = versioning.indexOf('\n### ', from + 1);
    return versioning.slice(from, to === -1 ? undefined : to);
  };
  assert.match(section('Protocol'), new RegExp(`^\\| ${PROTOCOL_VERSION} \\|`, 'm'), `protocol ${PROTOCOL_VERSION}`);
  assert.match(section('Config schema'), new RegExp(`^\\| ${CONFIG_VERSION} \\|`, 'm'), `config schema ${CONFIG_VERSION}`);
  assert.match(
    section('Releases'),
    new RegExp(`^\\| ${PACKAGE.replace(/\./g, '\\.')} \\|`, 'm'),
    `a row for the released ${PACKAGE}`,
  );
});

test('C1: every config schema in the range has its own frozen JSON Schema, holding that version\'s keys', () => {
  const leaves = (node: Record<string, unknown>, prefix = ''): string[] =>
    Object.entries((node['properties'] ?? {}) as Record<string, Record<string, unknown>>).flatMap(([key, sub]) => {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      return sub['properties'] !== undefined ? leaves(sub, path) : [path];
    });
  for (let v = CONFIG_MIN; v <= CONFIG_VERSION; v++) {
    const file = `schemas/sir.config.v${v}.schema.json`;
    const schema = json(file) as { $id: string; properties: { version: Record<string, unknown> } };
    assert.ok(schema.$id.endsWith(`/schemas/sir.config.v${v}.schema.json`), `${file}: $id names this file`);
    assert.ok(schemaUrl(v).endsWith(`/schemas/sir.config.v${v}.schema.json`), `v${v}: the template points at this file`);
    assert.equal(schema.properties.version['minimum'], v, `${file}: checks v${v} only`);
    assert.equal(schema.properties.version['maximum'], v, `${file}: checks v${v} only`);
    assert.deepEqual(
      leaves(schema as unknown as Record<string, unknown>).filter((p) => p !== '$schema' && p !== 'version').sort(),
      fieldsOf(v).map((f) => f.path).sort(),
      `${file}: exactly the keys of v${v}`,
    );
  }
  const newest = json(`schemas/sir.config.v${CONFIG_VERSION}.schema.json`) as Record<string, Record<string, unknown>>;
  const root = json('sir.config.schema.json') as Record<string, Record<string, unknown>>;
  assert.deepEqual(root['properties']!['generate'], newest['properties']!['generate']);
  assert.deepEqual(root['properties']!['upstream'], newest['properties']!['upstream']);
});

test('R5: protocol 4 answers a new error kind (NoChanges), so it serves no client older than 4', async () => {
  const response = await handle({ id: 1, method: 'version' });
  assert.ok(response.ok);
  const result = response.result as { protocol: number; protocolMin: number };
  assert.ok(result.protocol >= 4 && result.protocolMin >= 4, `served ${result.protocolMin}–${result.protocol}`);
});

test('P7: a released config schema is read from its release tag, which is a released version', () => {
  const versioning = read('VERSIONING.md');
  for (const [version, tag] of Object.entries(SCHEMA_RELEASED_IN)) {
    const n = Number(version);
    assert.ok(n >= CONFIG_MIN && n <= CONFIG_VERSION, `v${n} is in the range`);
    assert.match(tag, /^v\d+\.\d+\.\d+$/, `v${n}: a release tag`);
    assert.match(versioning, new RegExp(`^\\| ${tag.slice(1).replace(/\./g, '\\.')} \\|`, 'm'), `${tag} is in the Releases table`);
    assert.ok(schemaUrl(n).includes(`/${tag}/schemas/`), `v${n}: the URL goes to ${tag}`);
  }
});

test('P7: once a release is being cut, every config schema it ships has its tag in SCHEMA_RELEASED_IN', () => {
  const changelog = read('CHANGELOG.md');
  const top = /^## (.+)$/m.exec(changelog.slice(changelog.indexOf('\n## ')))![1]!;
  if (top.startsWith('Unreleased')) return;
  const release = /^(\d+\.\d+\.\d+) — /.exec(top)![1]!;
  const order = (tag: string): number[] => tag.replace(/^v/, '').split('.').map(Number);
  const notAfter = (a: number[], b: number[]): boolean => {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
    return true;
  };
  for (let v = CONFIG_MIN; v <= CONFIG_VERSION; v++) {
    const tag = SCHEMA_RELEASED_IN[v];
    assert.ok(
      tag !== undefined,
      `CHANGELOG.md opens with ${release}, which ships config schema v${v}: add \`${v}: 'v${release}'\` ` +
        'to SCHEMA_RELEASED_IN in src/infra/config/template.ts (VERSIONING.md §5, step 1)',
    );
    assert.ok(notAfter(order(tag), order(release)), `v${v}: ${tag} is not later than ${release}`);
  }
});

test('C6: every flag of `generate` has a config key, or is exempt by name in VERSIONING.md', () => {
  const versioning = read('VERSIONING.md');
  const from = versioning.indexOf('- **C6.**');
  assert.ok(from !== -1, 'VERSIONING.md has C6');
  const rule = versioning.slice(from, versioning.indexOf('\n\n', from));
  const exempt = new Set([...rule.matchAll(/`(--[a-z-]+)`/g)].map((m) => m[1]!));
  const keyed = new Set(FIELDS.map((f) => f.flag));

  const flags = Object.values(GENERATE_SPEC)
    .flatMap((group) => Object.keys(group as Record<string, string>))
    .filter((flag) => flag.startsWith('--'));
  const missing = flags.filter((flag) => !keyed.has(flag) && !exempt.has(flag));
  assert.deepEqual(missing, [], 'a config key under generate (C2: schema + 1), or an exemption in C6 with its reason');
  const stale = [...exempt].filter((flag) => !flags.includes(flag));
  assert.deepEqual(stale, [], 'every flag C6 exempts still exists');
});

test('H4: the header fields in VERSIONING.md are the code\'s, in the same order — new ones only at the end', () => {
  const versioning = read('VERSIONING.md');
  const from = versioning.indexOf('### Patch header');
  assert.ok(from !== -1, 'VERSIONING.md has "### Patch header"');
  const to = versioning.indexOf('\n### ', from + 1);
  const rows = [...versioning.slice(from, to).matchAll(/^\| (\d+) \| `([^`]+)` \|/gm)];
  assert.deepEqual(
    rows.map((r) => [Number(r[1]), r[2]]),
    HEADER_FIELDS.map((name, i) => [i + 1, name]),
    'a field is added as the last row of the table and the last name of HEADER_FIELDS, nowhere else',
  );
});
