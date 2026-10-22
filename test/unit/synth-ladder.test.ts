import { test } from 'node:test';
import assert from 'node:assert/strict';

import { anchorFailure, moreInformative, synthesize } from '../../src/generate/synth.ts';
import type { PartialLimits } from '../../src/generate/synth.ts';
import { printPattern } from '../../src/core/hatch-printer.ts';
import { adapterForLanguage } from '../../src/lang/adapter.ts';
import type { LanguageAdapter } from '../../src/lang/source-map.ts';
import type { MatchPattern } from '../../src/core/ast.ts';
import { AmbiguityError, MatchError, SynthesisError } from '../../src/core/errors.ts';

// The candidate ladder, as the tracer (`--debug`) tells it: which patterns synthesis tries
// for a change, in what order, and which it keeps. A round trip cannot see any of this —
// any pattern that lands gives the same text — so a change to the order, to a cut form or
// to when a rung is given up shows here and nowhere else.
//
// One line per attempt: its result, then the pattern on one line (`⏎` between its lines).
// `unique` is the matcher's word — the pattern fits once; whether it reproduces the change
// is checked after, so a unique attempt may still be passed over. An attempt the ladder
// repeats is answered from what it got the first time and not traced again.

const adapters = new Map<string, LanguageAdapter>();
async function adapterFor(language: string): Promise<LanguageAdapter> {
  let a = adapters.get(language);
  if (a === undefined) {
    a = adapterForLanguage(language);
    await a.init();
    adapters.set(language, a);
  }
  return a;
}

const oneLine = (p: MatchPattern): string => printPattern(p).split('\n').map((l) => l.trim()).join(' ⏎ ');

/** What synthesis tried for the one change between `oldText` and `newText`, and what it kept. */
async function ladder(language: string, oldText: string, newText: string, limits: PartialLimits = {}): Promise<string[]> {
  const adapter = await adapterFor(language);
  const out: string[] = [];
  try {
    synthesize(oldText, newText, adapter, {
      exact: true,
      limits,
      trace: (e) => {
        if (e.kind === 'attempt') out.push(`${e.result} ${oneLine(e.pattern)}`);
        if (e.kind === 'hunk') out.push(`KEPT ${oneLine(e.pattern)}`);
      },
    });
  } catch (e) {
    assert.ok(e instanceof SynthesisError, `${(e as Error).name}: ${(e as Error).message}`);
    out.push(`FAILED ${e.reason}: ${e.message}`);
  }
  return out;
}

const BODY = 'void f() {\n  a();\n  b();\n}\n';

// ── insertions: to the left first, to the right first at the end of a block ────────

test('ladder: an insertion inside a block leans on the line above it — the header alone does not place it', async () => {
  assert.deepEqual(await ladder('cpp', BODY, 'void f() {\n  a();\n  x();\n  b();\n}\n'), [
    'unique ... ⏎ void f() { ⏎ >>> ⏎ ... ⏎ } ⏎ ...',
    'unique ... ⏎ void f() { ⏎ >>> ⏎ ... ⏎ b(); ⏎ ... ⏎ } ⏎ ...',
    'unique ... ⏎ void f() { ⏎ ... ⏎ a(); ⏎ >>> ⏎ ... ⏎ } ⏎ ...',
    'KEPT ... ⏎ void f() { ⏎ ... ⏎ a(); ⏎ >>> ⏎ ... ⏎ } ⏎ ...',
  ]);
});

test('ladder: an insertion at the end of a block is tried against its } first, and that is enough', async () => {
  assert.deepEqual(await ladder('cpp', BODY, 'void f() {\n  a();\n  b();\n  x();\n}\n'), [
    'unique ... ⏎ void f() { ⏎ ... ⏎ >>> ⏎ } ⏎ ...',
    'KEPT ... ⏎ void f() { ⏎ ... ⏎ >>> ⏎ } ⏎ ...',
  ]);
});

test('ladder: an insertion at the end of the file needs nothing but the end', async () => {
  assert.deepEqual(await ladder('cpp', 'int x;\nint y;\n', 'int x;\nint y;\nint z;\n'), ['unique ... ⏎ >>>', 'KEPT ... ⏎ >>>']);
});

// ── replacements: the cut forms in their order ───────────────────────────────────────

test('ladder: a deeper indent keeps the exact cut — the new line still starts with the old indent', async () => {
  // the exact cut skips to the removed line (`... >>>`); the context cut sits tight on what precedes it
  assert.deepEqual(await ladder('cpp', BODY, 'void f() {\n    a();\n  b();\n}\n'), [
    'unique ... ⏎ void f() { ⏎ ... ⏎ >>> ⏎ a(); ⏎ <<< ⏎ ... ⏎ } ⏎ ...',
    'KEPT ... ⏎ void f() { ⏎ ... ⏎ >>> ⏎ a(); ⏎ <<< ⏎ ... ⏎ } ⏎ ...',
  ]);
});

test('ladder: a shallower indent has no exact cut — it starts at the context cut, tight on the header', async () => {
  assert.deepEqual(await ladder('cpp', 'void f() {\n    a();\n  b();\n}\n', 'void f() {\n  a();\n  b();\n}\n'), [
    'unique ... ⏎ void f() { ⏎ >>> ⏎ a(); ⏎ ... ⏎ <<< ⏎ b(); ⏎ ... ⏎ } ⏎ ...',
    'KEPT ... ⏎ void f() { ⏎ >>> ⏎ a(); ⏎ ... ⏎ <<< ⏎ b(); ⏎ ... ⏎ } ⏎ ...',
  ]);
});

test('ladder: trailing spaces dropped from a line — no exact cut either', async () => {
  assert.deepEqual(await ladder('cpp', 'void f() {\n  a();  \n  b();\n}\n', BODY), [
    'unique ... ⏎ void f() { ⏎ >>> ⏎ a(); ⏎ ... ⏎ <<< ⏎ b(); ⏎ ... ⏎ } ⏎ ...',
    'KEPT ... ⏎ void f() { ⏎ >>> ⏎ a(); ⏎ ... ⏎ <<< ⏎ b(); ⏎ ... ⏎ } ⏎ ...',
  ]);
});

test('ladder: the first line of a file is anchored on itself, with no parent to lean on', async () => {
  assert.deepEqual(await ladder('cpp', '#include "a.h"\nint x;\nint y;\n', '#include "b.h"\nint x;\nint y;\n'), [
    'unique ... ⏎ >>> ⏎ #include "a.h" ⏎ <<< ⏎ ...',
    'KEPT ... ⏎ >>> ⏎ #include "a.h" ⏎ <<< ⏎ ...',
  ]);
});

test('ladder: a change of the whole file spells what it replaces — a span with no literal fits every file (Н5)', async () => {
  assert.deepEqual(await ladder('cpp', 'int x;\n', 'long x;\n'), ['unique ... ⏎ >>> ⏎ int x; ⏎ <<< ⏎ ...', 'KEPT ... ⏎ >>> ⏎ int x; ⏎ <<< ⏎ ...']);
});

test('ladder: a file of blank lines has nothing to spell — its span stays bare', async () => {
  assert.deepEqual(await ladder('cpp', '\n\n\n\n', '\n\n\n'), ['unique >>> ⏎ ... ⏎ <<<', 'KEPT >>> ⏎ ... ⏎ <<<']);
});

test('ladder: an insertion between two lines of no block leans on the line above', async () => {
  assert.deepEqual(await ladder('cpp', 'int a;\nint b;\nint c;\n', 'int a;\nint b;\nint x;\nint c;\n'), [
    'unique ... ⏎ int b; ⏎ >>> ⏎ ...',
    'KEPT ... ⏎ int b; ⏎ >>> ⏎ ...',
  ]);
});

test('ladder: an insertion before the first line is the start of the file', async () => {
  assert.deepEqual(await ladder('cpp', 'int a;\nint b;\n', 'int z;\nint a;\nint b;\n'), ['unique >>> ⏎ ...', 'KEPT >>> ⏎ ...']);
});

test('ladder: a deleted line between two of no block is cut from the line above to the line below', async () => {
  assert.deepEqual(await ladder('cpp', 'int a;\nint b;\nint c;\n', 'int a;\nint c;\n'), [
    'unique ... ⏎ int a; ⏎ >>> ⏎ int b; ⏎ ... ⏎ <<< ⏎ int c; ⏎ ...',
    'KEPT ... ⏎ int a; ⏎ >>> ⏎ int b; ⏎ ... ⏎ <<< ⏎ int c; ⏎ ...',
  ]);
});

test('ladder: the first line, repeated further down, is told apart by the line below it', async () => {
  assert.deepEqual(await ladder('cpp', 'go();\nx();\ngo();\n', 'stop();\nx();\ngo();\n'), [
    'ambiguous ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ...',
    'unique ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ x(); ⏎ ...',
    'KEPT ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ x(); ⏎ ...',
  ]);
});

test('ladder: the last line, repeated further up, is told apart by the line above it', async () => {
  assert.deepEqual(await ladder('cpp', 'go();\nx();\ngo();\n', 'go();\nx();\nstop();\n'), [
    'ambiguous ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ...',
    'unique ... ⏎ x(); ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ...',
    'KEPT ... ⏎ x(); ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ...',
  ]);
});

test('ladder: in Python the closer of a function is the next line at its level', async () => {
  const old = 'def a():\n    x = 1\n    return x\n\n\ndef b():\n    x = 1\n    return 2\n';
  assert.deepEqual(await ladder('python', old, old.replace('    x = 1\n    return x', '    x = 5\n    return x')), [
    'unique ... ⏎ def a(): ⏎ ... ⏎ >>> ⏎ x = 1 ⏎ <<< ⏎ ... ⏎ def b(): ⏎ ...',
    'KEPT ... ⏎ def a(): ⏎ ... ⏎ >>> ⏎ x = 1 ⏎ <<< ⏎ ... ⏎ def b(): ⏎ ...',
  ]);
});

test('ladder: the first of two pairs of lines is told apart by the start of the second pair below it', async () => {
  assert.deepEqual(await ladder('cpp', 'go();\nx();\ngo();\nx();\n', 'stop();\nx();\ngo();\nx();\n'), [
    'ambiguous ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ...',
    'ambiguous ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ x(); ⏎ ...',
    'unique ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ x(); ⏎ go(); ⏎ ...',
    'KEPT ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ x(); ⏎ go(); ⏎ ...',
  ]);
});

test('ladder: blank lines deleted at the start of the file — nothing to anchor on but the start and the line after', async () => {
  assert.deepEqual(await ladder('cpp', '\n\nint a;\nint b;\n', 'int a;\nint b;\n'), [
    'unique >>> ⏎ ... ⏎ <<< ⏎ int a; ⏎ ...',
    'KEPT >>> ⏎ ... ⏎ <<< ⏎ int a; ⏎ ...',
  ]);
});

test('ladder: blank lines replaced by a line at the start of the file — the same span', async () => {
  assert.deepEqual(await ladder('cpp', '\n\nint a;\n', 'int z;\nint a;\n'), [
    'unique >>> ⏎ ... ⏎ <<< ⏎ int a; ⏎ ...',
    'KEPT >>> ⏎ ... ⏎ <<< ⏎ int a; ⏎ ...',
  ]);
});

test('ladder: blank lines deleted at the end of the file — the line before and the end', async () => {
  assert.deepEqual(await ladder('cpp', 'int a;\nint b;\n\n\n', 'int a;\nint b;\n'), [
    'unique ... ⏎ int b; ⏎ >>> ⏎ ... ⏎ <<<',
    'KEPT ... ⏎ int b; ⏎ >>> ⏎ ... ⏎ <<<',
  ]);
});

test('ladder: in the last function of a Python file there is no closer — the end of the file closes it', async () => {
  const old = 'def a():\n    x = 1\n    return x\n\n\ndef b():\n    x = 1\n    return 2\n';
  assert.deepEqual(await ladder('python', old, old.replace('    x = 1\n    return 2', '    x = 7\n    return 2')), [
    'unique ... ⏎ def b(): ⏎ ... ⏎ >>> ⏎ x = 1 ⏎ <<< ⏎ ...',
    'KEPT ... ⏎ def b(): ⏎ ... ⏎ >>> ⏎ x = 1 ⏎ <<< ⏎ ...',
  ]);
});

// Blocks that end where the block inside them ends share its closer: in Python an `if` and
// its `def` are both closed by the next line at the `def`'s level, and that line is written
// once — a second copy would have to be another line, and the pattern would fit nowhere.
// In C++ every block has its own `}`. docs/07-findings.md, С5.
const HANDLERS = [1, 2, 3]
  .map((n) => `class Handler${n}:\n    def register(self, opts):\n        if opts.enabled:\n            for item in opts.items:\n                self.add(item)\n    def size(self):\n        return ${n}\n`)
  .join('\n');

test('ladder: in Python two parents closed by one line write that line once', async () => {
  const at = 'class Handler2:\n    def register(self, opts):\n        if opts.enabled:\n            for item in opts.items:';
  assert.deepEqual(await ladder('python', HANDLERS, HANDLERS.replace(at, at.replace('opts.items', 'opts.values'))), [
    'ambiguous ... ⏎ if opts.enabled: ⏎ ... ⏎ >>> ⏎ for item in opts.items: ⏎ <<< ⏎ ... ⏎ def size(self): ⏎ ...',
    'ambiguous ... ⏎ def register( ⏎ ... ⏎ ): ⏎ ... ⏎ if opts.enabled: ⏎ ... ⏎ >>> ⏎ for item in opts.items: ⏎ <<< ⏎ ... ⏎ def size(self): ⏎ ...',
    'unique ... ⏎ class Handler2: ⏎ ... ⏎ def register( ⏎ ... ⏎ ): ⏎ ... ⏎ if opts.enabled: ⏎ ... ⏎ >>> ⏎ for item in opts.items: ⏎ <<< ⏎ ... ⏎ def size(self): ⏎ ... ⏎ class Handler3: ⏎ ...',
    'KEPT ... ⏎ class Handler2: ⏎ ... ⏎ def register( ⏎ ... ⏎ ): ⏎ ... ⏎ if opts.enabled: ⏎ ... ⏎ >>> ⏎ for item in opts.items: ⏎ <<< ⏎ ... ⏎ def size(self): ⏎ ... ⏎ class Handler3: ⏎ ...',
  ]);
});

test('ladder: in C++ nested blocks each write their own }', async () => {
  const old = [1, 2, 3]
    .map((n) => `struct H${n} {\n  void reg(Opts opts) {\n    if (opts.enabled) {\n      for (auto item : opts.items) add(item);\n    }\n  }\n  int size() { return ${n}; }\n};\n`)
    .join('\n');
  const at = 'struct H2 {\n  void reg(Opts opts) {\n    if (opts.enabled) {\n      for (auto item : opts.items)';
  assert.deepEqual(await ladder('cpp', old, old.replace(at, at.replace('opts.items', 'opts.values'))), [
    'ambiguous ... ⏎ if ( ⏎ ... ⏎ ) { ⏎ ... ⏎ >>> ⏎ for (auto item : opts.items) add(item); ⏎ <<< ⏎ ... ⏎ } ⏎ ...',
    'ambiguous ... ⏎ void reg( ⏎ ... ⏎ ) { ⏎ ... ⏎ if ( ⏎ ... ⏎ ) { ⏎ ... ⏎ >>> ⏎ for (auto item : opts.items) add(item); ⏎ <<< ⏎ ... ⏎ } ⏎ ... ⏎ } ⏎ ...',
    'unique ... ⏎ struct H2 { ⏎ ... ⏎ void reg( ⏎ ... ⏎ ) { ⏎ ... ⏎ if ( ⏎ ... ⏎ ) { ⏎ ... ⏎ >>> ⏎ for (auto item : opts.items) add(item); ⏎ <<< ⏎ ... ⏎ } ⏎ ... ⏎ } ⏎ ... ⏎ } ⏎ ...',
    'KEPT ... ⏎ struct H2 { ⏎ ... ⏎ void reg( ⏎ ... ⏎ ) { ⏎ ... ⏎ if ( ⏎ ... ⏎ ) { ⏎ ... ⏎ >>> ⏎ for (auto item : opts.items) add(item); ⏎ <<< ⏎ ... ⏎ } ⏎ ... ⏎ } ⏎ ... ⏎ } ⏎ ...',
  ]);
});

// ── an ambiguity: the brackets are spelled, the header widened, the neighbours taken ──

test('ladder: two overloads with the same body — the generalized ( ... ) is spelled out', async () => {
  const old = 'void f(int a) {\n  go();\n}\nvoid f(long a) {\n  go();\n}\n';
  assert.deepEqual(await ladder('cpp', old, old.replace('long a) {\n  go();', 'long a) {\n  stop();')), [
    'ambiguous ... ⏎ void f( ⏎ ... ⏎ ) { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ...',
    'unique ... ⏎ void f(long a) { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ...',
    'KEPT ... ⏎ void f(long a) { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ...',
  ]);
});

test('ladder: the same function in two blocks of one name — the outer header is widened to what tells them apart', async () => {
  const old = 'namespace a {\nint x;\nvoid f() {\n  go();\n}\n}\nnamespace a {\nint y;\nvoid f() {\n  go();\n}\n}\n';
  assert.deepEqual(await ladder('cpp', old, old.replace('int y;\nvoid f() {\n  go();', 'int y;\nvoid f() {\n  stop();')), [
    'ambiguous ... ⏎ void f() { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ...',
    'ambiguous ... ⏎ namespace a { ⏎ ... ⏎ void f() { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ... ⏎ } ⏎ ...',
    'unique ... ⏎ namespace a { ⏎ int y; ⏎ ... ⏎ void f() { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ... ⏎ } ⏎ ...',
    'KEPT ... ⏎ namespace a { ⏎ int y; ⏎ ... ⏎ void f() { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ... ⏎ } ⏎ ...',
  ]);
});

test('ladder: the line below does not tell two copies apart, the parentless rung neither — the next cut takes the line above', async () => {
  const old = 'void f() {\n  go();\n  left();\n  go();\n  right();\n}\n';
  assert.deepEqual(await ladder('cpp', old, old.replace('  go();\n  right();', '  stop();\n  right();')), [
    'ambiguous ... ⏎ void f() { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ...',
    'ambiguous ... ⏎ void f() { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ right(); ⏎ ... ⏎ } ⏎ ...',
    'ambiguous ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ...',
    'unique ... ⏎ void f() { ⏎ ... ⏎ left(); ⏎ >>> ⏎ go(); ⏎ ... ⏎ <<< ⏎ right(); ⏎ ... ⏎ } ⏎ ...',
    'KEPT ... ⏎ void f() { ⏎ ... ⏎ left(); ⏎ >>> ⏎ go(); ⏎ ... ⏎ <<< ⏎ right(); ⏎ ... ⏎ } ⏎ ...',
  ]);
});

test('ladder: the last of two copies is told apart by the line above it', async () => {
  const old = 'void f() {\n  left();\n  go();\n  right();\n  go();\n}\n';
  assert.deepEqual(await ladder('cpp', old, old.replace('  right();\n  go();', '  right();\n  stop();')), [
    'ambiguous ... ⏎ void f() { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ...',
    'ambiguous ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ...',
    'unique ... ⏎ void f() { ⏎ ... ⏎ right(); ⏎ >>> ⏎ go(); ⏎ ... ⏎ <<< ⏎ } ⏎ ...',
    'KEPT ... ⏎ void f() { ⏎ ... ⏎ right(); ⏎ >>> ⏎ go(); ⏎ ... ⏎ <<< ⏎ } ⏎ ...',
  ]);
});

test('ladder: nested brackets — the innermost that differs is spelled, and the brackets around it with it', async () => {
  const old =
    'void f(Map<int, std::function<void(int)>> m, int n) {\n  go();\n}\n' +
    'void f(Map<int, std::function<void(long)>> m, int n) {\n  go();\n}\n';
  assert.deepEqual(await ladder('cpp', old, old.replace('long)>> m, int n) {\n  go();', 'long)>> m, int n) {\n  stop();')), [
    'ambiguous ... ⏎ void f( ⏎ ... ⏎ ) { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ...',
    'unique ... ⏎ void f(Map<int, std::function<void(long)>> m, int n) { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ...',
    'KEPT ... ⏎ void f(Map<int, std::function<void(long)>> m, int n) { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ...',
  ]);
});

test('ladder: neighbours are counted in lines that are not blank', async () => {
  const old = 'void f() {\n  go();\n\n  left();\n\n  go();\n\n  right();\n  go();\n}\n';
  assert.deepEqual(await ladder('cpp', old, old.replace('  go();\n\n  right();', '  stop();\n\n  right();')), [
    'ambiguous ... ⏎ void f() { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ...',
    'ambiguous ... ⏎ void f() { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ right(); ⏎ ... ⏎ } ⏎ ...',
    'ambiguous ... ⏎ void f() { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ right(); ⏎ go(); ⏎ ... ⏎ } ⏎ ...',
    'ambiguous ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ...',
    'unique ... ⏎ void f() { ⏎ ... ⏎ left(); ⏎ >>> ⏎ go(); ⏎ ... ⏎ <<< ⏎ right(); ⏎ ... ⏎ } ⏎ ...',
    'KEPT ... ⏎ void f() { ⏎ ... ⏎ left(); ⏎ >>> ⏎ go(); ⏎ ... ⏎ <<< ⏎ right(); ⏎ ... ⏎ } ⏎ ...',
  ]);
});

test('ladder: with one neighbour a side, a copy told apart only by both is found at distance two', async () => {
  const old = 'void f() {\n  a();\n  go();\n  b();\n  d();\n  go();\n  b();\n  a();\n  go();\n  c();\n}\n';
  assert.deepEqual(await ladder('cpp', old, old.replace('  a();\n  go();\n  b();', '  a();\n  stop();\n  b();'), { maxSiblings: 1 }), [
    'ambiguous ... ⏎ void f() { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ...',
    'ambiguous ... ⏎ void f() { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ b(); ⏎ ... ⏎ } ⏎ ...',
    'ambiguous ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ...',
    'ambiguous ... ⏎ void f() { ⏎ ... ⏎ a(); ⏎ >>> ⏎ go(); ⏎ ... ⏎ <<< ⏎ b(); ⏎ ... ⏎ } ⏎ ...',
    'ambiguous ... ⏎ void f() { ⏎ ... ⏎ >>> ⏎ go(); ⏎ ... ⏎ <<< ⏎ b(); ⏎ ... ⏎ } ⏎ ...',
    'ambiguous ... ⏎ void f() { ⏎ ... ⏎ a(); ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ...',
    'unique ... ⏎ void f() { ⏎ ... ⏎ a(); ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ b(); ⏎ ... ⏎ } ⏎ ...',
    'KEPT ... ⏎ void f() { ⏎ ... ⏎ a(); ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ b(); ⏎ ... ⏎ } ⏎ ...',
  ]);
});

// The lower neighbour stands after `...` — `a(); >>> go(); ... <<< b();` — and so fits
// any `b();` further down too. When nothing is left to spell or widen, the rung tries
// the neighbour pressed right against the change. docs/07-findings.md, С2.
test('ladder: a copy told apart only by both neighbours right next to it — the lower one is pressed close', async () => {
  const old = 'void f() {\n  a();\n  go();\n  b();\n  a();\n  go();\n  c();\n  d();\n  go();\n  b();\n}\n';
  const lines = await ladder('cpp', old, old.replace('  a();\n  go();\n  b();', '  a();\n  stop();\n  b();'), { maxSiblings: 1 });
  assert.equal(lines.at(-1), 'KEPT ... ⏎ void f() { ⏎ ... ⏎ a(); ⏎ >>> ⏎ go(); ⏎ <<< ⏎ b(); ⏎ ... ⏎ } ⏎ ...');
});

// Two parents with a bracket each to spell: the outer is offered first. The move taken is
// the one that cuts the most places; of two that cut as many, the narrower bracket; of two
// alike in both, the first offered.
const NESTED = (outer: [string, string, string], inner: [string, string, string], extra = ''): string =>
  [0, 1, 2]
    .map((k) => `function a(${outer[k]}) {\n  function b(${inner[k]}) {\n    go();\n  }\n}\n`)
    .join('') + extra;
const nestedLadder = async (old: string): Promise<string[]> =>
  ladder('javascript', old, old.replace('    go();', '    stop();'), { maxSiblings: 0 });

test('ladder: two brackets that cut as many places and are as wide — the first offered, the outer, is spelled first', async () => {
  assert.deepEqual(await nestedLadder(NESTED(['p', 'p', 's'], ['q', 'r', 'q'])), [
    'ambiguous ... ⏎ function b( ⏎ ... ⏎ ) { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ...',
    'ambiguous ... ⏎ function b(q) { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ...',
    'ambiguous ... ⏎ function a( ⏎ ... ⏎ ) { ⏎ ... ⏎ function b( ⏎ ... ⏎ ) { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ... ⏎ } ⏎ ...',
    'ambiguous ... ⏎ function a(p) { ⏎ ... ⏎ function b( ⏎ ... ⏎ ) { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ... ⏎ } ⏎ ...',
    'unique ... ⏎ function a(p) { ⏎ ... ⏎ function b(q) { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ... ⏎ } ⏎ ...',
    'KEPT ... ⏎ function a(p) { ⏎ ... ⏎ function b(q) { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ... ⏎ } ⏎ ...',
  ]);
});

test('ladder: two brackets that cut as many places — the narrower, the inner, is spelled first', async () => {
  assert.deepEqual(await nestedLadder(NESTED(['pp', 'pp', 'ss'], ['q', 'r', 'q'])), [
    'ambiguous ... ⏎ function b( ⏎ ... ⏎ ) { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ...',
    'ambiguous ... ⏎ function b(q) { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ...',
    'ambiguous ... ⏎ function a( ⏎ ... ⏎ ) { ⏎ ... ⏎ function b( ⏎ ... ⏎ ) { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ... ⏎ } ⏎ ...',
    'ambiguous ... ⏎ function a( ⏎ ... ⏎ ) { ⏎ ... ⏎ function b(q) { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ... ⏎ } ⏎ ...',
    'unique ... ⏎ function a(pp) { ⏎ ... ⏎ function b(q) { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ... ⏎ } ⏎ ...',
    'KEPT ... ⏎ function a(pp) { ⏎ ... ⏎ function b(q) { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ... ⏎ } ⏎ ...',
  ]);
});

test('ladder: the bracket that cuts more places is spelled first, though offered second', async () => {
  const lone = 'function b(r) {\n  go();\n}\n';
  assert.deepEqual(await nestedLadder(NESTED(['p', 'p', 's'], ['q', 'r', 'q'], lone + lone)), [
    'ambiguous ... ⏎ function b( ⏎ ... ⏎ ) { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ...',
    'ambiguous ... ⏎ function b(q) { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ...',
    'ambiguous ... ⏎ function a( ⏎ ... ⏎ ) { ⏎ ... ⏎ function b( ⏎ ... ⏎ ) { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ... ⏎ } ⏎ ...',
    'ambiguous ... ⏎ function a( ⏎ ... ⏎ ) { ⏎ ... ⏎ function b(q) { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ... ⏎ } ⏎ ...',
    'unique ... ⏎ function a(p) { ⏎ ... ⏎ function b(q) { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ... ⏎ } ⏎ ...',
    'KEPT ... ⏎ function a(p) { ⏎ ... ⏎ function b(q) { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ... ⏎ } ⏎ ...',
  ]);
});

// ── when nothing stands ──────────────────────────────────────────────────────────────

test('ladder: two identical functions — every cut is ambiguous, and the refusal says so', async () => {
  const old = 'void f() {\n  go();\n}\nvoid f() {\n  go();\n}\n';
  assert.deepEqual(await ladder('cpp', old, 'void f() {\n  go();\n}\nvoid f() {\n  stop();\n}\n', { maxSiblings: 0 }), [
    'ambiguous ... ⏎ void f() { ⏎ ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ...',
    'ambiguous ... ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ...',
    'ambiguous ... ⏎ void f() { ⏎ >>> ⏎ go(); ⏎ ... ⏎ <<< ⏎ } ⏎ ...',
    'ambiguous ... ⏎ void f() { ⏎ ... ⏎ >>> ⏎ go(); ⏎ ... ⏎ <<< ⏎ } ⏎ ...',
    'ambiguous ... ⏎ void f() { ⏎ >>> ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ...',
    'ambiguous ... ⏎ void f() { ⏎ >>> ⏎ ... ⏎ <<< ⏎ } ⏎ ...',
    'ambiguous ... ⏎ void f() { ⏎ >>> ⏎ ... ⏎ go(); ⏎ ... ⏎ <<< ⏎ } ⏎ ...',
    'ambiguous ... ⏎ void f() { ⏎ >>> ⏎ ... ⏎ go(); ⏎ <<< ⏎ ... ⏎ } ⏎ ...',
    'FAILED ambiguous: could not anchor the change at line 5 of the new version — ambiguous match: the pattern fits in more than one place — add context',
  ]);
});

// ── one outdent closes every nested block; the parentless rung, and `--require-parents` ─
// In Python the closer of a parent is the next line at its own level — `class Archive:`
// for `class Queue:` — and it closes the method the change opens (`def __init__(…):`)
// together with the class: one outdent ends both. So the pattern with the parent stands
// (docs/08-c1-outdent.md, С1).

const QUEUE = [
  'class Queue:',
  '    def __init__(self, limit=100):',
  '        self.limit = limit',
  '',
  '    def size(self):',
  '        return len(self.items)',
  '',
  '',
  'class Archive:',
  '    def __init__(self):',
  '        self.items = []',
  '',
].join('\n');
const QUEUE_NEW = QUEUE.replace('self, limit', 'self, cap');

test('ladder: in Python a change that opens a method keeps its class — the outdent closes both', async () => {
  assert.deepEqual(await ladder('python', QUEUE, QUEUE_NEW, { maxSiblings: 0 }), [
    'unique ... ⏎ class Queue: ⏎ ... ⏎ >>> ⏎ def __init__(self, limit=100): ⏎ <<< ⏎ ... ⏎ class Archive: ⏎ ...',
    'KEPT ... ⏎ class Queue: ⏎ ... ⏎ >>> ⏎ def __init__(self, limit=100): ⏎ <<< ⏎ ... ⏎ class Archive: ⏎ ...',
  ]);
});

test('ladder: in Python a nested def keeps the def around it', async () => {
  const old =
    'class Queue:\n    def push(self, item, limit=100):\n        def check(x):\n            return x\n        return check(item)\n\n' +
    '    def size(self):\n        return 0\n';
  assert.deepEqual(await ladder('python', old, old.replace('def check(x):', 'def check(y):'), { maxSiblings: 0 }), [
    'unique ... ⏎ def push( ⏎ ... ⏎ ): ⏎ ... ⏎ >>> ⏎ def check(x): ⏎ <<< ⏎ ... ⏎ def size(self): ⏎ ...',
    'KEPT ... ⏎ def push( ⏎ ... ⏎ ): ⏎ ... ⏎ >>> ⏎ def check(x): ⏎ <<< ⏎ ... ⏎ def size(self): ⏎ ...',
  ]);
});

test('ladder: the same nested def in two classes — the header of the def around it tells them apart', async () => {
  const cls = (name: string, params: string): string =>
    `class ${name}:\n    def push(${params}):\n        def check(x):\n            return x\n        return check(item)\n\n` +
    '    def size(self):\n        return 0\n';
  const old = cls('Queue', 'self, item') + '\n\n' + cls('Stack', 'self, item, limit');
  assert.deepEqual(await ladder('python', old, old.replace('def check(x):', 'def check(y):'), { maxSiblings: 0 }), [
    'ambiguous ... ⏎ def push( ⏎ ... ⏎ ): ⏎ ... ⏎ >>> ⏎ def check(x): ⏎ <<< ⏎ ... ⏎ def size(self): ⏎ ...',
    'unique ... ⏎ def push(self, item): ⏎ ... ⏎ >>> ⏎ def check(x): ⏎ <<< ⏎ ... ⏎ def size(self): ⏎ ...',
    'KEPT ... ⏎ def push(self, item): ⏎ ... ⏎ >>> ⏎ def check(x): ⏎ <<< ⏎ ... ⏎ def size(self): ⏎ ...',
  ]);
});

// A bracket knows its own closing token, in Python too: a change that opens `[` has its
// `]` to pass, and the closer of the parent past it is a way out of the bracket — every
// pattern with the parent and no `]` is refused.
const listOf = (params: string): string => `def b(${params}):\n    return [\n        x\n        for x in rows\n    ]\n\n\n`;
const RETURNS = listOf('rows') + 'def a(rows):\n    return list(rows)\n';

test('ladder: a pattern with the parent refused, the parentless rung is kept', async () => {
  assert.deepEqual(await ladder('python', RETURNS, RETURNS.replace('return [', 'yield ['), { maxSiblings: 0 }), [
    'no-match ... ⏎ def b( ⏎ ... ⏎ ): ⏎ ... ⏎ >>> ⏎ return [ ⏎ <<< ⏎ ... ⏎ def a(rows): ⏎ ...',
    'unique ... ⏎ >>> ⏎ return [ ⏎ <<< ⏎ ...',
    'KEPT ... ⏎ >>> ⏎ return [ ⏎ <<< ⏎ ...',
  ]);
});

test('ladder: a no-match is not narrowed even where narrowing would cut places — the header of b stays ( ... )', async () => {
  const old = listOf('rows') + listOf('rows, limit') + 'def a(rows):\n    return list(rows)\n';
  assert.deepEqual(await ladder('python', old, old.replace('return [', 'yield ['), { maxSiblings: 0 }), [
    'no-match ... ⏎ def b( ⏎ ... ⏎ ): ⏎ ... ⏎ >>> ⏎ return [ ⏎ <<< ⏎ ... ⏎ def b(rows, limit): ⏎ ...',
    'ambiguous ... ⏎ >>> ⏎ return [ ⏎ <<< ⏎ ...',
    'no-match ... ⏎ def b( ⏎ ... ⏎ ): ⏎ >>> ⏎ ... ⏎ return [ ⏎ <<< ⏎ ... ⏎ def b(rows, limit): ⏎ ...',
    'FAILED ambiguous: could not anchor the change at line 2 of the new version — ambiguous match: the pattern fits in more than one place — add context',
  ]);
});

test('ladder: --require-parents takes the parentless rung away — another cut, or a refusal', async () => {
  const kept = (lines: string[]): string | undefined => lines.find((l) => l.startsWith('KEPT ') || l.startsWith('FAILED '));
  const NEW = RETURNS.replace('return [', 'yield [');
  assert.equal(
    kept(await ladder('python', RETURNS, NEW, { maxSiblings: 0, parentsRequired: true })),
    'FAILED no-match: could not anchor the change at line 2 of the new version — no match: the pattern did not fit the file',
  );
  assert.equal(
    kept(await ladder('python', RETURNS, NEW, { maxSiblings: 0 })),
    'KEPT ... ⏎ >>> ⏎ return [ ⏎ <<< ⏎ ...',
    'without the flag the parentless pattern stands',
  );
  assert.equal(
    kept(await ladder('python', RETURNS, NEW, { parentsRequired: true })),
    'KEPT ... ⏎ def b( ⏎ ... ⏎ ): ⏎ ... ⏎ >>> ⏎ return [ ⏎ <<< ⏎ ... ⏎ x ⏎ for x in rows ⏎ ] ⏎ ... ⏎ def a(rows): ⏎ ...',
    'with neighbours allowed the parent stands, the bracket written to its ]',
  );
});

// ── loose by default: what a patch cannot write byte for byte is still reproduced ─────

test('synthesis is loose unless asked: a line the new version ends in LF lands in a CRLF base as CRLF', async () => {
  const adapter = await adapterFor('cpp');
  const old = 'void f() {\r\n  a();\r\n  b();\r\n}\r\n';
  const neu = 'void f() {\r\n  a();\n  x();\r\n  b();\r\n}\r\n';
  // a patch takes the line endings of its base, so the LF after `a();` cannot be written
  assert.equal(synthesize(old, neu, adapter).length, 1);
  assert.throws(
    () => synthesize(old, neu, adapter, { exact: true }),
    (e: unknown) =>
      e instanceof SynthesisError &&
      e.reason === 'unreproduced' &&
      e.message ===
        'the new version mixes line endings (line 2 ends with LF); a patch writes the endings of the base — ' +
          'turn exact off or make the endings one',
  );
});

test('synthesis with exact: a CRLF line in an LF base is payload, written byte for byte', async () => {
  const adapter = await adapterFor('cpp');
  const old = 'void f() {\n  a();\n  b();\n}\n';
  const neu = 'void f() {\n  a();\r\n  x();\n  b();\n}\n';
  assert.equal(synthesize(old, neu, adapter, { exact: true }).length, 1);
});

// ── which failure a refusal names ──────────────────────────────────────────────────

test('moreInformative: an ambiguity outranks a no-match, whichever came first', () => {
  const amb = new AmbiguityError('two places', [1, 2]);
  const miss = new MatchError('no place', 0, 3);
  assert.equal(moreInformative(undefined, miss), miss, 'the first failure is taken as it is');
  assert.equal(moreInformative(miss, amb), amb);
  assert.equal(moreInformative(amb, miss), amb);
});

test('moreInformative: of two no-matches the one that got further, a tie keeps the first', () => {
  const shallow = new MatchError('stopped at step 1', 0, 1);
  const deep = new MatchError('stopped at step 4', 0, 4);
  const alsoDeep = new MatchError('stopped at step 4 too', 0, 4);
  assert.equal(moreInformative(shallow, deep), deep);
  assert.equal(moreInformative(deep, shallow), deep);
  assert.equal(moreInformative(deep, alsoDeep), deep);
});

test('moreInformative: a failure of another kind ranks below both, and a tie of them keeps the first', () => {
  const odd = new Error('something else');
  const other = new Error('something else again');
  const miss = new MatchError('no place', 0, 0);
  const amb = new AmbiguityError('two places', [1, 2]);
  assert.equal(moreInformative(odd, miss), miss);
  assert.equal(moreInformative(miss, odd), miss);
  assert.equal(moreInformative(amb, odd), amb);
  assert.equal(moreInformative(odd, other), odd);
  const ambToo = new AmbiguityError('two other places', [3, 4]);
  assert.equal(moreInformative(amb, ambToo), amb);
});

test('anchorFailure: the refusal carries the first line of the failure it names', () => {
  const segment = { oldStart: 3, newStart: 4, removed: ['  x();'], added: [] };
  const e = anchorFailure(segment, new MatchError('no match: the pattern did not fit the file\n  more', 0, 0));
  assert.equal(e.message, 'could not anchor the change at line 4 of the new version — no match: the pattern did not fit the file');
});
