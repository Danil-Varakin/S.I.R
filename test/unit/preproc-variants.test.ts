import { test } from 'node:test';
import assert from 'node:assert/strict';

import { adapterForLanguage } from '../../src/lang/adapter.ts';
import { applyAll } from '../../src/core/apply.ts';
import { preprocVariants } from '../../src/lang/preproc-variants.ts';
import type { PreprocRules } from '../../src/lang/preproc-variants.ts';
import type { SourceMap } from '../../src/lang/source-map.ts';
import { patchOf } from '../matrix.ts';

const RULES: PreprocRules = {
  open: /^[ \t]*#[ \t]*(?:if|ifdef|ifndef)\b/,
  middle: /^[ \t]*#[ \t]*(?:else|elif|elifdef|elifndef)\b/,
  close: /^[ \t]*#[ \t]*endif\b/,
};

const SPLIT = 'void f() {\n#if A\n  if (y) {\n#else\n  if (z) {\n#endif\n    a();\n  }\n}\n';

test('variants: a file with no group has none', () => {
  assert.deepEqual(preprocVariants('void f() {\n  a();\n}\n', RULES), []);
  assert.deepEqual(preprocVariants('#include "x.h"\n#define X 1\n', RULES), []);
});

test('variants: `#if` / `#else` — a variant for each branch, directives and the other branch blank', () => {
  const lines = (v: string): string[] => v.split('\n').map((l) => l.trim());
  const variants = preprocVariants(SPLIT, RULES);
  assert.equal(variants.length, 2);
  assert.deepEqual(lines(variants[0]!), ['void f() {', '', 'if (y) {', '', '', '', 'a();', '}', '}', '']);
  assert.deepEqual(lines(variants[1]!), ['void f() {', '', '', '', 'if (z) {', '', 'a();', '}', '}', '']);
});

test('variants: every variant is as long as the file and keeps each character it keeps where it was', () => {
  for (const v of preprocVariants(SPLIT, RULES)) {
    assert.equal(v.length, SPLIT.length);
    for (let i = 0; i < v.length; i++) assert.ok(v[i] === SPLIT[i] || v[i] === ' ', `index ${i}`);
    assert.equal(v.split('\n').length, SPLIT.split('\n').length);
  }
});

test('variants: a group with no `#else` has the branch of a false condition too', () => {
  const src = 'void f() {\n#if A\n  if (y) {\n#endif\n  a();\n#if A\n  }\n#endif\n}\n';
  const [on, off] = preprocVariants(src, RULES);
  assert.ok(on!.includes('if (y) {') && on!.includes('  }'));
  assert.ok(!off!.includes('if (y)') && !off!.slice(off!.indexOf('a();')).includes('}\n  }'));
});

test('variants: `#elif` is a branch of its own', () => {
  const src = '#if A\nint a;\n#elif B\nint b;\n#else\nint c;\n#endif\n';
  const kept = preprocVariants(src, RULES).map((v) => v.split('\n').filter((l) => l.trim() !== ''));
  assert.deepEqual(kept, [['int a;'], ['int b;'], ['int c;']]);
});

test('variants: a group inside a branch that is blanked is blanked with it', () => {
  const src = '#if A\n#if B\nint ab;\n#endif\n#else\nint c;\n#endif\n';
  const kept = preprocVariants(src, RULES).map((v) => v.split('\n').filter((l) => l.trim() !== ''));
  assert.deepEqual(kept[1], ['int c;']);
  assert.ok(kept[0]!.includes('int ab;'));
});

test('variants: no more than four', () => {
  const src = '#if A\n1\n#elif B\n2\n#elif C\n3\n#elif D\n4\n#elif E\n5\n#else\n6\n#endif\n';
  assert.equal(preprocVariants(src, RULES).length, 4);
});

test('variants: a directive with blanks inside (`#  if`, `# endif`) and one in an indented line are read', () => {
  const src = '  #  ifdef A\nint a;\n  # else\nint b;\n  #endif\n';
  assert.equal(preprocVariants(src, RULES).length, 2);
});

test('variants: an include guard holds the whole file and is read as it is — not as the build where it is false', () => {
  const header = '#ifndef X_H_\n#define X_H_\nclass A {\n  void f();\n};\n#endif\n';
  for (const v of preprocVariants(header, RULES)) assert.ok(v.includes('class A {'));
});

test('variants: a group that leaves a bracket open has the branch of a false condition, one that balances itself has not', () => {
  const open = preprocVariants('void f() {\n#if A\n  if (y) {\n#endif\n  a();\n}\n', RULES);
  assert.equal(open.length, 2);
  const balanced = preprocVariants('void f() {\n#if A\n  a();\n#endif\n}\n', RULES);
  assert.equal(balanced.length, 1);
});

test('variants: a bracket in a string or a comment does not count toward the balance of a group', () => {
  const src = 'void f() {\n#if A\n  log("{");  // (\n#endif\n}\n';
  assert.equal(preprocVariants(src, RULES).length, 1);
});

const braces = (map: SourceMap, src: string): string[] => {
  const line = (p: number): number => src.slice(0, map.toOriginalPos(p, 'right')).split('\n').length;
  return map
    .blocksWithin(0, map.eof)
    .filter((s) => src[map.toOriginalPos(s.open, 'right')] === '{')
    .map((s) => `{${line(s.open)}…${line(s.close)}}`);
};

async function blocksOf(language: string, src: string): Promise<string[]> {
  const a = adapterForLanguage(language);
  await a.init();
  return braces(a.buildMap(src), src);
}

test('map: C — a `{` in each branch of an `#if`: one block for the `if`, which one `}` closes', async () => {
  assert.deepEqual(await blocksOf('c', SPLIT), ['{1…9}', '{3…8}']);
});

test('map: Objective-C — the method holds, and the `if` ends at its own `}`', async () => {
  const src = '@implementation K\n- (void)f {\n#if A\n  if (y) {\n#else\n  if (z) {\n#endif\n    [self a];\n  }\n}\n@end\n';
  assert.deepEqual(await blocksOf('objc', src), ['{2…10}', '{4…9}']);
});

test('map: a header under an include guard, with `@class` for Objective-C and `class` for C++ — the class holds', async () => {
  const src = [
    '#ifndef W_H_', '#define W_H_', '', '#ifdef __OBJC__', '@class NSWindow;', '#else', 'class NSWindow;', '#endif', '',
    'class BraveWindow {', ' public:', '  void UpdateTitlebar();', ' private:', '  NSWindow* window_;', '};', '', '#endif  // W_H_', '',
  ].join('\n');
  assert.deepEqual(await blocksOf('cpp', src), ['{10…15}']);
});

test('map: an optional block — `#if A` opens it and a second `#if A` closes it', async () => {
  const src = 'void f() {\n#if A\n  if (y) {\n#endif\n  a();\n#if A\n  }\n#endif\n}\nvoid g() {\n  b();\n}\n';
  const blocks = await blocksOf('cpp', src);
  assert.ok(blocks.includes('{1…9}'), blocks.join(' '));
  assert.ok(blocks.includes('{10…12}'));
});

test('map: a file that reads clean is read as it is — a balanced `#if` changes nothing', async () => {
  const src = 'void f() {\n#if A\n  a();\n#else\n  b();\n#endif\n  c();\n}\n';
  assert.deepEqual(await blocksOf('cpp', src), ['{1…8}']);
});

test('map: a file no build reads clean keeps the parse it has — nothing is thrown, the other function stays', async () => {
  const src = 'void f() {\n#if A\n  {{\n#else\n  {{{\n#endif\n}\nvoid g() {\n  a();\n}\n';
  const blocks = await blocksOf('cpp', src);
  assert.ok(blocks.includes('{8…10}'), blocks.join(' '));
});

test('map: `#if` and `#endif` in a comment or a string are not read as directives', async () => {
  const src = 'void f() {\n  // #if A\n  a();\n}\nvoid g() {\n  b();\n}\n';
  assert.deepEqual(await blocksOf('cpp', src), ['{1…4}', '{5…7}']);
});

const unit = (name: string, body: string): string =>
  `void ${name}(int x) {\n#if A\n  if (y) {\n#else\n  if (z) {\n#endif\n${body}  }\n}\n`;

test('generate → apply on a function written for two builds gives the new text', async () => {
  const a = adapterForLanguage('cpp');
  await a.init();
  const oldText = `${unit('f', '    a(x);\n    b(x);\n')}\nvoid g(int x) {\n  a(x);\n  b(x);\n}\n`;
  const newText = `${unit('f', '    a(x);\n    NEW(x);\n    b(x);\n')}\nvoid g(int x) {\n  a(x);\n  b(x);\n}\n`;
  assert.equal(applyAll(oldText, patchOf(oldText, newText, a), a).source, newText);
});

test('a hunk anchored inside the branch of a build lands there, with the file drifting below it', async () => {
  const a = adapterForLanguage('cpp');
  await a.init();
  const oldText = unit('f', '    a(x);\n    b(x);\n');
  const newText = unit('f', '    a(x);\n    NEW(x);\n    b(x);\n');
  const upstream = `${unit('f', '    a(x);\n    b(x);\n')}\nvoid g(int x) {\n  a(x);\n  b(x);\n}\n`;
  const out = applyAll(upstream, patchOf(oldText, newText, a), a).source;
  assert.equal(out, `${unit('f', '    a(x);\n    NEW(x);\n    b(x);\n')}\nvoid g(int x) {\n  a(x);\n  b(x);\n}\n`);
});
