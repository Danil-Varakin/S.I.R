import { test } from 'node:test';
import assert from 'node:assert/strict';

import { template, withDraft } from '../../src/generate/draft.ts';
import type { ChangeSegment } from '../../src/generate/diff.ts';
import { printSirFile } from '../../src/generate/printer.ts';
import { applyAll } from '../../src/core/apply.ts';
import { SynthesisError } from '../../src/core/errors.ts';
import type { Hunk } from '../../src/core/ast.ts';
import { cppAdapter } from '../../src/lang/cpp/index.ts';

const CURRENT = 'void f() {\n  one();\n\n  two();\n  three();\n  four();\n  five();\n}\n';

function segment(oldStart: number, removed: string[], added: string[]): ChangeSegment {
  return { oldStart, newStart: oldStart, removed, added };
}

function printed(seg: ChangeSegment, current = CURRENT): string {
  return printSirFile([template(seg, current)], 'cpp');
}

function intended(seg: ChangeSegment, current = CURRENT): string {
  const lines = current.split('\n');
  lines.splice(seg.oldStart - 1, seg.removed.length, ...seg.added);
  return lines.join('\n');
}

async function laid(seg: ChangeSegment, current = CURRENT): Promise<string> {
  await cppAdapter.init();
  return applyAll(current, { hunks: [{ ...template(seg, current), mdSpan: [0, 0] }] }, cppAdapter).source;
}

test('template: a replacement — three lines above, then the removed lines between >>> and <<<', () => {
  assert.equal(
    printed(segment(7, ['  five();'], ['  FIVE();'])),
    '# match cpp\n    ...\n      two();\n      three();\n      four();\n    >>>\n      five();\n    <<<\n    ...\n# end\n' +
      '# patch\n\n      FIVE();\n# end\n',
  );
});

test('template: an insertion — the context, then >>> and the rest of the file', () => {
  assert.equal(
    printed(segment(7, [], ['  x();'])),
    '# match cpp\n    ...\n      two();\n      three();\n      four();\n    >>>\n    ...\n# end\n# patch\n\n      x();\n# end\n',
  );
});

test('template: a deletion — the removed lines and an empty body', () => {
  assert.equal(
    printed(segment(7, ['  five();'], [])),
    '# match cpp\n    ...\n      two();\n      three();\n      four();\n    >>>\n      five();\n    <<<\n    ...\n# end\n# patch\n# end\n',
  );
});

test('template: blank lines are not context — the three lines above are counted past them', () => {
  assert.equal(
    printed(segment(4, ['  two();'], ['  TWO();'])),
    '# match cpp\n    ...\n    void f() {\n      one();\n    >>>\n      two();\n    <<<\n    ...\n# end\n# patch\n\n\n      TWO();\n# end\n',
  );
});

test('template: the first line of the file has no context — the removed line alone', () => {
  assert.equal(
    printed(segment(1, ['void f() {'], ['void g() {'])),
    '# match cpp\n    ...\n    >>>\n    void f() {\n    <<<\n    ...\n# end\n# patch\n    void g() {\n# end\n',
  );
});

test('template: an insertion before the first line is the top of the file', () => {
  assert.equal(printed(segment(1, [], ['#include "a.h"'])), '# match cpp\n    >>>\n    ...\n# end\n# patch\n    #include "a.h"\n\n# end\n');
});

test('template: only blank lines above — no context, as at the top of the file', () => {
  assert.equal(
    printed(segment(3, ['x();'], ['y();']), '\n\nx();\n'),
    '# match cpp\n    ...\n    >>>\n    x();\n    <<<\n    ...\n# end\n# patch\n    y();\n# end\n',
  );
});

test('template: several lines removed and added are written line under line', () => {
  assert.equal(
    printed(segment(6, ['  four();', '  five();'], ['  FOUR();', '  FIVE();'])),
    '# match cpp\n    ...\n      one();\n      two();\n      three();\n    >>>\n      four();\n      five();\n    <<<\n    ...\n# end\n' +
      '# patch\n\n      FOUR();\n      FIVE();\n# end\n',
  );
});

test('template: a line of spaces is blank — not counted as context', () => {
  assert.equal(
    printed(segment(4, ['  b();'], ['  B();']), 'a();\n   \n\t\nb();\n'.replace('b();', '  b();')),
    '# match cpp\n    ...\n    a();\n    >>>\n      b();\n    <<<\n    ...\n# end\n# patch\n\n       \n    \t\n      B();\n# end\n',
  );
});

for (const [name, seg, current] of [
  ['a replacement', segment(7, ['  five();'], ['  FIVE();']), CURRENT],
  ['a replacement of two lines', segment(6, ['  four();', '  five();'], ['  FOUR();', '  FIVE();']), CURRENT],
  ['an insertion', segment(7, [], ['  x();']), CURRENT],
  ['an insertion of two lines', segment(7, [], ['  x();', '  y();']), CURRENT],
  ['a deletion', segment(7, ['  five();'], []), CURRENT],
  ['a replacement of the first line', segment(1, ['void f() {'], ['void g() {']), CURRENT],
  ['an insertion at the top', segment(1, [], ['#include "a.h"']), CURRENT],
  ['a replacement under blank lines only', segment(3, ['x();'], ['y();']), '\n\nx();\n'],
  ['an insertion into a run of blank lines', segment(3, [], ['  x();']), CURRENT],
] as const) {
  test(`template: ${name}, laid as drafted, makes the change`, async () => {
    assert.equal(await laid(seg, current), intended(seg, current));
  });
}

const BLANKS = 'void f() {\n  one();\n\n   \n\n  two();\n\n\n  three();\n}\n';
const TRAILING = 'void f() {\n  one();\n}\n\n\n';

for (const [name, seg, current] of [
  ['a replacement under a blank line', segment(4, ['  two();'], ['  TWO();']), CURRENT],
  ['an insertion under a blank line', segment(4, [], ['  x();']), CURRENT],
  ['a deletion under a blank line', segment(4, ['  two();'], []), CURRENT],
  ['a replacement under several blank lines', segment(6, ['  two();'], ['  TWO();']), BLANKS],
  ['a deletion under several blank lines', segment(6, ['  two();'], []), BLANKS],
  ['an insertion under several blank lines', segment(6, [], ['  x();']), BLANKS],
  ['an insertion with blank lines above and below', segment(4, [], ['  x();', '  y();']), BLANKS],
  ['an insertion between two runs of blank lines', segment(8, [], ['  x();']), BLANKS],
  ['an insertion under blank lines at the end of the file', segment(5, [], ['// end']), TRAILING],
  ['an insertion under blank lines, past the last line', segment(6, [], ['// end']), TRAILING],
  ['a replacement under lines of spaces', segment(4, ['  b();'], ['  B();']), 'a();\n   \n\t\n  b();\n'],
] as const) {
  test(`template: ${name}, laid as drafted, keeps the blank lines`, async () => {
    assert.equal(await laid(seg, current), intended(seg, current));
  });
}

test('template: an insertion under a blank line replaces the next line and writes it back', () => {
  assert.equal(
    printed(segment(4, [], ['  x();'])),
    '# match cpp\n    ...\n    void f() {\n      one();\n    >>>\n      two();\n    <<<\n    ...\n# end\n# patch\n\n\n      x();\n      two();\n# end\n',
  );
});

test('withDraft: the message, reason, because and line stay; the draft is the hunks so far and the template', () => {
  const before: Hunk = template(segment(2, ['  one();'], ['  ONE();']), CURRENT);
  const seg = segment(7, ['  five();'], ['  FIVE();']);
  const failed = new SynthesisError('could not anchor the change at line 7', 'ambiguous', 'two places', 7);
  const e = withDraft(failed, [before], seg, CURRENT);

  assert.ok(e instanceof SynthesisError);
  assert.notEqual(e, failed, 'a new error, the one thrown is left as it was');
  assert.equal(e.message, failed.message);
  assert.equal(e.reason, 'ambiguous');
  assert.equal(e.because, 'two places');
  assert.equal(e.newLine, 7);
  assert.equal(failed.draft, undefined);
  assert.equal(e.draft!.hunks.length, 2);
  assert.equal(e.draft!.hunks[0], before);
  assert.deepEqual(e.draft!.hunks[1], template(seg, CURRENT));
  assert.deepEqual(e.draft!.change, { line: 7, removed: ['  five();'], added: ['  FIVE();'] });
});
