import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pythonAdapter, normalize } from '../../../src/lang/python/index.ts';
import type { SourceMap } from '../../../src/lang/source-map.ts';

const depthAt = (map: SourceMap, pos: number): number => map.enclosing(pos).length;
const enclosingEnd = (map: SourceMap, pos: number): number => map.enclosing(pos)[0]?.close ?? map.eof;

const SRC = `def f(a):
    if a:
        x = 1
    y = 2

def g():
    pass
`;

const CANON = normalize(SRC);
const at = (needle: string): number => {
  const i = CANON.indexOf(needle);
  assert.notEqual(i, -1, `not in the canon: ${needle}`);
  return i;
};

await pythonAdapter.init();
const map: SourceMap = pythonAdapter.buildMap(SRC);

test('the colon is the opening token: after `if a:` the cursor is INSIDE the body', () => {
  const ifStart = at('if a:');
  assert.equal(depthAt(map, ifStart), 1);
  assert.equal(depthAt(map, ifStart + 'if a:'.length), 2);
});

test('the end of the block is the beginning of the line of the OUTER level', () => {
  const ifBody = at('        x=1');
  const close = enclosingEnd(map, ifBody);
  assert.equal(CANON.slice(close, close + 3), 'y=2');
});

test('a nested block is closed by the outer one, and the outer one is closed by the next def', () => {
  const ifBody = at('        x=1');
  const spans = map.enclosing(ifBody);
  assert.equal(spans.length, 2);
  assert.equal(CANON.slice(spans[0]!.close, spans[0]!.close + 3), 'y=2');
  assert.equal(CANON.slice(spans[1]!.close, spans[1]!.close + 8), 'def g():');
});

test('headerStart gives the CONSTRUCTION HEADER, and [headerStart, open+1] captures the colon', () => {
  const ifBody = at('        x=1');
  const [inner, outer] = map.enclosing(ifBody);
  assert.equal(CANON.slice(inner!.headerStart!, inner!.open + 1), 'if a:');
  assert.equal(CANON.slice(outer!.headerStart!, outer!.open + 1), 'def f(a):');
});

test('there is no closing TOKEN in Python → no closeEnd (there is nothing to close the block in the template)', () => {
  const ifBody = at('        x=1');
  assert.equal(map.enclosing(ifBody)[0]!.closeEnd, undefined);
});

test('brackets remain blocks too: `(a)` in the signature is a regular span', () => {
  const parens = map.enclosing(at('def f(a):') + 6);
  assert.ok(
    parens.some((s) => CANON[s.open] === '(' && CANON[s.close] === ')'),
    JSON.stringify(parens),
  );
});

test('the neighbouring def is a different block: the depth does not leak through a blank line', () => {
  assert.equal(depthAt(map, at('def g():')), 1);
  assert.equal(depthAt(map, at('def g():') + 1), 0);
  assert.equal(depthAt(map, at('    pass')), 1);
});

test('a one-line body (`if x: pass`) is also a block — the colon opens it', async () => {
  await pythonAdapter.init();
  const src = 'def f():\n    if x: pass\n    return 1\n';
  const m = pythonAdapter.buildMap(src);
  const canon = normalize(src);
  const afterColon = canon.indexOf('if x:') + 'if x:'.length;
  assert.equal(depthAt(m, afterColon), 2);
});

test('everything is measured by the tree, not by tabs: mixed indentation does not break the block', async () => {
  await pythonAdapter.init();
  const src = 'def f():\n\tif a:\n\t\tx = 1\n\treturn x\n';
  const m = pythonAdapter.buildMap(src);
  const canon = normalize(src);
  const body = canon.indexOf('\t\tx=1');
  const close = enclosingEnd(m, body);
  assert.equal(canon.slice(close, close + 8), 'return x');
});
