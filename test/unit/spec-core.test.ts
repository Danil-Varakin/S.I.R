import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSirFile } from '../../src/core/sir-parser.ts';
import { applyAll } from '../../src/core/apply.ts';
import { synthesize } from '../../src/generate/synth.ts';
import { printSirFile } from '../../src/generate/printer.ts';
import { AmbiguityError, MatchError, ParseError } from '../../src/core/errors.ts';
import { cppAdapter } from '../../src/lang/cpp/index.ts';
import { firstMatch, sirMd, strip, wrapMatch } from '../helpers.ts';

const roundtrip = (oldText: string, newText: string): string => {
  const md = printSirFile(synthesize(oldText, newText, cppAdapter), 'cpp');
  return applyAll(oldText, parseSirFile(md), cppAdapter).source;
};

const applyText = (source: string, md: string): string => applyAll(source, parseSirFile(md), cppAdapter).source;

test('format: an empty file, blank lines only, or a header with no hunks is a ParseError (exit 2), not an empty patch', () => {
  for (const text of ['', '\n\n   \n', 'Sir: 2\nTarget: a.cc\n\n', 'just prose\n']) {
    assert.throws(
      () => parseSirFile(text),
      (e: unknown) => e instanceof ParseError && e.exitCode === 2,
      JSON.stringify(text),
    );
  }
});

test('format: "an instruction file may reach you with LF or CRLF … both read alike"', () => {
  const lf =
    'Sir: 2\nTarget: src/a.cc\n\n' +
    '# note\nwhy: see review\n# end\n' +
    sirMd([
      { match: '...\nvoid f() {\n...\n>>>\n}\n...', patch: '\n  a();\n\n  b();' },
      { match: '...\nint x;\n>>>\n...', patch: '' },
    ]);
  const crlf = lf.replace(/\n/g, '\r\n');
  const a = parseSirFile(lf);
  const b = parseSirFile(crlf);
  assert.deepEqual(b.header, a.header);
  assert.equal(b.hunks.length, a.hunks.length);
  for (let i = 0; i < a.hunks.length; i++) {
    assert.equal(b.hunks[i]!.patch, a.hunks[i]!.patch, `hunk ${i + 1}: the patch body carries no CR`);
    assert.deepEqual(strip(b.hunks[i]!.match), strip(a.hunks[i]!.match), `hunk ${i + 1}: the pattern`);
    assert.equal(b.hunks[i]!.note?.text, a.hunks[i]!.note?.text, `hunk ${i + 1}: the note`);
  }
});

test('format: a large patch — 2000 hunks — is read whole, every hunk at its own lines', () => {
  const hunks = Array.from({ length: 2000 }, (_, i) => ({ match: `...\nint v${i} = ${i};\n>>>\n...`, patch: `int w${i};` }));
  const file = parseSirFile(sirMd(hunks));
  assert.equal(file.hunks.length, 2000);
  for (let i = 1; i < file.hunks.length; i++) {
    const prev = file.hunks[i - 1]!.mdSpan!;
    const span = file.hunks[i]!.mdSpan!;
    assert.ok(prev[1] < span[0], `hunk ${i + 1} starts after hunk ${i} ends`);
  }
  assert.equal(file.hunks[1999]!.patch, 'int w1999;');
});

test('language: "operators are recognized only as standalone words, so template <typename... Args> stays literal"', () => {
  const m = firstMatch(wrapMatch('template <typename... Args>\n>>>'));
  assert.deepEqual(strip(m), [
    { mode: { op: 'tight' }, insert: null, replaceEnd: null, anchor: { kind: 'literal', raw: 'template <typename... Args>' } },
    { mode: { op: 'tight' }, insert: 'left', replaceEnd: null, anchor: { kind: 'eof' } },
  ]);
  const glued = strip(firstMatch(wrapMatch('a>>>b c<<<d >>>')));
  assert.equal(glued.length, 2);
  assert.equal(glued[0]!.anchor.raw, 'a>>>b c<<<d');
});

const SRC = 'void f() {\n  a();\n}\n';

test('language: "no ... before the first literal means starts at the very beginning of the file"', async () => {
  await cppAdapter.init();
  const md = sirMd([{ match: 'a();\n>>>\n...', patch: 'X();' }]);
  assert.throws(() => applyText(`x();\n${SRC}`, md), MatchError, 'a(); is not at offset 0');
  assert.equal(applyText('a();\nb();\n', md), 'a();X();\nb();\n');
});

test('language: "whitespace between literals and operators is insignificant for brace languages"', async () => {
  await cppAdapter.init();
  const md = sirMd([{ match: '...\n      void    f (  )\n {\n a ( ) ;\n>>>\n }\n...', patch: '\n  b();' }]);
  assert.equal(applyText(SRC, md), 'void f() {\n  a();\n  b();\n}\n');
});

test('language: "inside a string literal, whitespace is data and it counts" — Log("a  b") does not match Log("a b")', async () => {
  await cppAdapter.init();
  const source = 'void f() {\n  Log("a b");\n}\n';
  assert.throws(() => applyText(source, sirMd([{ match: '...\nLog("a  b");\n>>>\n...', patch: 'X();' }])), MatchError);
  assert.match(applyText(source, sirMd([{ match: '...\nLog("a b");\n>>>\n...', patch: 'X();' }])), /Log\("a b"\);X\(\);/);
});

test('rule 1: "<<< replaces inclusively — literals between >>> and <<< must match"', async () => {
  await cppAdapter.init();
  const md = sirMd([{ match: '...\n>>>\nnot_there();\n<<<\n...', patch: 'new();' }]);
  assert.throws(() => applyText(SRC, md), MatchError, 'old code that is not there is not replaced by nothing');
});

test('API: applyAll "throws MatchError or AmbiguityError on the first hunk that does not fit" — with the CLI exit codes', async () => {
  await cppAdapter.init();
  const second = sirMd([
    { match: '...\na();\n>>>\n...', patch: 'X();' },
    { match: '...\nnosuch();\n>>>\n...', patch: 'Y();' },
  ]);
  assert.throws(() => applyText(SRC, second), (e: unknown) => e instanceof MatchError && e.exitCode === 3);

  const twice = sirMd([{ match: '...\nping();\n>>>\n...', patch: 'X();' }]);
  assert.throws(
    () => applyText('void f(){ ping(); ping(); }', twice),
    (e: unknown) => e instanceof AmbiguityError && e.exitCode === 4 && e.positions.length === 2,
  );
});

test('known limitation: a patch laid a second time on its own result inserts again', async () => {
  await cppAdapter.init();
  const patch = sirMd([{ match: '...\nvoid g() {\n...\n>>>\n}\n...', patch: 'X();' }]);
  const once = applyText('void g() {\n  a();\n}\n', patch);
  const twice = applyText(once, patch);
  assert.equal(once.split('X();').length - 1, 1);
  assert.equal(twice.split('X();').length - 1, 2, 'no error, and the insertion is there twice');
});

test('round trip: "applying a generated patch to the old file reproduces the new file" — from and to an EMPTY file', async () => {
  await cppAdapter.init();
  assert.equal(roundtrip('', 'int a = 1;\n'), 'int a = 1;\n', 'into an empty file');
  assert.equal(roundtrip('int a = 1;\nint b = 2;\n', ''), '', 'down to an empty file');
  assert.equal(roundtrip('\n', 'int a = 1;\n'), 'int a = 1;\n', 'from a file of one blank line');
});

test('round trip: non-ASCII text — Cyrillic, an emoji (a surrogate pair), a CJK identifier', async () => {
  await cppAdapter.init();
  const oldText = 'void f() {\n  log("привет 👋");\n  int 变量 = 1;\n}\n';
  const newText = 'void f() {\n  log("пока 👋👋");\n  int 变量 = 2;\n  // ✓ готово\n}\n';
  assert.equal(roundtrip(oldText, newText), newText);
});

test('round trip: a large file — 20 000 lines, edits at the start, middle and end', async () => {
  await cppAdapter.init();
  const lines = Array.from({ length: 20_000 }, (_, i) => `int v${i} = ${i};`);
  const oldText = `${lines.join('\n')}\n`;
  const changed = [...lines];
  changed[0] = 'int v0 = -1;';
  changed[10_000] = 'int v10000 = -1;';
  changed.splice(15_000, 0, 'int inserted = 7;');
  changed[changed.length - 1] = 'int last = 0;';
  const newText = `${changed.join('\n')}\n`;
  assert.equal(roundtrip(oldText, newText), newText);
});

test('round trip: one line of 100 000 characters', async () => {
  await cppAdapter.init();
  const long = Array.from({ length: 10_000 }, (_, i) => `a${i}`).join(', ');
  const oldText = `int f() {\n  return g(${long});\n}\nint h() {\n  return 1;\n}\n`;
  const newText = oldText.replace('return 1;', 'return 2;');
  assert.equal(roundtrip(oldText, newText), newText);
});

test('repeat: synthesize twice on the same input prints the same .sirp (goldens rely on it)', async () => {
  await cppAdapter.init();
  const oldText = 'namespace n {\nvoid f() {\n  a();\n}\nvoid g() {\n  a();\n}\n}\n';
  const newText = 'namespace n {\nvoid f() {\n  a();\n}\nvoid g() {\n  a();\n  b();\n}\n}\n';
  const once = printSirFile(synthesize(oldText, newText, cppAdapter), 'cpp');
  const twice = printSirFile(synthesize(oldText, newText, cppAdapter), 'cpp');
  assert.equal(twice, once);
});
