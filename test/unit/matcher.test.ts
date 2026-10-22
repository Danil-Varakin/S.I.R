import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cppAdapter, normalize } from '../../src/lang/cpp/index.ts';
import { matchPattern } from '../../src/core/matcher.ts';
import type { MatchMarks } from '../../src/core/matcher.ts';
import type { MatchPattern } from '../../src/core/ast.ts';
import { MatchError, AmbiguityError } from '../../src/core/errors.ts';
import { firstMatch, wrapMatch } from '../helpers.ts';

// ── helpers ───────────────────────────────────────────────────────────────────

function pattern(...matchLines: string[]): MatchPattern {
  return firstMatch(wrapMatch(matchLines.join('\n')));
}

function apply(src: string, marks: MatchMarks, text: string): string {
  const map = cppAdapter.buildMap(src);
  const ins = map.toOriginalPos(marks.insert.pos, marks.insert.side);
  if (marks.replaceEnd === undefined) {
    return src.slice(0, ins) + text + src.slice(ins);
  }
  const end = map.toOriginalPos(marks.replaceEnd.pos, marks.replaceEnd.side);
  return src.slice(0, ins) + text + src.slice(end);
}

function run(src: string, pat: MatchPattern): MatchMarks {
  const map = cppAdapter.buildMap(src);
  return matchPattern(pat, map, normalize);
}

function insAt(src: string, marks: MatchMarks): number {
  const map = cppAdapter.buildMap(src);
  return map.toOriginalPos(marks.insert.pos, marks.insert.side);
}

// ── the edges of the file: BOF / EOF ──────────────────────────────────────────

test('... >>> inserts at the end of the file (EOF)', async () => {
  await cppAdapter.init();
  const src = 'int x = 1;';
  const marks = run(src, pattern('... >>>'));
  assert.equal(apply(src, marks, '\nint y = 2;'), 'int x = 1;\nint y = 2;');
});

test('>>> ... inserts at the start of the file (BOF)', async () => {
  await cppAdapter.init();
  const src = 'int x = 1;';
  const marks = run(src, pattern('>>> ...'));
  assert.equal(apply(src, marks, '#include "a.h"\n'), '#include "a.h"\nint x = 1;');
});

// ── an anchor with the insertion before or after it ───────────────────────────

test('... foo(); >>> ... inserts right after the anchor it found', async () => {
  await cppAdapter.init();
  const src = 'void f(){ foo(); bar(); }';
  const marks = run(src, pattern('... foo(); >>> ...'));
  assert.equal(apply(src, marks, ' baz();'), 'void f(){ foo(); baz(); bar(); }');
});

test('... >>> bar(); ... inserts right before the anchor it found', async () => {
  await cppAdapter.init();
  const src = 'void f(){ foo(); bar(); }';
  const marks = run(src, pattern('... >>> bar(); ...'));
  assert.equal(apply(src, marks, 'baz(); '), 'void f(){ foo(); baz(); bar(); }');
});

// ── an unclosed { orders the search: the context of a block ───────────────────

test('the counterexample of §3.1: ... func(...){ ... if(...){ ... >>> } ... } ...', async () => {
  await cppAdapter.init();
  const src = [
    'void func(int a) {',
    '  for (;;) {',
    '    switch (a) {',
    '      case 1: {',
    '        if (a > 0) {',
    '          doWork();',
    '        }',
    '      }',
    '    }',
    '  }',
    '}',
  ].join('\n');
  const marks = run(src, pattern('... func( ... ) { ... if( ... ) { ... >>> } ... } ...'));
  const ins = insAt(src, marks);
  assert.equal(src[ins], '}');
  assert.ok(src.slice(0, ins).trimEnd().endsWith('doWork();'), src.slice(0, ins).slice(-20));
});

test('escape: ... func(...){ ... if(...){ ... >>> } ... — an if in a later function', async () => {
  await cppAdapter.init();
  const src = [
    'void func(int a) {',
    '  prepare(a);',
    '}',
    'void handler(int b) {',
    '  if (b > 0) {',
    '    fallback();',
    '  }',
    '}',
  ].join('\n');
  const marks = run(src, pattern('... func( ... ) { ... if( ... ) { ... >>> } ...'));
  const ins = insAt(src, marks);
  assert.equal(src[ins], '}');
  assert.ok(src.slice(0, ins).trimEnd().endsWith('fallback();'), src.slice(0, ins).slice(-20));
});

test('the pattern CLOSES func: an if in another function is a MatchError', async () => {
  await cppAdapter.init();
  const src = [
    'void func(int a) {',
    '  // no if in here',
    '}',
    '',
    'void CriticalShutdown() {',
    '  if (danger) {',
    '    // ← the insertion lands here',
    '  }',
    '}',
  ].join('\n');
  assert.throws(
    () => run(src, pattern('... func( ... ) { ... if( ... ) { ... >>> } ... } ...')),
    MatchError,
  );
});

test('an if both inside and after func is an AmbiguityError', async () => {
  await cppAdapter.init();
  const src = [
    'void func(int a) {',
    '  if (a > 0) {',
    '    inside();',
    '  }',
    '}',
    'void handler(int b) {',
    '  if (b > 0) {',
    '    outside();',
    '  }',
    '}',
  ].join('\n');
  assert.throws(
    () => run(src, pattern('... func( ... ) { ... if( ... ) { ... >>> } ...')),
    AmbiguityError,
  );
});

// ── no trailing ... means the last literal must reach EOF ─────────────────────

test('without a trailing ... the anchor has to sit at the end of the file', async () => {
  await cppAdapter.init();
  const pat = pattern('... a(); >>> b();');
  const ok = 'a(); b();';
  assert.equal(apply(ok, run(ok, pat), 'X'), 'a();X b();');
  assert.throws(() => run('a(); b(); c();', pat), MatchError);
});

// ── replacing a range: >>> ... <<< ────────────────────────────────────────────

test('replacing a range: ... a; >>> old(); <<< b; ...', async () => {
  await cppAdapter.init();
  const src = 'a; old(); b;';
  const marks = run(src, pattern('... a; >>> old(); <<< b; ...'));
  assert.ok(marks.replaceEnd !== undefined);
  assert.equal(apply(src, marks, 'new();'), 'a;new(); b;');
});

// ── what a refusal and an ambiguity report ────────────────────────────────────

test('no match is a MatchError', async () => {
  await cppAdapter.init();
  const src = 'void f(){ foo(); }';
  assert.throws(() => run(src, pattern('... nonexistent(); >>> ...')), MatchError);
});

test('two identical anchors give an AmbiguityError carrying both places', async () => {
  await cppAdapter.init();
  const src = 'void f(){ ping(); ping(); }';
  assert.throws(
    () => run(src, pattern('... ping(); >>> ...')),
    (e: unknown) => e instanceof AmbiguityError && e.positions.length === 2,
  );
});

// ── the commitment: `... }` is decided by the block the pattern opened ────────

test('... >>> } takes the closer of its own block, never someone else\'s', async () => {
  await cppAdapter.init();
  const src = 'void f(){ a(); } void g(){ b(); }';
  const marks = run(src, pattern('... f() { ... >>> }  ...'));
  const ins = insAt(src, marks);
  assert.equal(src[ins], '}');
  assert.ok(src.slice(0, ins).trimEnd().endsWith('a();'));
  assert.ok(src.slice(0, ins).indexOf('b()') === -1);
});

// ── a tight gap between two words: the space between them is no literal's ─────

test('foo >>> bar: a tight gap between two words steps over the space, the mark stays before it', async () => {
  await cppAdapter.init();
  const src = 'int  foo   bar;';
  const marks = run(src, pattern('int foo >>> bar;'));
  assert.equal(apply(src, marks, '@'), 'int  foo@   bar;');
});

test('>>> on a line of its own between two words', async () => {
  await cppAdapter.init();
  const src = 'return\n  value;';
  const marks = run(src, pattern('return', '>>>', 'value;'));
  assert.equal(apply(src, marks, ' *'), 'return *\n  value;');
});

test('>>> foo <<< bar: the range runs from right after the left word to right after foo', async () => {
  await cppAdapter.init();
  const src = 'unsigned long n;';
  const marks = run(src, pattern('unsigned >>> long <<< n;'));
  assert.equal(apply(src, marks, ' int'), 'unsigned int n;');
});

test('inside a string literal one space between words is stepped over as well', async () => {
  await cppAdapter.init();
  const src = 'puts("hello world");';
  const marks = run(src, pattern('puts("hello >>> world");'));
  assert.equal(apply(src, marks, ','), 'puts("hello, world");');
});

test('only one space is stepped over: two inside a string still do not fit', async () => {
  await cppAdapter.init();
  assert.throws(() => run('puts("hello  world");', pattern('puts("hello >>> world");')), MatchError);
});

test('no step where a word does not meet a word: a+ >>> b stays tight', async () => {
  await cppAdapter.init();
  const src = 'x = a + b;';
  const marks = run(src, pattern('x = a + >>> b;'));
  assert.equal(apply(src, marks, ' 2*'), 'x = a + 2* b;');
});

// ── the obligation: the open block's own closer first, an inner one only if it fails ──

test('... f() { ... >>> } ... takes the } of f, not the } of a block nested in f', async () => {
  await cppAdapter.init();
  // the inner `}` is a legal closer too (its block is not on the stack); the obligation
  // takes the closer of the open block without looking at the others — no ambiguity
  const src = 'void f(){ if(x){ a(); } b(); }';
  const marks = run(src, pattern('... f() { ... >>> } ...'));
  assert.equal(apply(src, marks, '@'), 'void f(){ if(x){ a(); } b(); @}');
});

test('when the rest does not follow the obligation, an inner closer is tried: a search after it', async () => {
  await cppAdapter.init();
  // the } of f fits, but no b(); comes after it; the } of the if is the other closer
  const src = 'void f(){ if(x){ a(); } b(); }';
  const marks = run(src, pattern('... f() { ... >>> } ... b(); ...'));
  assert.equal(apply(src, marks, '@'), 'void f(){ if(x){ a(); @} b(); }');
});

test('when the rest does not follow the obligation, an inner closer is tried: a tight step after it', async () => {
  await cppAdapter.init();
  const src = 'void f(){ if(x){ a(); } b(); }';
  const marks = run(src, pattern('... f() { ... } >>> b(); ...'));
  assert.equal(apply(src, marks, '@'), 'void f(){ if(x){ a(); }@ b(); }');
});

test('} b(); } is one literal, not an obligation: it starts at the inner } and runs through the } of f', async () => {
  await cppAdapter.init();
  const src = 'void f(){ if(x){ a(); } b(); }';
  const marks = run(src, pattern('... f() { ... >>> } b(); } ...'));
  assert.equal(apply(src, marks, '@'), 'void f(){ if(x){ a(); @} b(); }');
});

test('obligations in a row: each } is the closer of the block opened last, no ambiguity', async () => {
  await cppAdapter.init();
  // the first } closes the if, the second the f; the } of the while is never taken —
  // tried from there, the second } would land on the } of the if, a second edit
  const src = 'void f(){ if(x){ while(y){ a(); } } b(); }';
  const marks = run(src, pattern('... f() { ... if (x) { ... } ... >>> } ...'));
  assert.equal(apply(src, marks, '@'), 'void f(){ if(x){ while(y){ a(); } } b(); @}');
});

test('an obligation that fits through a later search is not tried again from an inner closer', async () => {
  await cppAdapter.init();
  const src = 'void f(){ if(x){ a(); } b(); } c();';
  const marks = run(src, pattern('... f() { ... >>> } ... c(); ...'));
  assert.equal(apply(src, marks, '@'), 'void f(){ if(x){ a(); } b(); @} c();');
});

test('a literal that starts with the { itself opens the block: its } is the obligation', async () => {
  await cppAdapter.init();
  const src = 'struct S { int a; struct T { int b; } t; };';
  const marks = run(src, pattern('... S ... { int a; ... >>> } ...'));
  assert.equal(apply(src, marks, '@'), 'struct S { int a; struct T { int b; } t; @};');
});

// ── a gap that is no gap between two words is tight ───────────────────────────

test('inside a string a word and a sign keep no space between them: x, >>> y does not fit "x, y"', async () => {
  await cppAdapter.init();
  assert.throws(() => run('puts("x, y");', pattern('puts("x, >>> y");')), MatchError);
});

test('nor does hi >>> ! fit "hi !": the space is stepped over only before a word', async () => {
  await cppAdapter.init();
  assert.throws(() => run('puts("hi !");', pattern('puts("hi >>> !");')), MatchError);
});

// ── >>> at the very end: a tight gap before EOF ───────────────────────────────

test('... b(); >>> inserts at the end of the file when b(); ends it', async () => {
  await cppAdapter.init();
  const src = 'a(); b();';
  assert.equal(apply(src, run(src, pattern('... b(); >>>')), '@'), 'a(); b();@');
});

test('... a(); >>> refuses when the file goes on after a();, and says to add ...', async () => {
  await cppAdapter.init();
  assert.throws(
    () => run('a(); b();', pattern('... a(); >>>')),
    (e: unknown) =>
      e instanceof MatchError &&
      e.message === 'no match: the pattern ran out of steps while the file went on' &&
      e.deepestPos === 4 &&
      e.failedStepIndex === 2 &&
      e.totalSteps === 2 &&
      e.origPos === 5 &&
      e.anchorText === undefined &&
      e.matchedText === 'a();' &&
      e.matchedPos === 0 &&
      /END here/.test(e.hint ?? '') &&
      /Add `\.\.\.` at the end/.test(e.hint ?? ''),
  );
});

// ── what a MatchError says: the deepest place, the anchor, what fitted last ────

test('a MatchError at the first step: position 0, the anchor, nothing matched, no hint', async () => {
  await cppAdapter.init();
  assert.throws(
    () => run('int x;', pattern('zzz(); >>> ...')),
    (e: unknown) =>
      e instanceof MatchError &&
      e.message === 'no match: the pattern did not fit the file' &&
      e.deepestPos === 0 &&
      e.failedStepIndex === 0 &&
      e.totalSteps === 2 &&
      e.origPos === 0 &&
      e.anchorText === 'zzz();' &&
      e.matchedText === undefined &&
      e.matchedPos === undefined &&
      e.hint === undefined,
  );
});

test('a MatchError reports the deepest failure, not the last one tried', async () => {
  await cppAdapter.init();
  // the obligation (the } of f, at 29) fails right after it; then the inner } (at 22)
  // fails earlier in the file — the report is about the first, the one that got further
  const src = 'void f(){ if(x){ a(); } b(); }';
  assert.throws(
    () => run(src, pattern('... f() { ... } >>> zzz(); ...')),
    (e: unknown) =>
      e instanceof MatchError &&
      e.deepestPos === 25 &&
      e.failedStepIndex === 2 &&
      e.totalSteps === 4 &&
      e.origPos === 30 &&
      e.anchorText === 'zzz();' &&
      e.matchedText === '}' &&
      e.matchedPos === 29 &&
      e.hint === undefined,
  );
});

// ── an AmbiguityError: two edits, where each starts and ends ──────────────────

test('a range that can end at two places is ambiguous: one start, two ends', async () => {
  await cppAdapter.init();
  assert.throws(
    () => run('a; x; c; y; c;', pattern('... a; >>> ... <<< c; ...')),
    (e: unknown) =>
      e instanceof AmbiguityError &&
      JSON.stringify(e.positions) === '[2,2]' &&
      JSON.stringify(e.spanEnds) === '[6,12]',
  );
});

test('an insertion has no end: an ambiguity between two insertions carries no span ends', async () => {
  await cppAdapter.init();
  assert.throws(
    () => run('void f(){ ping(); ping(); }', pattern('... ping(); >>> ...')),
    (e: unknown) =>
      e instanceof AmbiguityError &&
      e.spanEnds.length === 2 &&
      e.spanEnds.every((x) => x === undefined),
  );
});

test('the search stops at the second place: three fits report the first two', async () => {
  await cppAdapter.init();
  // a bound on the work, not only on the report: every further fit would be walked in full
  assert.throws(
    () => run('ping(); ping(); ping();', pattern('... ping(); >>> ...')),
    (e: unknown) => e instanceof AmbiguityError && JSON.stringify(e.positions) === '[7,15]',
  );
});
