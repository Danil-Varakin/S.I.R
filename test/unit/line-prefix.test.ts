import { test } from 'node:test';
import assert from 'node:assert/strict';

import { adapterForLanguage } from '../../src/lang/adapter.ts';
import { patchOf } from '../matrix.ts';
import { applyAll } from '../../src/core/apply.ts';

// 07-findings Н8: an anchor that ended its line in the old version matches the START of a
// longer line in upstream's — `value = base` in `value = base + extra` — and the insertion
// after it lands in the middle of that line: `value = base⏎log(value) + extra`. Exit 0,
// another program. Runs as `todo` until the author decides; the row says which languages
// it reaches.

// [language, the file with LINE, the anchor line, what upstream appends to it, the added line]
const CASES: [string, string, string, string, string][] = [
  ['python', 'def f(x):\n    a = 1\n    LINE\n    return a\n', 'value = base', ' + extra', 'log(value)'],
  ['go', 'func f() {\n\ta := 1\n\tLINE\n\treturn\n}\n', 'value := base', ' + extra', 'log(value)'],
  ['kotlin', 'fun f() {\n    val a = 1\n    LINE\n    return\n}\n', 'val value = base', ' + extra', 'log(value)'],
  ['cpp', 'void f() {\n  int a = 1;\n  LINE\n  return;\n}\n', 'int value = base;', ' extra();', 'log(value);'],
  ['javascript', 'function f() {\n  let a = 1\n  LINE\n  return\n}\n', 'let value = base', ' + extra', 'log(value)'],
  ['yaml', 'f:\n  a: 1\n  LINE\n  b: 2\n', 'value: base', ' extra', 'log: value'],
  ['css', '.f {\n  a: 1;\n  LINE\n  b: 2;\n}\n', 'color: red', ' !important;', 'margin: 0;'],
  ['html', '<div>\n  <p>a</p>\n  LINE\n  <p>b</p>\n</div>\n', 'Some text', ' and more', '<br>'],
];

for (const [language, tpl, line, appended, add] of CASES) {
  test(`Н8 ${language}: upstream lengthened the anchor line — the insertion goes after it, not into it`, { todo: '07-findings Н8' }, async () => {
    const a = adapterForLanguage(language);
    await a.init();
    const indent = tpl.split('\n').find((l) => l.includes('LINE'))!.replace('LINE', '');
    const patch = patchOf(tpl.replace('LINE', line), tpl.replace('LINE', `${line}\n${indent}${add}`), a);
    const base = tpl.replace('LINE', line + appended);
    let got: string;
    try {
      got = applyAll(base, patch, a).source;
    } catch {
      return; // a refusal is no corruption
    }
    assert.equal(got, tpl.replace('LINE', `${line}${appended}\n${indent}${add}`));
  });
}
