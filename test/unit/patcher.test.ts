import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cppAdapter, normalize } from '../../src/lang/cpp/index.ts';
import { matchPattern } from '../../src/core/matcher.ts';
import { planEdit, applyEdit, patchHunk } from '../../src/core/patcher.ts';
import { firstMatch, wrapMatch } from '../helpers.ts';

function pattern(...lines: string[]) {
  return firstMatch(wrapMatch(lines.join('\n')));
}

test('planEdit: a pure insertion has start == end', async () => {
  await cppAdapter.init();
  const src = 'void f(){ a(); b(); }';
  const map = cppAdapter.buildMap(src);
  const marks = matchPattern(pattern('... a(); >>> ...'), map, normalize);
  const edit = planEdit(src, map, marks, 'X();');
  assert.equal(edit.start, edit.end);
  assert.equal(src[edit.start], ' ');
});

test('planEdit: a replacement puts end after start, spanning the old code', async () => {
  await cppAdapter.init();
  const src = 'a; old(); b;';
  const map = cppAdapter.buildMap(src);
  const marks = matchPattern(pattern('... a; >>> old(); <<< b; ...'), map, normalize);
  const edit = planEdit(src, map, marks, 'new();');
  assert.ok(edit.end > edit.start);
  assert.equal(src.slice(edit.start, edit.end).trim(), 'old();');
});

test('applyEdit: insertion and replacement give the expected string', () => {
  assert.equal(applyEdit('ab', { start: 1, end: 1, text: 'X' }), 'aXb');
  assert.equal(applyEdit('aOLDb', { start: 1, end: 4, text: 'X' }), 'aXb');
});

test('patchHunk: an insertion returns the new text and the edit', async () => {
  await cppAdapter.init();
  const src = 'void f(){ a(); b(); }';
  const map = cppAdapter.buildMap(src);
  const marks = matchPattern(pattern('... a(); >>> ...'), map, normalize);
  const { source, edit } = patchHunk(src, map, marks, 'X();');
  assert.ok(source.includes('a();X(); b();'), source);
  assert.equal(edit.start, edit.end);
});

test('patchHunk: a replacement cuts the old code out and puts the patch in', async () => {
  await cppAdapter.init();
  const src = 'a; old(); b;';
  const map = cppAdapter.buildMap(src);
  const marks = matchPattern(pattern('... a; >>> old(); <<< b; ...'), map, normalize);
  const { source } = patchHunk(src, map, marks, 'new();');
  assert.equal(source, 'a;new(); b;');
});

async function landed(src: string, patternText: string, patch: string): Promise<string> {
  await cppAdapter.init();
  const map = cppAdapter.buildMap(src);
  return patchHunk(src, map, matchPattern(pattern(patternText), map, normalize), patch).source;
}

test('patchHunk: in a CRLF file every line the patch writes ends in CRLF', async () => {
  assert.equal(
    await landed('void f() {\r\n  a();\r\n}\r\n', '... a(); >>> ...', '\n  b();\n  c();'),
    'void f() {\r\n  a();\r\n  b();\r\n  c();\r\n}\r\n',
  );
});

test('patchHunk: in an LF file the patch lands byte for byte, as it always did', async () => {
  assert.equal(
    await landed('void f() {\n  a();\n}\n', '... a(); >>> ...', '\n  b();'),
    'void f() {\n  a();\n  b();\n}\n',
  );
});

test('patchHunk: a CRLF the patch already carries is not doubled', async () => {
  assert.equal(await landed('x;\r\ny;\r\n', '... x; >>> ...', '\r\nz;'), 'x;\r\nz;\r\ny;\r\n');
});

test('patchHunk: in a file of mixed endings the line the edit starts on decides', async () => {
  assert.equal(await landed('x;\ny;\r\n', '... x; >>> ...', '\nz;'), 'x;\nz;\ny;\r\n');
  assert.equal(await landed('x;\ny;\r\n', '... y; >>> ...', '\nz;'), 'x;\ny;\r\nz;\r\n');
});

test('patchHunk: on a last line with no ending of its own, the line above decides', async () => {
  assert.equal(await landed('x;\r\ny;', '... y; >>>', '\nz;'), 'x;\r\ny;\r\nz;');
  assert.equal(await landed('y;', '... y; >>>', '\nz;'), 'y;\nz;');
});
