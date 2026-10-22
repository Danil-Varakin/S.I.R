import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as api from '../../src/index.ts';
import type {
  SirFile,
  Hunk,
  MatchPattern,
  LanguageAdapter,
  ApplyResult,
  AppliedEdit,
  SynthOptions,
  SynthEvent,
  Tracer,
  GenerateRequest,
  GenerateOutcome,
  HunkLink,
  LinkFailure,
  LinkStatus,
  ResolveResult,
  Span,
  SynthesisFailure,
} from '../../src/index.ts';

// The public API is what README "API" names, and by P3 an export of src/index.ts removed
// or changed is a breaking change. These tests hold the two together: a name added to one
// and not the other, or dropped from both, fails here instead of in somebody's build.
// The type imports above are the same check for types: the typecheck fails on a type gone.
export type PublicTypes = [
  SirFile, Hunk, MatchPattern, LanguageAdapter, ApplyResult, AppliedEdit, SynthOptions, SynthEvent, Tracer,
  GenerateRequest, GenerateOutcome, HunkLink, LinkFailure, LinkStatus, ResolveResult, Span, SynthesisFailure,
];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (name: string): string => readFileSync(join(ROOT, name), 'utf8');

/** The text of README's `### <title>` section, up to the next heading. */
function section(readme: string, title: string): string {
  const start = readme.indexOf(`\n### ${title}\n`);
  assert.ok(start >= 0, `README has no "### ${title}"`);
  const rest = readme.slice(start + title.length + 6);
  return rest.slice(0, rest.search(/\n#{2,3} /));
}

const README = read('README.md');

test('API: the values src/index.ts exports are exactly the functions and errors README names', () => {
  const functions = [...section(README, 'Functions').matchAll(/^\| `(\w+)/gm)].map((m) => m[1]!);
  const errors = [...section(README, 'Errors').matchAll(/`(\w+Error|NoChanges)`/g)].map((m) => m[1]!);
  assert.ok(functions.length >= 10 && errors.length >= 10, 'README sections read');
  assert.deepEqual(Object.keys(api).sort(), [...new Set([...functions, ...errors])].sort());
});

test('API: the types src/index.ts exports are exactly the types README names', () => {
  const named = [...section(README, 'Types').matchAll(/`(\w+)`/g)].map((m) => m[1]!).sort();
  const exported = [...read('src/index.ts').matchAll(/^export type \{([^}]+)\}/gm)]
    .flatMap((m) => m[1]!.split(','))
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .sort();
  assert.deepEqual(exported, named);
});

test('API: every error carries the exit code README gives it, and is a SirError', () => {
  const errors = section(README, 'Errors');
  const text = errors.slice(errors.indexOf(':') + 1); // past "carries an `exitCode` matching the CLI:"
  // "`A` (2), `B` (3), and `C`, `D` (1)": a code belongs to every name since the last one
  const codes = new Map<string, number>();
  for (const chunk of text.matchAll(/([^()]*)\((\d)\)/g)) {
    for (const m of chunk[1]!.matchAll(/`(\w+)`/g)) codes.set(m[1]!, Number(chunk[2]));
  }
  assert.equal(codes.size, 10, `README names ten errors with their codes: ${[...codes.keys()].join(', ')}`);

  const make = (Ctor: unknown): InstanceType<typeof api.SirError> =>
    Reflect.construct(Ctor as new (...a: unknown[]) => object, ['m', 'x', 'y']) as InstanceType<typeof api.SirError>;
  for (const [name, code] of codes) {
    const Ctor = (api as Record<string, unknown>)[name];
    assert.equal(typeof Ctor, 'function', `${name} is exported`);
    const e = make(Ctor);
    assert.ok(e instanceof api.SirError, `${name} is a SirError`);
    assert.ok(e instanceof Error, `${name} is an Error`);
    assert.equal(e.exitCode, code, `${name} exits with ${code}`);
  }
});

test('API: the README example runs as written — synthesize → print → parse → applyAll gives the new text', async () => {
  const { applyAll, synthesize, parseSirFile, printSirFile, adapterForLanguage } = api;
  const adapter = adapterForLanguage('cpp');
  await adapter.init();

  const oldCode = 'void f() {\n  a();\n}\n';
  const newCode = 'void f() {\n  a();\n  b();\n}\n';
  const md = printSirFile(synthesize(oldCode, newCode, adapter), 'cpp');
  const { source, edits } = applyAll(oldCode, parseSirFile(md), adapter);

  assert.equal(source, newCode);
  assert.equal(edits.length, 1);
  assert.match(md, /^# match cpp$/m);
});

test('API: generatePatch, resolveHunks, trailingSpaceWarnings, adapterForFile, supportedLanguages — each as README says', async () => {
  const outcome = await api.generatePatch({
    oldText: 'int f() {\n  return 1;\n}\n',
    newText: 'int f() {\n  return 2;\n}\n',
    language: 'cpp',
  });
  assert.match(outcome.md, /^Sir: \d+$/m, 'the .sirp with its header');

  await assert.rejects(
    api.generatePatch({ oldText: 'int a;\n', newText: 'int a;\n', language: 'cpp' }),
    (e: unknown) => e instanceof api.NoChanges && e.exitCode === 7,
  );

  const adapter = api.adapterForFile('/x/y/z.cc');
  await adapter.init();
  assert.equal(adapter.name, 'cpp');
  const file = api.parseSirFile(outcome.md);
  const resolved = api.resolveHunks('int f() {\n  return 1;\n}\n', file, adapter);
  assert.equal(resolved.links.length, 1);
  assert.equal(resolved.links[0]!.status, 'ok');
  const bad = api.resolveHunks('int g() {}\n', file, adapter);
  assert.notEqual(bad.links[0]!.status, 'ok', 'a failure per hunk, not a throw');

  const hunks = api.synthesize('a();\n', 'a();\nb();  \n', adapter, { exact: true });
  assert.ok(api.trailingSpaceWarnings(hunks).length > 0, 'a patch line ending in whitespace is warned about');

  assert.ok(api.supportedLanguages.includes('cpp') && api.supportedLanguages.includes('python'));
});

test('API: package.json exports only the entry points README names — internals are closed off', () => {
  const pkg = JSON.parse(read('package.json')) as { name: string; exports: Record<string, unknown> };
  assert.deepEqual(Object.keys(pkg.exports).sort(), ['.', './protocol', './service']);

  // the self-reference resolves through `exports` exactly as a dependent's import would
  if (!existsSync(join(ROOT, 'dist', 'index.js'))) return;
  const require = createRequire(join(ROOT, 'package.json'));
  assert.equal(require.resolve(pkg.name), join(ROOT, 'dist', 'index.js'));
  assert.throws(() => require.resolve(`${pkg.name}/dist/core/matcher.js`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});
