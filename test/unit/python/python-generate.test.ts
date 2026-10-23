import { test } from 'node:test';
import assert from 'node:assert/strict';

import { synthesize } from '../../../src/generate/synth.ts';
import { printSirFile } from '../../../src/generate/printer.ts';
import { parseSirFile } from '../../../src/core/sir-parser.ts';
import { applyAll } from '../../../src/core/apply.ts';
import { SynthesisError } from '../../../src/core/errors.ts';
import { pythonAdapter } from '../../../src/lang/python/index.ts';

async function roundtrip(oldStr: string, newStr: string): Promise<string> {
  await pythonAdapter.init();
  const md = printSirFile(synthesize(oldStr, newStr, pythonAdapter), 'python');
  const { source } = applyAll(oldStr, parseSirFile(md), pythonAdapter);
  assert.equal(source, newStr);
  return md;
}

test('round-trip: replacing a line inside a function body', async () => {
  const md = await roundtrip(
    'def fetch(url):\n    timeout = 30\n    return get(url, timeout)\n',
    'def fetch(url):\n    timeout = 60\n    return get(url, timeout)\n',
  );
  assert.match(md, /^# match python$/m);
});

test('round-trip: inserting a line into a body with an indentation', async () => {
  await roundtrip(
    'def f(x):\n    if x:\n        a()\n    return x\n',
    'def f(x):\n    if x:\n        a()\n        b()\n    return x\n',
  );
});

test('round-trip: an identical edit in one of TWO twin functions', async () => {
  await roundtrip(
    'def first(x):\n    log("a")\n    return x\n\ndef second(x):\n    log("a")\n    return x\n',
    'def first(x):\n    log("a")\n    return x\n\ndef second(x):\n    log("z")\n    return x\n',
  );
});

test('round-trip: deleting a line', async () => {
  await roundtrip(
    'def f():\n    a()\n    b()\n    c()\n',
    'def f():\n    a()\n    c()\n',
  );
});

test('round-trip: a change in the header of a function (the signature itself)', async () => {
  await roundtrip(
    'def f(a):\n    return a\n',
    'def f(a, b=None):\n    return a\n',
  );
});

test('round-trip: an edit at the beginning of a file and at the end of a file', async () => {
  await roundtrip('import os\n\ndef f():\n    return 1\n', 'import sys\n\ndef f():\n    return 1\n');
  await roundtrip('def f():\n    return 1\n', 'def f():\n    return 1\n\ndef g():\n    return 2\n');
});

test('round-trip: a nested block three levels deep', async () => {
  await roundtrip(
    'class C:\n    def m(self):\n        for i in r:\n            work(i)\n        return 0\n',
    'class C:\n    def m(self):\n        for i in r:\n            work(i, fast=True)\n        return 0\n',
  );
});

test('twin lines split by blank lines: an anchor is verified as it reads back — no patch that does not apply', async () => {
  await pythonAdapter.init();
  const oldStr = 'def a():\n    tick()\n\n    tick()\n\n    tick()\n';
  const newStr = 'def a():\n    tick()\n\n    tick()\n\n    x = 1\n    tick()\n';
  assert.throws(
    () => synthesize(oldStr, newStr, pythonAdapter),
    (e: unknown) => e instanceof SynthesisError && e.reason === 'ambiguous',
  );
});

test('a blank line inside an anchor never reaches the .sirp: what is printed is what is verified', async () => {
  await pythonAdapter.init();
  const oldStr = 'def a():\n    one()\n\n    two()\n    tail()\n\ndef b():\n    one()\n    two()\n    tail()\n';
  const newStr = oldStr.replace('    two()\n    tail()\n\ndef b', '    two()\n    added()\n    tail()\n\ndef b');
  const md = await roundtrip(oldStr, newStr);
  for (const hunk of parseSirFile(md).hunks) {
    for (const step of hunk.match.steps) {
      if (step.anchor.target === 'literal') assert.ok(!/\n\s*\n/.test(step.anchor.literal.raw), md);
    }
  }
});
