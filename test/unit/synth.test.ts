import { test } from 'node:test';
import assert from 'node:assert/strict';

import { anchorFailure, synthesize, synthesizeAsync } from '../../src/generate/synth.ts';
import { AmbiguityError, MatchError } from '../../src/core/errors.ts';
import type { SynthEvent } from '../../src/generate/synth.ts';
import { applyAll } from '../../src/core/apply.ts';
import { cppAdapter } from '../../src/lang/cpp/index.ts';
import { printPattern } from '../../src/core/hatch-printer.ts';
import type { HatchFile } from '../../src/core/ast.ts';

function hatchFile(hunks: ReturnType<typeof synthesize>): HatchFile {
  return { hunks: hunks.map((h) => ({ ...h, mdSpan: [0, 0] as [number, number] })) };
}

async function roundtrip(oldStr: string, newStr: string, bridgeGap = 0): Promise<void> {
  await cppAdapter.init();
  const hunks = synthesize(oldStr, newStr, cppAdapter, { bridgeGap, exact: true });
  const { source } = applyAll(oldStr, hatchFile(hunks), cppAdapter);
  assert.equal(source, newStr);
}

test('replacing one line inside a function body', async () => {
  const oldStr = 'void f() {\n  int a = 1;\n  return a;\n}\n';
  const newStr = 'void f() {\n  int a = 2;\n  return a;\n}\n';
  await roundtrip(oldStr, newStr);
});

test('inserting a line into a function body', async () => {
  const oldStr = 'void f() {\n  int a = 1;\n  return a;\n}\n';
  const newStr = 'void f() {\n  int a = 1;\n  a += 5;\n  return a;\n}\n';
  await roundtrip(oldStr, newStr);
});

test('deleting a line', async () => {
  const oldStr = 'void f() {\n  int a = 1;\n  int b = 2;\n  return a;\n}\n';
  const newStr = 'void f() {\n  int a = 1;\n  return a;\n}\n';
  await roundtrip(oldStr, newStr);
});

test('a replacement that CHANGES the indent of the first line', async () => {
  const oldStr = 'void f() {\n  g();\n}\n';
  const newStr = 'void f() {\n  if (x) {\n      g();\n  }\n}\n';
  await roundtrip(oldStr, newStr);
});

test('replacing a block across several lines', async () => {
  const oldStr = 'void f() {\n  a();\n  b();\n  c();\n}\n';
  const newStr = 'void f() {\n  x();\n  y();\n}\n';
  await roundtrip(oldStr, newStr);
});

test('two separate edits in one file, applied in order', async () => {
  const oldStr = 'int a = 1;\nint b = 2;\nint c = 3;\nint d = 4;\nint e = 5;\n';
  const newStr = 'int a = 10;\nint b = 2;\nint c = 3;\nint d = 4;\nint e = 50;\n';
  await roundtrip(oldStr, newStr);
});

test('two CLOSE edits in one block, told apart by context', async () => {
  const oldStr = 'void f() {\n  x = 1;\n  y = 2;\n  z = 3;\n}\n';
  const newStr = 'void f() {\n  x = 11;\n  y = 2;\n  z = 33;\n}\n';
  await roundtrip(oldStr, newStr);
});

test('an edit at the start of the file (BOF)', async () => {
  const oldStr = '#include <a>\nvoid f() {}\n';
  const newStr = '#include <b>\nvoid f() {}\n';
  await roundtrip(oldStr, newStr);
});

test('anchoring is STRUCTURAL: non-unique code is pinned by a PARENT, not a neighbour', async () => {
  await cppAdapter.init();
  const oldStr = 'void a() {\n  int x = 1;\n}\nvoid b() {\n  int x = 1;\n}\n';
  const newStr = 'void a() {\n  int x = 1;\n}\nvoid b() {\n  int x = 99;\n}\n';
  const hunks = synthesize(oldStr, newStr, cppAdapter);
  assert.equal(applyAll(oldStr, hatchFile(hunks), cppAdapter).source, newStr);
  assert.match(printPattern(hunks[0]!.match), /void b\(\)/);
});

test('hunks interfere: synthesis builds against the text earlier hunks already wrote', async () => {
  await cppAdapter.init();
  const oldStr = 'int g() { return a; }\nvoid f(int a) {\n  helper();\n  return a;\n}\n';
  const newStr = 'int g() { return a; }\nvoid f(int b) {\n  helper();\n  return b;\n}\n';
  const hunks = synthesize(oldStr, newStr, cppAdapter);
  assert.equal(hunks.length, 2);
  assert.match(printPattern(hunks[1]!.match), /void f\(/);
  assert.equal(applyAll(oldStr, hatchFile(hunks), cppAdapter).source, newStr);
});

test('a replacement changing the first indent: dedent and deepen, both round-tripping', async () => {
  await roundtrip('void f() {\n      target();\n  keep();\n}\n', 'void f() {\n  target2();\n  keep();\n}\n');
  await roundtrip('void f() {\n  x();\n}\n', 'void f() {\n      x2();\n}\n');
});

test('an insertion at the END of a block anchors on "}", not on the last line', async () => {
  await cppAdapter.init();
  const oldStr = 'void f() {\n  a();\n}\nvoid g() {\n  a();\n}\n';
  const newStr = 'void f() {\n  a();\n}\nvoid g() {\n  a();\n  NEW();\n}\n';
  const hunks = synthesize(oldStr, newStr, cppAdapter);
  const p = printPattern(hunks[0]!.match);
  assert.match(p, /void g\(\)/);
  assert.doesNotMatch(p, /a\(\);\s*\n>>>/);
  const drifted = 'void f() {\n  a();\n}\nvoid g() {\n  a(x);\n}\n';
  const { source } = applyAll(drifted, hatchFile(hunks), cppAdapter);
  assert.ok(source.includes('NEW();') && source.includes('a(x)'), source);
});

test('special cases: a BOF insertion, an EOF append, and replacing the whole file', async () => {
  await cppAdapter.init();
  const bof = synthesize('int b = 2;\n', 'int a = 1;\nint b = 2;\n', cppAdapter);
  assert.match(printPattern(bof[0]!.match), /^>>>/);
  await roundtrip('int b = 2;\n', 'int a = 1;\nint b = 2;\n');

  const eofp = synthesize('int a = 1;\n', 'int a = 1;\nint z = 9;\n', cppAdapter);
  assert.match(printPattern(eofp[0]!.match), />>>$/);
  await roundtrip('int a = 1;\n', 'int a = 1;\nint z = 9;\n');

  const whole = synthesize('int old = 1;\n', 'int a = 2;\nint b = 3;\n', cppAdapter);
  // the whole file spells what it replaces: `>>> ... <<<` would fit every file and write
  // over whatever upstream added to it (07-findings Н5)
  assert.equal(printPattern(whole[0]!.match).replace(/\s/g, ''), '...>>>intold=1;<<<...');
  await roundtrip('int old = 1;\n', 'int a = 2;\nint b = 3;\n');
});

test('an insertion at the end of a block is `>>> }` with no <<<, a pure point', async () => {
  await cppAdapter.init();
  const hunks = synthesize('void f() {\n  a();\n}\n', 'void f() {\n  a();\n  b();\n}\n', cppAdapter);
  assert.doesNotMatch(printPattern(hunks[0]!.match), /<<</);
  await roundtrip('void f() {\n  a();\n}\n', 'void f() {\n  a();\n  b();\n}\n');
});

test('verification: synthesize guarantees applyAll == new by construction', async () => {
  await cppAdapter.init();
  const oldStr = 'namespace n {\nvoid f() {\n  int x = 1;\n  g(x);\n}\nvoid h() {\n  int y = 1;\n}\n}\n';
  const newStr = 'namespace n {\nvoid f() {\n  int x = 2;\n  g(x);\n  extra();\n}\nvoid h() {\n  int y = 1;\n}\n}\n';
  const hunks = synthesize(oldStr, newStr, cppAdapter);
  assert.equal(applyAll(oldStr, hatchFile(hunks), cppAdapter).source, newStr);
});

test('deleting a block under a BLANK line: the anchor moves to a non-blank, not to BOF', async () => {
  await cppAdapter.init();
  const oldStr = 'void Test() {\n  int a = 1;\n\n  for (int i = 0; i < 3; i++) {\n    doit(i);\n  }\n}\n';
  const newStr = 'void Test() {\n  int a = 1;\n\n}\n';
  const hunks = synthesize(oldStr, newStr, cppAdapter);
  assert.doesNotMatch(printPattern(hunks[0]!.match), /^>>>/);
  assert.equal(applyAll(oldStr, hatchFile(hunks), cppAdapter).source, newStr);
});

test('deleting a line above a BLANK one: the cut does not run to EOF', async () => {
  await cppAdapter.init();
  const oldStr = 'namespace n {\nvoid f() {\n  keep1();\n  DELME();\n\n  keep2();\n}\n}\n';
  const newStr = 'namespace n {\nvoid f() {\n  keep1();\n\n  keep2();\n}\n}\n';
  const hunks = synthesize(oldStr, newStr, cppAdapter);
  assert.doesNotMatch(hunks[0]!.patch, /namespace|keep2/);
  assert.equal(applyAll(oldStr, hatchFile(hunks), cppAdapter).source, newStr);
});

test('the tracer (--debug) shows the segment, an ambiguous probe and the chosen anchor', async () => {
  await cppAdapter.init();
  const oldStr = 'void f() {\n  int x = 1;\n  int y = 2;\n  int x = 1;\n}\n';
  const newStr = 'void f() {\n  int x = 99;\n  int y = 2;\n  int x = 1;\n}\n';
  const events: SynthEvent[] = [];
  synthesize(oldStr, newStr, cppAdapter, { trace: (e) => events.push(e) });
  assert.ok(events.some((e) => e.kind === 'segment'));
  const attempts = events.filter((e) => e.kind === 'attempt');
  assert.ok(attempts.some((e) => e.result === 'ambiguous'), 'there has to be an ambiguous probe');
  assert.ok(attempts.some((e) => e.result === 'unique'), 'and a unique one at the end');
  assert.ok(events.some((e) => e.kind === 'hunk'));
});

test('8b: an Allman-style header ({ on its own line) anchors on the signature', async () => {
  await cppAdapter.init();
  const oldStr = 'void a()\n{\n  int x = 1;\n}\nvoid b()\n{\n  int x = 1;\n}\n';
  const newStr = 'void a()\n{\n  int x = 1;\n}\nvoid b()\n{\n  int x = 99;\n}\n';
  const hunks = synthesize(oldStr, newStr, cppAdapter);
  const p = printPattern(hunks[0]!.match);
  assert.match(p, /void b\(/);
  assert.doesNotMatch(p, /^\s*\.\.\.\s*\{\s*\.\.\./m);
  assert.equal(applyAll(oldStr, hatchFile(hunks), cppAdapter).source, newStr);
});

test('9: brackets generalise — a signature becomes `void render( ... )` and survives drift', async () => {
  await cppAdapter.init();
  const oldStr =
    'void handle(int code, bool flag) {\n  process();\n}\nvoid render(int code, bool flag) {\n  process();\n}\n';
  const newStr =
    'void handle(int code, bool flag) {\n  process();\n}\nvoid render(int code, bool flag) {\n  process(2);\n}\n';
  const hunks = synthesize(oldStr, newStr, cppAdapter);
  const p = printPattern(hunks[0]!.match);
  assert.match(p, /void render\(\s*\.\.\.\s*\)/);
  assert.equal(applyAll(oldStr, hatchFile(hunks), cppAdapter).source, newStr);
  const drifted =
    'void handle(int code, bool flag) {\n  process();\n}\nvoid render(int code) {\n  process();\n}\n';
  const { source } = applyAll(drifted, hatchFile(hunks), cppAdapter);
  assert.ok(source.includes('process(2);') && source.includes('void render(int code) {'), source);
});

test('8a: context taken from both sides — the discriminator lies BELOW', async () => {
  await cppAdapter.init();
  const oldStr = 'void f() {\n  a();\n  val = 1;\n  b();\n  a();\n  val = 1;\n  c();\n}\n';
  const newStr = 'void f() {\n  a();\n  val = 9;\n  b();\n  a();\n  val = 1;\n  c();\n}\n';
  const hunks = synthesize(oldStr, newStr, cppAdapter);
  const p = printPattern(hunks[0]!.match);
  assert.match(p, /b\(\);/);
  assert.equal(applyAll(oldStr, hatchFile(hunks), cppAdapter).source, newStr);
});

test('robustness: the edit still fits when its neighbours DRIFT, as they do upstream', async () => {
  await cppAdapter.init();
  const oldStr = 'void a() {\n  int x = 1;\n}\nvoid b() {\n  int x = 1;\n}\n';
  const newStr = 'void a() {\n  int x = 1;\n}\nvoid b() {\n  int x = 99;\n}\n';
  const hunks = synthesize(oldStr, newStr, cppAdapter);
  const drifted = 'void a() {\n  int x = 1;\n}\nvoid b() {\n  int x = 1;\n  LOG(hi);\n}\n';
  const { source } = applyAll(drifted, hatchFile(hunks), cppAdapter);
  assert.ok(source.includes('int x = 99;'), source);
  assert.ok(source.includes('LOG(hi);'), 'the neighbour survived');
});

// ── edges of file and block: bounds come from POSITION, not from a line number ─

test('the edge of a file: blank lines above and below do not disturb anchoring', async () => {
  await roundtrip('\nvoid f() {}\n', '\nint g = 0;\nvoid f() {}\n');
  await roundtrip('void f() {}\n\n', 'void f() {}\nint g = 0;\n\n');
  await roundtrip('void f() {}\n\n', 'void f() {}\n\nint g = 0;\n');
  await roundtrip('int old = 1;\n\n\n', 'int a = 2;\n\n\n');
});

test('deleting the FIRST line holds on to CONTENT, not to the start of the file', async () => {
  await cppAdapter.init();
  const oldStr = 'int a = 1;\nint b = 2;\n';
  const newStr = 'int b = 2;\n';
  const hunks = synthesize(oldStr, newStr, cppAdapter);
  assert.match(printPattern(hunks[0]!.match), /^\.\.\./);
  assert.equal(applyAll(oldStr, hatchFile(hunks), cppAdapter).source, newStr);
  const drifted = '#include <a>\nint a = 1;\nint b = 2;\n';
  assert.equal(applyAll(drifted, hatchFile(hunks), cppAdapter).source, '#include <a>\nint b = 2;\n');
});

test('deleting the LAST line holds on to CONTENT, not to EOF', async () => {
  await cppAdapter.init();
  const oldStr = 'int a = 1;\nint b = 2;\n';
  const newStr = 'int a = 1;\n';
  const hunks = synthesize(oldStr, newStr, cppAdapter);
  assert.equal(applyAll(oldStr, hatchFile(hunks), cppAdapter).source, newStr);
  const drifted = 'int a = 1;\nint b = 2;\nint c = 3;\n';
  assert.equal(applyAll(drifted, hatchFile(hunks), cppAdapter).source, 'int a = 1;\nint c = 3;\n');
});

test('deleting a BLANK line: the cut runs through the gap, with no empty literal', async () => {
  await roundtrip('void f() {\n  a();\n\n  b();\n}\n', 'void f() {\n  a();\n  b();\n}\n');
});

test('a file with no trailing newline does not grow one', async () => {
  await roundtrip('int a = 1;\nint b = 2;', 'int a = 1;\nint c = 3;');
  await roundtrip('int a = 1;\n', 'int a = 1;\nint b = 2;');
});

// ── the closer of a parent: an unclosed `{` orders the search without locking it ─

test('the parent is CLOSED in the pattern, or the anchor catches a sibling block too', async () => {
  await cppAdapter.init();
  const oldStr =
    'void f() {\n  for (auto& b : first(a)) {\n    use(b);\n  }\n  for (auto& b : second(c)) {\n    use(b);\n  }\n}\n';
  const newStr = oldStr.replace('    use(b);\n  }\n  for (auto& b : second', '    use2(b);\n  }\n  for (auto& b : second');
  const hunks = synthesize(oldStr, newStr, cppAdapter);
  const p = printPattern(hunks[0]!.match);
  assert.match(p, /first\(/);
  assert.match(p, /<<<[\s\S]*\}/);
  assert.equal(applyAll(oldStr, hatchFile(hunks), cppAdapter).source, newStr);
});

test('inserting as the FIRST line of a block anchors on the parent header, no double `{`', async () => {
  await cppAdapter.init();
  const oldStr = 'void a()\n{\n  b();\n}\nvoid c()\n{\n  b();\n}\n';
  const newStr = 'void a()\n{\n  b();\n}\nvoid c()\n{\n  z();\n  b();\n}\n';
  const hunks = synthesize(oldStr, newStr, cppAdapter);
  const p = printPattern(hunks[0]!.match);
  assert.match(p, /void c\(\)/);
  assert.doesNotMatch(p, /\{\n\.\.\.\n\{/);
  assert.equal(applyAll(oldStr, hatchFile(hunks), cppAdapter).source, newStr);
});

test('when an edit eats the parent `}` that block serves neither as anchor nor as closer', async () => {
  await roundtrip(
    'namespace n {\nclass W {\n  int id_;\n};\n\n}  // namespace n\n',
    'namespace n {\nclass W {\n  int id_;\n\n}  // namespace n\n',
  );
});

test('an insertion with its OWN indent, a tab among spaces, is reproduced verbatim', async () => {
  await roundtrip('void f() {\n  a();\n\n  b();\n}\n', 'void f() {\n  a();\n\n\tint tabbed = 1;\n  b();\n}\n');
});

test('the exact flag: strict reproduces verbatim, loose matches after normalization', async () => {
  await cppAdapter.init();
  const oldStr = 'void f() {\n      deep();\n\n  b();\n}\n';
  const newStr = 'void f() {\n  deep();\n\n\tint tabbed = 1;\n  b();\n}\n';

  const strict = synthesize(oldStr, newStr, cppAdapter, { exact: true });
  assert.equal(applyAll(oldStr, hatchFile(strict), cppAdapter).source, newStr);

  const loose = synthesize(oldStr, newStr, cppAdapter);
  const looseOut = applyAll(oldStr, hatchFile(loose), cppAdapter).source;
  assert.equal(cppAdapter.normalize(looseOut), cppAdapter.normalize(newStr));
  assert.equal(looseOut, newStr);
});

test('loose mode may NOT swallow a line: the check is per line, not over the whole text', async () => {
  await cppAdapter.init();
  const oldStr =
    '#include <vector>\n#include <string_view>\n\n\n#include "a.h"\n#include "to_vector.h"\n#include "b.h"\n';
  const newStr = '#include <vector>\n\n#include "a.h"\n#include "b.h"\n';

  for (const exact of [false, true]) {
    const hunks = synthesize(oldStr, newStr, cppAdapter, { exact });
    assert.equal(
      applyAll(oldStr, hatchFile(hunks), cppAdapter).source,
      newStr,
      `exact=${exact} has to reproduce the set of lines`,
    );
  }
});

test('structure from rung zero: even a self-unique edit still carries a parent', async () => {
  await cppAdapter.init();
  const oldStr = 'void a() {\n  keep();\n}\nvoid b() {\n  keep();\n  target = 1;\n}\n';
  const newStr = 'void a() {\n  keep();\n}\nvoid b() {\n  keep();\n  target = 2;\n}\n';
  const hunks = synthesize(oldStr, newStr, cppAdapter);
  assert.match(printPattern(hunks[0]!.match), /void b\(\)/);
  assert.equal(applyAll(oldStr, hatchFile(hunks), cppAdapter).source, newStr);
  const drifted = 'void a() {\n  keep();\n}\nvoid b() {\n  keep();\n}\nvoid c() {\n  target = 1;\n}\n';
  assert.throws(() => applyAll(drifted, hatchFile(hunks), cppAdapter), MatchError);
});

test('synthesizeAsync: the same hunks; a signal stops it between two changes, with its reason', async () => {
  await cppAdapter.init();
  const old = Array.from({ length: 6 }, (_, i) => `int f${i}(int a) {\n  return ${i};\n}\n`).join('');
  const neu = old.replace(/return (\d+);/g, 'return $1 + 1;');
  assert.deepEqual(await synthesizeAsync(old, neu, cppAdapter), synthesize(old, neu, cppAdapter));

  const control = new AbortController();
  let segments = 0;
  const trace = (e: SynthEvent): void => {
    if (e.kind === 'segment' && ++segments === 3) control.abort(new Error('stop here'));
  };
  await assert.rejects(synthesizeAsync(old, neu, cppAdapter, { signal: control.signal, trace }), /stop here/);
  assert.equal(segments, 3, 'the change under way is finished, the next one is not started');
});

test('synth: a change no candidate could be built around is no-match, not ambiguous — nothing fitted twice', () => {
  const segment = { oldStart: 3, newStart: 4, removed: ['  x();'], added: [] };
  const none = anchorFailure(segment, undefined);
  assert.equal(none.reason, 'no-match');
  assert.match(none.message, /could not anchor the change at line 4 .* no pattern could be built around it/);
  assert.equal(anchorFailure(segment, new AmbiguityError('ambiguous match', [1, 2])).reason, 'ambiguous');
  assert.equal(anchorFailure(segment, new MatchError('no match', 0, 0)).reason, 'no-match');
});
