import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSirFile } from '../../src/core/sir-parser.ts';
import { cppAdapter } from '../../src/lang/cpp/index.ts';
import { pythonAdapter } from '../../src/lang/python/index.ts';
import { alreadyThere, alreadyThereError, applyAll, copiesAt } from '../../src/core/apply.ts';
import { MatchError } from '../../src/core/errors.ts';
import { patchOf } from '../matrix.ts';
import { sirMd } from '../helpers.ts';

const insertAt = (text: string, marker: string, inserted: string) => {
  const at = text.indexOf(marker);
  assert.ok(at >= 0, `no ${marker} in the text`);
  return { file: text.replace(marker, ''), edit: { start: at, end: at, text: inserted } };
};

test('copiesAt: the inserted line stands right after the place — one copy; twice — two', () => {
  const one = insertAt('  b(x);|\n  NEW(x);\n  c(x);\n', '|', '\n  NEW(x);');
  assert.equal(copiesAt(one.file, one.edit), 1);
  const two = insertAt('  b(x);|\n  NEW(x);\n  NEW(x);\n  c(x);\n', '|', '\n  NEW(x);');
  assert.equal(copiesAt(two.file, two.edit), 2);
});

test('copiesAt: the inserted line stands right before the place (an insertion at the end of a block)', () => {
  const { file, edit } = insertAt('void f() {\n  a();\n  work();\n|}\n', '|', '  work();\n');
  assert.equal(copiesAt(file, edit), 1);
});

test('copiesAt: nothing like the text at the place — 0', () => {
  const { file, edit } = insertAt('  b(x);|\n  c(x);\n', '|', '\n  NEW(x);');
  assert.equal(copiesAt(file, edit), 0);
});

test('copiesAt: a replacement, a deletion, an insertion of blanks — 0', () => {
  const text = '  b(x);\n  NEW(x);\n';
  assert.equal(copiesAt(text, { start: 2, end: 7, text: 'NEW(x);' }), 0);
  assert.equal(copiesAt(text, { start: 2, end: 7, text: '' }), 0);
  assert.equal(copiesAt(text, { start: 7, end: 7, text: '\n\n  ' }), 0);
});

test('copiesAt: a line that goes on is no copy — `x` in `x + 1`, `a` in `a(); c();`', () => {
  const longer = insertAt('  y = 1|\n  x + 1\n', '|', '\n  x');
  assert.equal(copiesAt(longer.file, longer.edit), 0);
  const sameLine = insertAt('  b();|\n  a(); c();\n', '|', '\n  a();');
  assert.equal(copiesAt(sameLine.file, sameLine.edit), 0);
});

test('copiesAt: words are not split nor joined — `ab;` is no copy of `a b;`, nor the other way', () => {
  const joined = insertAt('  b();|\n  ab;\n', '|', '\n  a b;');
  assert.equal(copiesAt(joined.file, joined.edit), 0);
  const split = insertAt('  b();|\n  a b;\n', '|', '\n  ab;');
  assert.equal(copiesAt(split.file, split.edit), 0);
});

test('copiesAt: blanks of another length, tabs, CRLF — still a copy', () => {
  const indent = insertAt('\tb(x);|\r\n\t\tNEW( x );\r\n', '|', '\n  NEW( x );');
  assert.equal(copiesAt(indent.file, indent.edit), 1);
  const spaced = insertAt('  b(x);|\n  NEW(x) ;\n', '|', '\n  NEW(x);');
  assert.equal(copiesAt(spaced.file, spaced.edit), 1, 'a blank between two non-word characters is no difference');
});

test('copiesAt: an insertion at the end of a line — a copy there counts; text after it on the line does not', () => {
  const end = insertAt('  if (a)| GUARD\n    run();\n', '|', ' GUARD');
  assert.equal(copiesAt(end.file, end.edit), 1);
  const brace = insertAt('  if (a)| {\n    run();\n', '|', ' GUARD');
  assert.equal(copiesAt(brace.file, brace.edit), 0);
  const goesOn = insertAt('  if (a)| GUARD {\n    run();\n', '|', ' GUARD');
  assert.equal(copiesAt(goesOn.file, goesOn.edit), 0, 'the copy does not end its line');
});

test('applyAll: copies per hunk — 0 where nothing like the text stands, the count where it does', async () => {
  await cppAdapter.init();
  const file = parseSirFile(sirMd([{ match: '...\n  b(x);\n>>>\n...', patch: '\n  NEW(x);' }]));
  assert.deepEqual(applyAll('void f(int x) {\n  b(x);\n  c(x);\n}\n', file, cppAdapter).copies, [0]);
  assert.deepEqual(applyAll('void f(int x) {\n  b(x);\n  NEW(x);\n  c(x);\n}\n', file, cppAdapter).copies, [1]);
});

const F = (body: string): string => `void f(int x) {\n  a(x);\n  b(x);\n${body}  c(x);\n}\n`;
const G = '\nvoid g() {\n  d();\n}\n';

test('verdict: upstream took the change — taken, and the refusal says already-there', async () => {
  await cppAdapter.init();
  const patch = patchOf(F(''), F('  NEW(x);\n'), cppAdapter);
  const upstream = F('  NEW(x);\n') + G;
  const result = applyAll(upstream, patch, cppAdapter);
  const verdict = alreadyThere(result.copies, patch, cppAdapter, F(''));
  assert.deepEqual(verdict, { kind: 'taken', hunks: [0] });
  const e = alreadyThereError((verdict as { hunks: number[] }).hunks, patch.hunks.length, result.edits[0]!.edit.start);
  assert.ok(e instanceof MatchError);
  assert.equal(e.exitCode, 3);
  assert.equal(e.detail().reason, 'already-there');
  assert.match(e.message, /^hunk 1 of 1: already there/);
});

test('verdict: a second copy the patch means — its base held one too: clear', async () => {
  await cppAdapter.init();
  const patch = patchOf(F('  NEW(x);\n'), F('  NEW(x);\n  NEW(x);\n'), cppAdapter);
  const upstream = F('  NEW(x);\n') + G;
  const result = applyAll(upstream, patch, cppAdapter);
  assert.deepEqual(alreadyThere(result.copies, patch, cppAdapter, F('  NEW(x);\n')), { kind: 'clear' });
  assert.equal(result.source, F('  NEW(x);\n  NEW(x);\n') + G);
});

test('verdict: a hand-written `b(x); >>>` that means a second copy — clear on the base it was written on', async () => {
  await cppAdapter.init();
  const patch = parseSirFile(sirMd([{ match: '...\n  b(x);\n>>>\n...', patch: '\n  NEW(x);' }]));
  const base = F('  NEW(x);\n');
  const result = applyAll(base, patch, cppAdapter);
  assert.deepEqual(result.copies, [1]);
  assert.deepEqual(alreadyThere(result.copies, patch, cppAdapter, base), { kind: 'clear' });
});

test('verdict: the same patch where upstream took that second copy too — taken', async () => {
  await cppAdapter.init();
  const patch = parseSirFile(sirMd([{ match: '...\n  b(x);\n>>>\n...', patch: '\n  NEW(x);' }]));
  const result = applyAll(F('  NEW(x);\n  NEW(x);\n'), patch, cppAdapter);
  assert.deepEqual(alreadyThere(result.copies, patch, cppAdapter, F('  NEW(x);\n')), { kind: 'taken', hunks: [0] });
});

test('verdict: a patch laid on its own result — taken', async () => {
  await cppAdapter.init();
  const patch = parseSirFile(sirMd([{ match: '...\n  b(x);\n>>>\n...', patch: '\n  NEW(x);' }]));
  const once = applyAll(F(''), patch, cppAdapter).source;
  const again = applyAll(once, patch, cppAdapter);
  assert.deepEqual(alreadyThere(again.copies, patch, cppAdapter, F('')), { kind: 'taken', hunks: [0] });
});

test('verdict: copies and no base to ask — unwitnessed; nothing found — clear without asking', async () => {
  await cppAdapter.init();
  const patch = patchOf(F(''), F('  NEW(x);\n'), cppAdapter);
  const taken = applyAll(F('  NEW(x);\n'), patch, cppAdapter);
  assert.deepEqual(alreadyThere(taken.copies, patch, cppAdapter, undefined), { kind: 'unwitnessed', hunks: [0] });
  const fresh = applyAll(F(''), patch, cppAdapter);
  assert.deepEqual(alreadyThere(fresh.copies, patch, cppAdapter, undefined), { kind: 'clear' });
});

test('verdict: the patch does not lay on the base it names — unwitnessed, not a refusal', async () => {
  await cppAdapter.init();
  const patch = patchOf(F(''), F('  NEW(x);\n'), cppAdapter);
  const result = applyAll(F('  NEW(x);\n'), patch, cppAdapter);
  assert.deepEqual(alreadyThere(result.copies, patch, cppAdapter, 'int unrelated;\n'), { kind: 'unwitnessed', hunks: [0] });
});

test('verdict: of two hunks upstream took one — that one is named', async () => {
  await cppAdapter.init();
  const old = 'void f(int x) {\n  a(x);\n  c(x);\n}\n\nvoid h(int y) {\n  p(y);\n  q(y);\n}\n';
  const mine = 'void f(int x) {\n  a(x);\n  ONE(x);\n  c(x);\n}\n\nvoid h(int y) {\n  p(y);\n  TWO(y);\n  q(y);\n}\n';
  const patch = patchOf(old, mine, cppAdapter);
  assert.equal(patch.hunks.length, 2);
  const upstream = 'void f(int x) {\n  a(x);\n  c(x);\n}\n\nvoid h(int y) {\n  p(y);\n  TWO(y);\n  q(y);\n}\n';
  const result = applyAll(upstream, patch, cppAdapter);
  const verdict = alreadyThere(result.copies, patch, cppAdapter, old);
  assert.deepEqual(verdict, { kind: 'taken', hunks: [1] });
  assert.match(alreadyThereError((verdict as { hunks: number[] }).hunks, 2, result.edits[1]!.edit.start).message, /^hunk 2 of 2: already there/);
});

test('verdict: Python, where blanks are structure — upstream took an import', async () => {
  await pythonAdapter.init();
  const old = 'import os\nimport plistlib\nimport sys\n\n\ndef main():\n    run()\n';
  const mine = 'import os\nimport plistlib\nimport subprocess\nimport sys\n\n\ndef main():\n    run()\n';
  const patch = patchOf(old, mine, pythonAdapter);
  const result = applyAll(`${mine}\n\ndef other():\n    pass\n`, patch, pythonAdapter);
  assert.deepEqual(alreadyThere(result.copies, patch, pythonAdapter, old), { kind: 'taken', hunks: [0] });
});

test('MatchError: `reason` is in the detail only when set', () => {
  assert.equal('reason' in new MatchError('no match', 0, 0).detail(), false);
  assert.equal(new MatchError('x', 0, 0, { reason: 'already-there' }).detail().reason, 'already-there');
});
