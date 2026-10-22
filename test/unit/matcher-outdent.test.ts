import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pythonAdapter, normalize } from '../../src/lang/python/index.ts';
import { cppAdapter } from '../../src/lang/cpp/index.ts';
import { matchPattern } from '../../src/core/matcher.ts';
import type { MatchPattern } from '../../src/core/ast.ts';
import type { SourceMap } from '../../src/lang/source-map.ts';
import { AmbiguityError, MatchError } from '../../src/core/errors.ts';
import { firstMatch, wrapMatch } from '../helpers.ts';

// A line with less indent closes every block deeper than itself at once, in a language that
// closes by outdent (Python): a closer met with an overdue block on the stack is legal when
// that block has no closing token and lies inside a block the closer ends. Every other
// overdue block still makes the closer an escape. docs/08-c1-outdent.md, С1.

function pattern(...lines: string[]): MatchPattern {
  return firstMatch(wrapMatch(lines.join('\n'), 'python'));
}

async function landsAt(source: string, pat: MatchPattern, map?: SourceMap): Promise<string> {
  await pythonAdapter.init();
  const m = map ?? pythonAdapter.buildMap(source);
  const marks = matchPattern(pat, m, normalize);
  const at = m.toOriginalPos(marks.insert.pos, marks.insert.side);
  return source.slice(at, source.indexOf('\n', at));
}

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

const WITH_PARENT = pattern('...', 'class Queue:', '...', '>>>', '    def __init__(self, limit=100):', '<<<', '...', 'class Archive:', '...');

test('outdent: the closer of a class is legal past the method it holds — one outdent ends both', async () => {
  assert.equal(await landsAt(QUEUE, WITH_PARENT), 'def __init__(self, limit=100):');
});

test('outdent: blocks closed together leave the stack — a later closer is judged without them', async () => {
  const source = QUEUE + '    def size(self):\n        return 0\n\n\nclass Next:\n    pass\n';
  assert.equal(
    await landsAt(
      source,
      pattern('...', 'class Queue:', '...', '>>>', '    def __init__(self, limit=100):', '<<<', '...', 'class Archive:', '...', '    def __init__(self):', '...', 'class Next:', '...'),
    ),
    'def __init__(self, limit=100):',
  );
});

test('outdent: a map of a language that closes by its own token keeps the old rule — an escape', async () => {
  await pythonAdapter.init();
  const map = pythonAdapter.buildMap(QUEUE);
  const braces: SourceMap = { ...map, closesByOutdent: false, endsImplicitBlock: () => false };
  await assert.rejects(landsAt(QUEUE, WITH_PARENT, braces), MatchError);
});

test('outdent: an overdue bracket in Python has its own closing token — the closer is still an escape', async () => {
  const source = 'class A:\n    x = {\n        1: 2,\n    }\n    y = 3\nclass B:\n    pass\n';
  await assert.rejects(landsAt(source, pattern('...', 'class A:', '...', 'x = {', '...', '>>>', '1: 2,', '<<<', '...', 'class B:', '...')), MatchError);
});

test('outdent: an overdue block outside the block the closer ends is an escape', async () => {
  const source = 'def f():\n    if a:\n        go()\ndef g():\n    if b:\n        stop()\ndef h():\n    pass\n';
  await assert.rejects(
    landsAt(source, pattern('...', 'if a:', '...', '>>>', 'go()', '<<<', '...', 'def h():', '...')),
    MatchError,
  );
});

test('outdent: an overdue bracket beside an overdue method keeps the closer an escape — every overdue block must close by outdent', async () => {
  // at `class B:` both `f` and the `[` of x are overdue; the class closes `f`, not the `[`
  const source = 'class A:\n    def f(self):\n        x = [\n            1,\n        ]\n        go()\n    def g(self):\n        pass\nclass B:\n    pass\n';
  await assert.rejects(
    landsAt(source, pattern('...', 'class A:', '...', '    def f(self):', '...', 'x = [', '...', '>>>', '1,', '<<<', '...', 'class B:', '...')),
    MatchError,
  );
});

test('outdent: a block around both that the closer does not end does not close the overdue one', async () => {
  const source =
    'class C:\n    def f(self):\n        if a:\n            go()\n    def g(self):\n        if b:\n            stop()\n    def h(self):\n        pass\n';
  await assert.rejects(landsAt(source, pattern('...', 'if a:', '...', '>>>', 'go()', '<<<', '...', '    def h(self):', '...')), MatchError);
});

test('outdent: blocks nested two deep are closed by the one outdent too', async () => {
  const source =
    'class A:\n    def f(self):\n        if x:\n            go()\n        return 1\n\n' +
    'class B:\n    def f(self):\n        if x:\n            go()\n        return 2\n';
  assert.equal(
    await landsAt(source, pattern('...', 'class A:', '...', 'if x:', '...', '>>>', 'go()', '<<<', '...', 'class B:', '...')),
    'go()',
  );
});

test('outdent: brace languages are untouched — a } past an overdue block is still an escape', async () => {
  await cppAdapter.init();
  const source = 'struct A {\n  void f() {\n    go();\n  }\n  int n;\n};\nstruct B {\n};\n';
  const map = cppAdapter.buildMap(source);
  assert.equal(map.closesByOutdent, false);
  assert.throws(
    () => matchPattern(firstMatch(wrapMatch(['...', 'void f() {', '...', '>>>', 'go();', '<<<', '...', 'int n;', '...', '}', '...'].join('\n'))), map, cppAdapter.normalize),
    MatchError,
  );
});

// The pattern names `class A`, and before the rule it landed in the first `class B`: the
// way through `A.g` was an escape, and the way through `B.g` had the next `class B:` as its
// closer. With the rule both ways stand — the old result was a change in the wrong class,
// and the new one is an honest refusal asking for context (CHANGELOG, Fixed).
test('outdent: a pattern that landed in the wrong class is now ambiguous', async () => {
  const source = 'class A:\n    def g(self):\n        return 1\n    def h(self):\n        return 2\nclass B:\n    def g(self):\n        return 3\nclass B:\n    pass\n';
  await assert.rejects(landsAt(source, pattern('...', 'class A:', '...', '>>>', '    def g(self):', '<<<', '...', 'class B:', '...')), AmbiguityError);
});
