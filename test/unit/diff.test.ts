import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diffHunks, changeSegments, lineKind, lineText } from '../../src/generate/diff.ts';

test('identical files yield no hunks and no segments', () => {
  const src = 'int a;\nint b;\nint c;\n';
  assert.deepEqual(diffHunks(src, src), []);
  assert.deepEqual(changeSegments(src, src), []);
});

test('one changed line: the hunk carries context, del and add', () => {
  const oldStr = 'a\nb\nc\nd\ne\n';
  const newStr = 'a\nb\nC\nd\ne\n';
  const hunks = diffHunks(oldStr, newStr);
  assert.equal(hunks.length, 1);
  const h = hunks[0]!;
  assert.equal(h.oldStart, 1);
  assert.ok(h.lines.includes('-c'));
  assert.ok(h.lines.includes('+C'));
  assert.ok(h.lines.includes(' b'));
  assert.ok(h.lines.includes(' d'));
});

test('context controls hunk width and the merging of neighbouring edits', () => {
  const oldStr = 'a\nb\nc\nd\ne\nf\ng\n';
  const newStr = 'A\nb\nc\nd\ne\nf\nG\n';
  assert.equal(diffHunks(oldStr, newStr, 1).length, 2);
  assert.equal(diffHunks(oldStr, newStr, 5).length, 1);
});

test('lineKind/lineText: reading the prefix markers, eofnl included', () => {
  assert.equal(lineKind(' ctx'), 'context');
  assert.equal(lineKind('-gone'), 'del');
  assert.equal(lineKind('+new'), 'add');
  assert.equal(lineKind('\\ No newline at end of file'), 'eofnl');
  assert.equal(lineText('+result *= 2;'), 'result *= 2;');
  assert.equal(lineText('-old'), 'old');
});

// --- changeSegments: atomic edits, one segment per Sir hunk ---

test('replacing one line gives one segment {removed, added} with coordinates', () => {
  const oldStr = 'a\nb\nc\nd\ne\n';
  const newStr = 'a\nb\nC\nd\ne\n';
  const segs = changeSegments(oldStr, newStr);
  assert.equal(segs.length, 1);
  assert.deepEqual(segs[0], { oldStart: 3, newStart: 3, removed: ['c'], added: ['C'] });
});

test('a pure insertion: removed is empty and oldStart is the line it goes BEFORE', () => {
  const oldStr = 'a\nb\nc\n';
  const newStr = 'a\nX\nb\nc\n';
  const segs = changeSegments(oldStr, newStr);
  assert.equal(segs.length, 1);
  assert.deepEqual(segs[0], { oldStart: 2, newStart: 2, removed: [], added: ['X'] });
});

test('a pure deletion: added is empty', () => {
  const oldStr = 'a\nb\nc\n';
  const newStr = 'a\nc\n';
  const segs = changeSegments(oldStr, newStr);
  assert.equal(segs.length, 1);
  assert.deepEqual(segs[0], { oldStart: 2, newStart: 2, removed: ['b'], added: [] });
});

test('two edits split by unchanged lines give TWO segments', () => {
  const oldStr = 'a\nb\nc\nd\ne\nf\ng\n';
  const newStr = 'A\nb\nc\nd\ne\nf\nG\n';
  const segs = changeSegments(oldStr, newStr);
  assert.equal(segs.length, 2);
  assert.deepEqual(segs[0], { oldStart: 1, newStart: 1, removed: ['a'], added: ['A'] });
  assert.deepEqual(segs[1], { oldStart: 7, newStart: 7, removed: ['g'], added: ['G'] });
});

test('edits split by a BLANK unchanged line are stitched by default', () => {
  const oldStr = 'a\n\nb\n';
  const newStr = 'A\n\nB\n';
  const segs = changeSegments(oldStr, newStr);
  assert.equal(segs.length, 1);
  assert.deepEqual(segs[0], { oldStart: 1, newStart: 1, removed: ['a', '', 'b'], added: ['A', '', 'B'] });
});

test('a non-blank unchanged line cuts by default; bridgeGap=1 stitches it', () => {
  const oldStr = 'foo();\nbar();\nbaz();\n';
  const newStr = 'foo2();\nbar();\nbaz2();\n';
  assert.equal(changeSegments(oldStr, newStr).length, 2);
  const merged = changeSegments(oldStr, newStr, 1);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], {
    oldStart: 1,
    newStart: 1,
    removed: ['foo();', 'bar();', 'baz();'],
    added: ['foo2();', 'bar();', 'baz2();'],
  });
});

test('a multi-line replacement in a row is ONE segment carrying every line', () => {
  const oldStr = 'x\na\nb\ny\n';
  const newStr = 'x\nA\nB\nC\ny\n';
  const segs = changeSegments(oldStr, newStr);
  assert.equal(segs.length, 1);
  assert.deepEqual(segs[0], { oldStart: 2, newStart: 2, removed: ['a', 'b'], added: ['A', 'B', 'C'] });
});

test('inserting a whole block is ONE insertion, not line by line', () => {
  const oldStr = 'a\nb\n';
  const newStr = 'a\nX1\nX2\n\nX4\nb\n';
  const segs = changeSegments(oldStr, newStr);
  assert.equal(segs.length, 1);
  assert.deepEqual(segs[0], { oldStart: 2, newStart: 2, removed: [], added: ['X1', 'X2', '', 'X4'] });
});

test('segments cover the old file in ascending oldStart order', () => {
  const oldStr = 'a\nb\nc\nd\ne\nf\ng\nh\n';
  const newStr = 'a\nB\nc\nd\nE\nf\ng\nH\n';
  const segs = changeSegments(oldStr, newStr);
  assert.equal(segs.length, 3);
  for (let i = 1; i < segs.length; i++) assert.ok(segs[i]!.oldStart > segs[i - 1]!.oldStart);
});
