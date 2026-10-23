import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cppAdapter } from '../../src/lang/cpp/index.ts';
import { makeSourceMap } from '../../src/lang/build-map.ts';
import { buildCanon } from '../../src/lang/canon.ts';
import { normalize } from '../../src/lang/cpp/index.ts';
import type { SourceMap } from '../../src/lang/source-map.ts';

const depthAt = (map: SourceMap, pos: number): number => map.enclosing(pos).length;
const enclosingEnd = (map: SourceMap, pos: number): number => map.enclosing(pos)[0]?.close ?? map.eof;

function cursorAfter(map: ReturnType<typeof cppAdapter.buildMap>, anchor: string): number {
  for (let p = 0; p + anchor.length <= map.eof; p++) {
    if (map.matchesAt(anchor, p)) return p + anchor.length;
  }
  throw new Error(`no occurrence of "${anchor}"`);
}

test('nesting: enclosingEnd jumps to the "}" of its own level, depthAt counts', async () => {
  await cppAdapter.init();
  const map = cppAdapter.buildMap('namespace a { class B { void f(){ g(); } }; }');
  const cur = cursorAfter(map, 'g();');
  assert.equal(depthAt(map, cur), 3);
  assert.ok(map.matchesAt('}', enclosingEnd(map, cur)));
});

test('enclosing returns WHOLE spans ({open, close}), innermost first', async () => {
  await cppAdapter.init();
  const map = cppAdapter.buildMap('namespace a { class B { void f(){ g(); } }; }');
  const cur = cursorAfter(map, 'g();');
  const spans = map.enclosing(cur);
  assert.equal(spans.length, 3);
  for (const s of spans) {
    assert.ok(map.matchesAt('{', s.open));
    assert.ok(map.matchesAt('}', s.close));
    assert.ok(s.open < cur && cur <= s.close);
  }
  for (let i = 1; i < spans.length; i++) assert.ok(spans[i]!.open < spans[i - 1]!.open);
  assert.equal(spans[0]!.close, enclosingEnd(map, cur));
});

test('brackets inside a string, a char or a comment open no blocks', async () => {
  await cppAdapter.init();
  const map = cppAdapter.buildMap('void g() { auto s = "{"; char c = \'}\'; /* } */ }');
  const cur = cursorAfter(map, 'auto s');
  assert.equal(depthAt(map, cur), 1);
  assert.ok(map.matchesAt('}', enclosingEnd(map, cur)));
});

test('the preprocessor: both #if/#else branches are in the tree and stay balanced', async () => {
  await cppAdapter.init();
  const src = ['#if A', 'void Foo() {', '#else', 'void Foo(int x) {', '#endif', '  body();', '}'].join('\n');
  const map = cppAdapter.buildMap(src);
  const cur = cursorAfter(map, 'body();');
  assert.ok(depthAt(map, cur) >= 1);
  assert.ok(map.matchesAt('}', enclosingEnd(map, cur)));
});

test('at the top level enclosingEnd is eof', async () => {
  await cppAdapter.init();
  const map = cppAdapter.buildMap('int x = 1;\nint y = 2;\n');
  assert.equal(enclosingEnd(map, 0), map.eof);
  assert.equal(depthAt(map, 0), 0);
});

test('matchesAt honours token boundaries: Foo does not match inside FooBar', () => {
  const map = makeSourceMap(buildCanon('FooBar Foo', normalize), []);
  assert.equal(map.matchesAt('Foo', 0), false);
  assert.equal(map.matchesAt('Foo', 7), true);
});

test('occurrences finds whole tokens only, within the window', () => {
  const canon = buildCanon('x = f(x) + xy;', normalize);
  const map = makeSourceMap(canon, []);
  const occ = [...map.occurrences('x', 0, map.eof)];
  for (const p of occ) assert.equal(map.matchesAt('x', p), true);
  assert.equal(occ.length, 2);
  assert.equal(map.countOccurrences('x', 0, map.eof), 2, 'the count must agree with the walk');
});

test('matchesAt on "}" needs no boundary, punctuation being punctuation', () => {
  const map = makeSourceMap(buildCanon('a{}', normalize), []);
  assert.equal(map.matchesAt('{', 1), true);
  assert.equal(map.matchesAt('}', 2), true);
});

test('nested () give different levels and their own enclosingEnd', async () => {
  await cppAdapter.init();
  const map = cppAdapter.buildMap('void h(){ func(a, d(a, c)); }');
  const outer = cursorAfter(map, 'func(');
  const inner = cursorAfter(map, 'd(');
  assert.equal(depthAt(map, inner) - depthAt(map, outer), 1);
  assert.ok(map.matchesAt(')', enclosingEnd(map, outer)));
  assert.ok(map.matchesAt(')', enclosingEnd(map, inner)));
  assert.notEqual(enclosingEnd(map, outer), enclosingEnd(map, inner));
});

test('occurrences returns EVERY textual hit; enclosingEnd tells the levels apart', async () => {
  await cppAdapter.init();
  const map = cppAdapter.buildMap('void h(){ f(a, g(b, c)); }');
  const cur = cursorAfter(map, 'f(');
  const outerClose = enclosingEnd(map, cur);
  const commas = [...map.occurrences(',', cur, map.eof)];
  assert.equal(commas.length, 2);
  assert.equal(map.countOccurrences(',', cur, map.eof), 2);
  const atOuterLevel = commas.filter((p) => enclosingEnd(map, p) === outerClose);
  assert.equal(atOuterLevel.length, 1);
});

test('occurrences: a hit may start on the to boundary and run past it', async () => {
  await cppAdapter.init();
  const map = cppAdapter.buildMap('void f(){ if(x){ a(); } else { b(); } }');
  const cur = cursorAfter(map, 'a();');
  const closeIf = enclosingEnd(map, cur);
  assert.deepEqual([...map.occurrences(normalize('} else {'), cur, closeIf)], [closeIf]);
  assert.deepEqual([...map.occurrences(normalize('b();'), cur, closeIf)], []);
});

test('[] and <> are blocks, a binary < is not', async () => {
  await cppAdapter.init();
  const sub = cppAdapter.buildMap('arr[i];');
  assert.equal(depthAt(sub, cursorAfter(sub, 'arr[')), 1);
  const tpl = cppAdapter.buildMap('Foo<int> x;');
  assert.equal(depthAt(tpl, cursorAfter(tpl, 'Foo<')), 1);
  const lt = cppAdapter.buildMap('bool f(){ return a < b; }');
  assert.equal(depthAt(lt, cursorAfter(lt, 'return')), 1);
});

test('sibling blocks: enclosingEnd tells their parents apart', async () => {
  await cppAdapter.init();
  const map = cppAdapter.buildMap('namespace n { void a(){ x(); } void b(){ y(); } }');
  const inA = cursorAfter(map, 'x();');
  const inB = cursorAfter(map, 'y();');
  assert.equal(depthAt(map, inA), 2);
  assert.equal(depthAt(map, inB), 2);
  assert.notEqual(enclosingEnd(map, inA), enclosingEnd(map, inB));
  const betweenFns = cursorAfter(map, 'void b');
  assert.equal(depthAt(map, betweenFns), 1);
  assert.ok(map.matchesAt('}', enclosingEnd(map, betweenFns)));
});

test('headerStart: a body span carries the start of the HEADER, not the line with "{"', async () => {
  await cppAdapter.init();
  const map = cppAdapter.buildMap('void foo(int a)\n{\n  g();\n}\n');
  const s = map.enclosing(cursorAfter(map, 'g();'))[0]!;
  assert.ok(s.headerStart !== undefined);
  assert.ok(map.matchesAt('void', s.headerStart!));
  assert.ok(s.headerStart! < s.open);
});

test('blocksWithin: returns bracket spans lying WHOLLY inside the range', async () => {
  await cppAdapter.init();
  const map = cppAdapter.buildMap('void foo(int a, int b) {\n  g();\n}\n');
  const s = map.enclosing(cursorAfter(map, 'g();'))[0]!;
  const inHeader = map.blocksWithin(s.headerStart!, s.open);
  assert.equal(inHeader.length, 1);
  assert.ok(map.matchesAt('(', inHeader[0]!.open));
  assert.ok(map.matchesAt(')', inHeader[0]!.close));
  assert.deepEqual(map.blocksWithin(0, 1), []);
  assert.throws(() => map.blocksWithin(2, 1));
});

test('token boundaries work for non-ASCII text', () => {
  const map = makeSourceMap(buildCanon('Фу,Фубар', normalize), []);
  assert.equal(map.matchesAt('Фу', 0), true);
  assert.equal(map.matchesAt('Фу', 3), false);
});

test('the map methods throw on an invalid input', () => {
  const map = makeSourceMap(buildCanon('abc', normalize), []);
  assert.throws(() => map.matchesAt('a', 99));
  assert.throws(() => map.matchesAt('', 0));
  assert.throws(() => map.occurrences('a', 2, 1));
  assert.throws(() => map.countOccurrences('a', 2, 1));
  assert.throws(() => enclosingEnd(map, -1));
  // @ts-expect-error
  assert.throws(() => map.toOriginalPos(0, 'up'));
});

test('canon.toCanonPos/toOriginalPos throw outside the range', () => {
  const c = buildCanon('abc', normalize);
  assert.throws(() => c.toCanonPos(99));
  assert.throws(() => c.toOriginalPos(99, 'left'));
});
