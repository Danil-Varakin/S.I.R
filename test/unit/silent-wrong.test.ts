import { test } from 'node:test';
import assert from 'node:assert/strict';

import { adapterForLanguage } from '../../src/lang/adapter.ts';
import { patchOf } from '../matrix.ts';
import { applyAll } from '../../src/core/apply.ts';
import { tuneOne } from '../../bench/run.ts';
import { TUNE_FLAT, TUNE_SYNTAX } from '../../bench/corpus.ts';

// Patches that land with exit 0 and a result that is not the edit on upstream's file —
// found by looking for them on purpose (2026-10-21). What they share and where else to
// look: docs/11-silent-landings.md. Each runs as `todo` until the author decides; a
// refusal passes, a wrong result fails. The guards at the end are plain tests.

async function landsRightOrRefuses(language: string, oldText: string, newText: string, base: string, want: string): Promise<void> {
  const a = adapterForLanguage(language);
  await a.init();
  const patch = patchOf(oldText, newText, a);
  let got: string;
  try {
    got = applyAll(base, patch, a).source;
  } catch {
    return; // a refusal is no corruption
  }
  assert.equal(got, want);
}

// Н9: a deletion is written `>>> drop(); ... <<< b();` — the `...` inside the range takes
// whatever upstream wrote between the deleted line and the next anchor.
// [language, the file with X, the deleted line, the line upstream adds under it]
const DELETES: [string, string, string, string][] = [
  ['cpp', 'void f() {\n  a();\n  X\n  b();\n}\n', 'drop();', 'keep();'],
  ['java', 'class K {\n  void f() {\n    a();\n    X\n    b();\n  }\n}\n', 'drop();', 'keep();'],
  ['javascript', 'function f() {\n  a();\n  X\n  b();\n}\n', 'drop();', 'keep();'],
  ['typescript', 'function f(): void {\n  a();\n  X\n  b();\n}\n', 'drop();', 'keep();'],
  ['go', 'package main\n\nfunc f() {\n\ta()\n\tX\n\tb()\n}\n', 'drop()', 'keep()'],
  ['rust', 'fn f() {\n    a();\n    X\n    b();\n}\n', 'drop();', 'keep();'],
  ['kotlin', 'fun f() {\n    a()\n    X\n    b()\n}\n', 'drop()', 'keep()'],
  ['python', 'def f():\n    a()\n    X\n    b()\n', 'drop()', 'keep()'],
  ['css', '.f {\n  a: 1;\n  X\n  b: 2;\n}\n', 'drop: 1;', 'keep: 1;'],
  ['xml', '<r>\n  <a/>\n  X\n  <b/>\n</r>\n', '<drop/>', '<keep/>'],
  ['json', '{\n  "f": {\n    "a": 1,\n    X\n    "b": 2\n  }\n}\n', '"drop": 1,', '"keep": 1,'],
  ['yaml', 'f:\n  a: 1\n  X\n  b: 2\n', 'drop: 1', 'keep: 1'],
  ['shell', 'f() {\n  a\n  X\n  b\n}\n', 'drop', 'keep'],
  ['proto', 'message M {\n  int32 a = 1;\n  X\n  int32 b = 3;\n}\n', 'int32 drop = 2;', 'int32 keep = 4;'],
];

for (const [language, tpl, drop, keep] of DELETES) {
  test(`Н9 ${language}: a line deleted — the line upstream added under it stays`, { todo: '11-silent-landings Н9' }, async () => {
    const indent = tpl.split('\n').find((l) => l.includes('X'))!.replace('X', '');
    await landsRightOrRefuses(
      language,
      tpl.replace('X', drop),
      tpl.replace(`${indent}X\n`, ''),
      tpl.replace('X', `${drop}\n${indent}${keep}`),
      tpl.replace('X', keep),
    );
  });
}

test('Н9 cpp: the last line of a block deleted — what upstream appended to the block stays', { todo: '11-silent-landings Н9' }, async () => {
  await landsRightOrRefuses(
    'cpp',
    'void f() {\n  a();\n  drop();\n}\n',
    'void f() {\n  a();\n}\n',
    'void f() {\n  a();\n  drop();\n  keep();\n}\n',
    'void f() {\n  a();\n  keep();\n}\n',
  );
});

// Н5, what is left of it: a change that runs to the end of the file is written "from
// this text to the end", and takes the lines upstream appended.
test('Н5 cpp: the whole file deleted — the line upstream appended to it stays', { todo: '11-silent-landings Н5' }, async () => {
  await landsRightOrRefuses('cpp', 'void f() {\n  a();\n}\n', '', 'void f() {\n  a();\n}\nvoid g();\n', 'void g();\n');
});

// Н10: in Python the last line of a function deleted is written as the whole body —
// `def f(): >>> ... <<< def g():` with the body that is left as the patch — so whatever
// upstream changed anywhere in the function goes back to the old text.
test('Н10 python: the last line of a function deleted — upstream edits above it stay', { todo: '11-silent-landings Н10' }, async () => {
  await landsRightOrRefuses(
    'python',
    'def f():\n    a()\n    drop()\n\n\ndef g():\n    d()\n',
    'def f():\n    a()\n\n\ndef g():\n    d()\n',
    'def f():\n    setup()\n    a(fast=True)\n    drop()\n\n\ndef g():\n    d()\n',
    'def f():\n    setup()\n    a(fast=True)\n\n\ndef g():\n    d()\n',
  );
});

test('Н10 python: the last line of a method deleted — upstream edits above it stay', { todo: '11-silent-landings Н10' }, async () => {
  await landsRightOrRefuses(
    'python',
    'class K:\n    def f(self):\n        a()\n        b()\n        drop()\n\n    def g(self):\n        d()\n',
    'class K:\n    def f(self):\n        a()\n        b()\n\n    def g(self):\n        d()\n',
    'class K:\n    def f(self):\n        a()\n        b(1)\n        drop()\n\n    def g(self):\n        d()\n',
    'class K:\n    def f(self):\n        a()\n        b(1)\n\n    def g(self):\n        d()\n',
  );
});

// Н11: upstream took the same change (the patch went upstream). A clean base out of git
// holds it already, and the insertion is laid a second time.
// [language, the file with X, the inserted line]
const ADOPTED: [string, string, string][] = [
  ['cpp', 'void f(int x) {\n  a(x);\n  b(x);\nX  c(x);\n}\n', '  NEW(x);\n'],
  ['python', 'def f(x):\n    a(x)\n    b(x)\nX    c(x)\n', '    NEW(x)\n'],
  ['javascript', 'function f(x) {\n  a(x);\n  b(x);\nX  c(x);\n}\n', '  NEW(x);\n'],
  ['go', 'package main\n\nfunc f(x int) {\n\ta(x)\n\tb(x)\nX\tc(x)\n}\n', '\tNEW(x)\n'],
  ['yaml', 'f:\n  a: 1\n  b: 2\nX  c: 3\n', '  n: 9\n'],
  ['css', '.f {\n  a: 1;\n  b: 2;\nX  c: 3;\n}\n', '  n: 9;\n'],
  ['html', '<div id="f">\n  <p>a</p>\n  <p>b</p>\nX  <p>c</p>\n</div>\n', '  <p>n</p>\n'],
  ['json', '{\n  "f": {\n    "a": 1,\n    "b": 2,\nX    "c": 3\n  }\n}\n', '    "n": 9,\n'],
];

for (const [language, tpl, line] of ADOPTED) {
  test(`Н11 ${language}: upstream already holds the change — it is not laid twice`, { todo: '11-silent-landings Н11' }, async () => {
    const result = tpl.replace('X', line);
    await landsRightOrRefuses(language, tpl.replace('X', ''), result, result, result);
  });
}

// Н12: upstream keeps the old code in a branch the build does not take and changes the
// live copy; the patch lands in the dead one. `git apply` does the same.
const F_OLD = 'void f(int x) {\n  a(x);\n  b(x);\n  c(x);\n}\n';
const F_NEW = 'void f(int x) {\n  a(x);\n  b(x);\n  NEW(x);\n  c(x);\n}\n';

test('Н12 cpp: the old copy under #if 0 — the patch does not land in it', { todo: '11-silent-landings Н12' }, async () => {
  const base = `#if 0\n${F_OLD}#endif\n\nvoid f2(int x) {\n  a2(x);\n}\n`;
  await landsRightOrRefuses('cpp', F_OLD, F_NEW, base, '(refused)');
});

test('Н12 cpp: the old copy in #else, the live one changed — the patch does not land in it', { todo: '11-silent-landings Н12' }, async () => {
  const base = `#if BUILDFLAG(NEW_PATH)\nvoid f(int x) {\n  a(x);\n  b2(x);\n  c(x);\n}\n#else\n${F_OLD}#endif\n`;
  await landsRightOrRefuses('cpp', F_OLD, F_NEW, base, '(refused)');
});

// ── the family of the next unit (11-silent-landings.md, Ф1) ─────────────────────────
// A pattern leans on the first line of the unit after the target — Python's closer,
// or a neighbour below where nothing is a block. The unit changes its place among its
// neighbours, and the patch lands where that line now follows another. Held as a set by
// tuning.test.ts and tuning-flat.test.ts; here one case per language, as `todo`.

const FAMILY: [string, string][] = [
  ['python', 'move-first'],
  ['yaml', 'move-first'],
  ['toml', 'move-first'],
  ['text', 'move-first'],
  ['shell-if', 'move-first'],
  ['html-script', 'move-first'],
];

for (const [form, drift] of FAMILY) {
  test(`Ф1 ${form}: the unit moved to the start of the file — the patch does not land in another`, { todo: '11-silent-landings Ф1' }, async () => {
    const syntax = TUNE_SYNTAX[form] ?? TUNE_FLAT[form]!;
    await adapterForLanguage(syntax.language).init();
    let wrong = 0;
    for (const depth of [1, 2]) {
      for (const regime of ['repeat', 'clone'] as const) {
        for (const at of ['middle', 'end'] as const) {
          const c = await tuneOne(form, { units: 8, depth, regime, at }, {}, 20_000);
          if (c.drifts.get(drift) === 'WRONG') wrong++;
        }
      }
    }
    assert.equal(wrong, 0);
  });
}

// Ф3, `wrap` — a question of intent, not settled (BACKLOG §1, 🔬): a line appended at the
// end of a function lands after a block upstream wrapped the body in, not after the line
// it followed. Held `todo` so that the decision, either way, shows here.
test('Ф3 cpp: the body wrapped in a new block — a line appended at the end stays after its line', { todo: '11-silent-landings Ф3, the author decides' }, async () => {
  await adapterForLanguage('cpp').init();
  const c = await tuneOne('cpp', { units: 8, depth: 1, regime: 'repeat', at: 'end' }, {}, 20_000);
  assert.notEqual(c.drifts.get('wrap'), 'WRONG');
});

// ── the structure lost (Н13) ───────────────────────────────────────────────────────
// A bracket that opens and never closes, where the reading cannot tell it is no structure,
// leaves the unit without blocks: its closers guard nothing, and a pattern whose target is
// gone there finds the same lines in the next unit. f lost its anchor `a`; g still has it.

test('Н13 cpp: #if / #else each opening a `{` — the patch does not move to the next function', { todo: '11-silent-landings Н13' }, async () => {
  const unit = (name: string, extra: string, body: string): string => `void ${name}(int x) {\n${extra}  if (x) {\n${body}  }\n}\n`;
  const ab = '    a(x);\n    b(x);\n';
  const split = '#if BUILDFLAG(A)\n  if (y) {\n#else\n  if (z) {\n#endif\n    c(x);\n  }\n';
  await landsRightOrRefuses(
    'cpp',
    `${unit('f', '', ab)}\n${unit('g', '', ab)}`,
    `${unit('f', '', '    a(x);\n    NEW(x);\n    b(x);\n')}\n${unit('g', '', ab)}`,
    `${unit('f', split, '    a2(x);\n    b(x);\n')}\n${unit('g', '', ab)}`,
    '(refused)',
  );
});

// [language, a section with EXTRA, the line upstream writes as EXTRA]
const UNCLOSED: [string, (name: string, extra: string, body: string) => string, string, string][] = [
  ['text', (n, e, b) => `section ${n} {\n${e}  when on {\n${b}  }\n}\n`, '  see (note\n', 'prose with an opening bracket'],
  ['shell', (n, e, b) => `${n}() {\n${e}  if [ -n "$on" ]; then {\n${b}  }; fi\n}\n`, '  cat <<EOF\n  {\nEOF\n', 'a brace inside a heredoc'],
  ['shell', (n, e, b) => `${n}() {\n${e}  if [ -n "$on" ]; then {\n${b}  }; fi\n}\n`, '  echo $(( 1 + (2 ))\n', '`$((` closed by `))` split across brackets'],
];

for (const [language, unit, extra, what] of UNCLOSED) {
  test(`Н13 ${language}: ${what} — the patch does not move to the next section`, { todo: '11-silent-landings Н13' }, async () => {
    const ab = '    alpha\n    beta\n';
    await landsRightOrRefuses(
      language,
      `${unit('f', '', ab)}\n${unit('g', '', ab)}`,
      `${unit('f', '', '    alpha\n    added\n    beta\n')}\n${unit('g', '', ab)}`,
      `${unit('f', extra, '    alpha2\n    beta\n')}\n${unit('g', '', ab)}`,
      '(refused)',
    );
  });
}

// ── guards: places looked at on purpose that refuse or land right today ──────────────
// (11-silent-landings.md, «Проверено — громко или верно»). A change that makes one of
// them land wrong fails here.

test('guard: a copy of the function in a comment or a string — refused, not landed in', async () => {
  const fOld = 'void f(int x) {\n  a(x);\n  b(x);\n  c(x);\n}\n';
  const fNew = 'void f(int x) {\n  a(x);\n  b(x);\n  NEW(x);\n  c(x);\n}\n';
  const live = '\nvoid f2(int x) {\n  a2(x);\n}\n';
  for (const base of [
    `// void f(int x) {\n//   a(x);\n//   b(x);\n//   c(x);\n// }\n${live}`,
    `/*\n${fOld}*/\n${live}`,
  ]) {
    await landsRightOrRefuses('cpp', fOld, fNew, base, '(refused)');
  }
  await landsRightOrRefuses(
    'python',
    'def f(x):\n    a(x)\n    b(x)\n    c(x)\n',
    'def f(x):\n    a(x)\n    b(x)\n    NEW(x)\n    c(x)\n',
    'EXAMPLE = """\ndef f(x):\n    a(x)\n    b(x)\n    c(x)\n"""\n\n\ndef f2(x):\n    a2(x)\n',
    '(refused)',
  );
});

test('guard: the replaced line changed upstream, or a line came into a deleted range — refused', async () => {
  const old = 'void f() {\n  a();\n  foo(x, y);\n  b();\n}\n';
  const changed = 'void f() {\n  a();\n  foo(x, y, w);\n  b();\n}\n';
  await landsRightOrRefuses('cpp', old, 'void f() {\n  a();\n  foo(x, z);\n  b();\n}\n', changed, '(refused)');
  await landsRightOrRefuses('cpp', old, 'void f() {\n  a();\n  b();\n}\n', changed, '(refused)');
  const body = Array.from({ length: 12 }, (_, i) => `  s${i}();`);
  await landsRightOrRefuses(
    'cpp',
    ['void f() {', ...body, '}', ''].join('\n'),
    ['void f() {', body[0], body[11], '}', ''].join('\n'),
    ['void f() {', ...body.slice(0, 6), '  added();', ...body.slice(6), '}', ''].join('\n'),
    '(refused)',
  );
});

test('guard: a later hunk whose anchor upstream removed does not settle on what an earlier hunk wrote', async () => {
  await landsRightOrRefuses('yaml', 'f:\n  a: 1\ng:\n  log: 1\n  b: 2\n', 'f:\n  a: 1\n  log: 1\ng:\n  log: 1\n  x: 2\n  b: 2\n', 'f:\n  a: 1\ng:\n  b: 2\n', '(refused)');
  await landsRightOrRefuses(
    'cpp',
    '#include "a.h"\n#include "c.h"\n\nint v;\n#include "b.h"\n#include "e.h"\n',
    '#include "a.h"\n#include "b.h"\n#include "c.h"\n\nint v;\n#include "b.h"\n#include "d.h"\n#include "e.h"\n',
    '#include "a.h"\n#include "c.h"\n\nint v;\n#include "e.h"\n',
    '(refused)',
  );
});

test('guard: the closer a block owes is taken before a `}` in a comment after it', async () => {
  await landsRightOrRefuses(
    'cpp',
    'void f() {\n  a();\n}\n// }\n',
    'void f() {\n  a();\n  NEW();\n}\n// }\n',
    'void f() {\n  a();\n  b();\n}\n// }\n',
    'void f() {\n  a();\n  b();\n  NEW();\n}\n// }\n',
  );
});

test('guard: a closer bracket with no opener in text — the section keeps its blocks', async () => {
  const t = (n: string, e: string, b: string): string => `section ${n} {\n${e}  when on {\n${b}  }\n}\n`;
  const ab = '    alpha\n    beta\n';
  for (const extra of ['  1) first step\n', '  smile :)\n']) {
    await landsRightOrRefuses(
      'text',
      `${t('f', '', ab)}\n${t('g', '', ab)}`,
      `${t('f', '', '    alpha\n    added\n    beta\n')}\n${t('g', '', ab)}`,
      `${t('f', extra, '    alpha2\n    beta\n')}\n${t('g', '', ab)}`,
      '(refused)',
    );
  }
});
