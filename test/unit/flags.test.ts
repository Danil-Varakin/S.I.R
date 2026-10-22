import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { SynthesisError } from '../../src/core/errors.ts';
import { printPattern } from '../../src/core/hatch-printer.ts';
import { synthesize } from '../../src/generate/synth.ts';
import { printHatchFile } from '../../src/generate/printer.ts';
import { cppAdapter } from '../../src/lang/cpp/index.ts';

// The anchoring flags README documents that nothing ran end to end before: each one must
// reach synthesis from the command line and from hatch.config.json, and change what it
// says it changes. `--debug` is here too — the trace a person reads, not the events.

const HATCH_CLI = fileURLToPath(new URL('../../src/bin/hatch.ts', import.meta.url));

function inTemp(body: (dir: string) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hatch-flags-'));
    try {
      await body(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function generate(dir: string, oldText: string, newText: string, ...flags: string[]): { status: number; stdout: string; stderr: string } {
  writeFileSync(join(dir, 'old.cc'), oldText);
  writeFileSync(join(dir, 'new.cc'), newText);
  const r = spawnSync('node', ['--experimental-strip-types', HATCH_CLI, 'generate', '--in', 'new.cc', '--in-old', 'old.cc', '--out', '-', ...flags], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: dir,
  });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

const hunks = (patch: string): number => patch.match(/^# match/gm)?.length ?? 0;

// ── --require-parents / generate.parents.required ────────────────────────────────

// Two identical `if` blocks: no anchor tells them apart, so every rung fails and the
// ladder ends on its last resort — a pattern with no enclosing block at all. That rung is
// what the flag forbids. (No input is known where that rung WINS — every place the
// parentless pattern fits, a pattern with its parent fits first — so what can be held is
// that it is not even tried.)
const TWIN_OLD = 'void f() {\n  if (cond) {\n    a();\n    work();\n  }\n  if (cond) {\n    a();\n    work();\n  }\n}\n';
const TWIN_NEW = TWIN_OLD.replace(/work\(\);(?![\s\S]*work\(\);)/, 'work(2);');
const hasParent = (pattern: string): boolean => /void f\(|if \(/.test(pattern);

test('--require-parents: the ladder never tries a pattern without an enclosing block', async () => {
  await cppAdapter.init();
  const tried = (parentsRequired: boolean): string[] => {
    const patterns: string[] = [];
    assert.throws(
      () =>
        synthesize(TWIN_OLD, TWIN_NEW, cppAdapter, {
          limits: { parentsRequired },
          trace: (e) => {
            if (e.kind === 'attempt') patterns.push(printPattern(e.pattern));
          },
        }),
      (e: unknown) => e instanceof SynthesisError && e.reason === 'ambiguous',
    );
    return patterns;
  };
  const free = tried(false);
  const required = tried(true);
  assert.ok(free.some((p) => !hasParent(p)), 'by default the last resort is a parentless pattern');
  assert.deepEqual(required.filter((p) => !hasParent(p)), [], 'with the flag no parentless pattern is tried');
  assert.deepEqual(required, free.filter(hasParent), 'and everything else is tried as before, in the same order');
});

test('--require-parents: an edit at the top level has no parent to require, and still gets its pattern', async () => {
  await cppAdapter.init();
  const old = '#include "a.h"\n#include "b.h"\n';
  const neu = '#include "a.h"\n#include "c.h"\n#include "b.h"\n';
  const patch = printHatchFile(synthesize(old, neu, cppAdapter, { limits: { parentsRequired: true } }), 'cpp');
  assert.equal(patch, printHatchFile(synthesize(old, neu, cppAdapter), 'cpp'));
});

test('CLI: --require-parents and generate.parents.required reach synthesis, with their origin', inTemp((dir) => {
  const flag = generate(dir, TWIN_OLD, TWIN_NEW, '--no-config', '--require-parents', '--print-config');
  assert.equal(flag.status, 0, flag.stderr);
  assert.match(flag.stdout, /generate\.parents\.required\s+= true\s+\[flag --require-parents\]/);

  writeFileSync(join(dir, 'hatch.config.json'), JSON.stringify({ version: 2, generate: { parents: { required: true } } }));
  const config = generate(dir, TWIN_OLD, TWIN_NEW, '--print-config');
  assert.match(config.stdout, /generate\.parents\.required\s+= true\s+\[config .*hatch\.config\.json\]/);
}));

// ── --sibling-detail / generate.siblings.detail.base ─────────────────────────────

// The same text in a comment and in code: the change is pinned by the neighbour below,
// `use(a);`, and the detail baseline decides whether its brackets are spelled out.
const COMMENT_OLD = 'void f() {\n  // int a = 1;\n  int a = 1;\n  use(a);\n}\n';
const COMMENT_NEW = 'void f() {\n  // int a = 1;\n  int a = 2;\n  use(a);\n}\n';

test('--sibling-detail: the baseline spells out the brackets of neighbour anchors', async () => {
  await cppAdapter.init();
  const at = (siblingDetailBase: number): string =>
    printHatchFile(synthesize(COMMENT_OLD, COMMENT_NEW, cppAdapter, { limits: { siblingDetailBase } }), 'cpp');
  assert.match(at(0), /^ {6}use\($/m, 'baseline 0: the neighbour is `use( ... )`');
  assert.ok(!at(0).includes('use(a);'), at(0));
  assert.match(at(1), /^ {6}use\(a\);$/m, 'baseline 1: the neighbour is spelled out');
  // the parents are untouched by it: the header of f() stays as the parent baseline has it
  assert.equal(at(1).includes('void f() {'), at(0).includes('void f() {'));
});

test('CLI: --sibling-detail and generate.siblings.detail.base reach synthesis', inTemp((dir) => {
  const plain = generate(dir, COMMENT_OLD, COMMENT_NEW, '--no-config');
  assert.equal(plain.status, 0, plain.stderr);
  assert.ok(!plain.stdout.includes('use(a);'), plain.stdout);

  const flag = generate(dir, COMMENT_OLD, COMMENT_NEW, '--no-config', '--sibling-detail', '1');
  assert.equal(flag.status, 0, flag.stderr);
  assert.match(flag.stdout, /^ {6}use\(a\);$/m);

  writeFileSync(join(dir, 'hatch.config.json'), JSON.stringify({ version: 2, generate: { siblings: { detail: { base: 1 } } } }));
  const config = generate(dir, COMMENT_OLD, COMMENT_NEW);
  assert.equal(config.status, 0, config.stderr);
  assert.equal(config.stdout, flag.stdout, 'the config key and the flag give the same patch');

  const beaten = generate(dir, COMMENT_OLD, COMMENT_NEW, '--sibling-detail', '0');
  assert.equal(beaten.stdout, plain.stdout, 'the flag beats the config');
}));

// ── --bridge-gap / generate.bridgeGap ────────────────────────────────────────────

const SPLIT_OLD = 'void f() {\n  a = 1;\n  keep();\n  b = 1;\n}\n';
const SPLIT_NEW = 'void f() {\n  a = 2;\n  keep();\n  b = 2;\n}\n';

test('CLI: --bridge-gap stitches edits split by unchanged lines into one hunk; generate.bridgeGap too', inTemp((dir) => {
  const apart = generate(dir, SPLIT_OLD, SPLIT_NEW, '--no-config');
  assert.equal(apart.status, 0, apart.stderr);
  assert.equal(hunks(apart.stdout), 2, apart.stdout);

  const stitched = generate(dir, SPLIT_OLD, SPLIT_NEW, '--no-config', '--bridge-gap', '1');
  assert.equal(stitched.status, 0, stitched.stderr);
  assert.equal(hunks(stitched.stdout), 1, stitched.stdout);
  assert.match(stitched.stdout, /^ {6}keep\(\);$/m, 'the line between rides along in the patch body');

  writeFileSync(join(dir, 'hatch.config.json'), JSON.stringify({ version: 2, generate: { bridgeGap: 1 } }));
  const config = generate(dir, SPLIT_OLD, SPLIT_NEW);
  assert.equal(config.stdout, stitched.stdout);

  const bad = generate(dir, SPLIT_OLD, SPLIT_NEW, '--no-config', '--bridge-gap', '-1');
  assert.equal(bad.status, 5, 'a negative gap is a bad value, exit 5');
}));

// ── --debug / -v ─────────────────────────────────────────────────────────────────

test('CLI: --debug traces every segment, each probe and the chosen patch to stderr — and only there', inTemp((dir) => {
  const old = 'void a() {\n  x();\n}\nvoid b() {\n  x();\n  y();\n  gone();\n}\n';
  const neu = 'void a() {\n  x();\n}\nvoid b() {\n  x();\n  z();\n  added();\n}\nvoid c() {}\n';
  const quiet = generate(dir, old, neu, '--no-config');
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.ok(!quiet.stderr.includes('segment #'), 'no trace without the flag');

  for (const flag of ['--debug', '-v']) {
    const traced = generate(dir, old, neu, '--no-config', flag);
    assert.equal(traced.status, 0, traced.stderr);
    assert.equal(traced.stdout, quiet.stdout, `${flag}: the patch is the same`);
    assert.match(traced.stderr, /── segment #1 \((replace|insert|delete)\) @ old line \d+/);
    assert.match(traced.stderr, /^ {3}[-+] /m, 'the lines of a segment are quoted');
    assert.match(traced.stderr, /try → ✓ unique/);
    assert.match(traced.stderr, /➜ CHOSEN, patch: "/);
    assert.ok(!traced.stdout.includes('segment #'), 'the trace never reaches the patch on stdout');
  }
}));

test('CLI: --debug names an ambiguous probe and how many places it fits', inTemp((dir) => {
  const traced = generate(dir, TWIN_OLD, TWIN_NEW, '--no-config', '--debug');
  assert.equal(traced.status, 8, traced.stderr);
  assert.match(traced.stderr, /✗ ambiguous \(\d+\+ matches — need more context\)/);
}));

test('CLI: --debug spells each kind of segment', inTemp((dir) => {
  const old = 'void f() {\n  a();\n  b();\n  c();\n  d();\n  e();\n}\n';
  const neu = 'void f() {\n  a2();\n  b();\n  c();\n  c2();\n  d();\n}\n';
  const traced = generate(dir, old, neu, '--no-config', '--debug');
  assert.equal(traced.status, 0, traced.stderr);
  for (const kind of ['replace', 'insert', 'delete']) assert.match(traced.stderr, new RegExp(`\\(${kind}\\) @ old line`), kind);
}));
