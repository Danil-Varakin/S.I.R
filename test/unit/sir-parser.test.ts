import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSirFile } from '../../src/core/sir-parser.ts';
import { ParseError } from '../../src/core/errors.ts';
import { strip, firstMatch, wrapMatch, type FlatStep } from '../helpers.ts';

function lit(raw: string): FlatStep['anchor'] {
  return { kind: 'literal', raw };
}
const EOF: FlatStep['anchor'] = { kind: 'eof' };

function md(...lines: string[]): string {
  return lines.join('\n') + '\n';
}

function expectParseError(text: string, msgPart?: string): ParseError {
  let thrown: unknown;
  try {
    parseSirFile(text);
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown instanceof ParseError, 'a ParseError was expected');
  const err = thrown as ParseError;
  assert.equal(err.exitCode, 2,'ParseError → exit code 2');
  assert.equal(typeof err.mdLine, 'number', 'ParseError has a line number');
  assert.ok(err.mdLine >= 1, 'line number 1-based');
  if (msgPart !== undefined) {
    assert.ok(
      err.message.includes(msgPart),
      `the message must contain "${msgPart}", received: ${err.message}`,
    );
  }
  return err;
}

test('insertion point at the end of the block → eof-step with insert=left', () => {
  const m = firstMatch(wrapMatch('#include "a.h"\n>>>'));
  assert.deepStrictEqual(strip(m), [
    { mode: { op: 'tight' }, insert: null, replaceEnd: null, anchor: lit('#include "a.h"') },
    { mode: { op: 'tight' }, insert: 'left', replaceEnd: null, anchor: EOF },
  ]);
});

test('inline "foo >>> bar": insert between literals (side=left)', () => {
  const m = firstMatch(wrapMatch('foo >>> bar'));
  assert.deepStrictEqual(strip(m), [
    { mode: { op: 'tight' }, insert: null, replaceEnd: null, anchor: lit('foo') },
    { mode: { op: 'tight' }, insert: 'left', replaceEnd: null, anchor: lit('bar') },
  ]);
});

test('nested namespace: skipAny + closing "}" as literal', () => {
  const m = firstMatch(wrapMatch('namespace features {\n...\nkFoo,\n>>>\n}'));
  assert.deepStrictEqual(strip(m), [
    { mode: { op: 'tight' }, insert: null, replaceEnd: null, anchor: lit('namespace features {') },
    { mode: { op: 'skipAny' }, insert: null, replaceEnd: null, anchor: lit('kFoo,') },
    { mode: { op: 'tight' }, insert: 'left', replaceEnd: null, anchor: lit('}') },
  ]);
});

test('the replacement range is "A >>> ... <<< B": both labels on the same gap', () => {
  const m = firstMatch(wrapMatch('A >>> ... <<< B'));
  assert.deepStrictEqual(strip(m), [
    { mode: { op: 'tight' }, insert: null, replaceEnd: null, anchor: lit('A') },
    { mode: { op: 'skipAny' }, insert: 'left', replaceEnd: 'right', anchor: lit('B') },
  ]);
});

test('">>> A <<<": A is the old code (insert/replace=left on both sides of the literal)', () => {
  const m = firstMatch(wrapMatch('>>> A <<<'));
  assert.deepStrictEqual(strip(m), [
    { mode: { op: 'tight' }, insert: 'left', replaceEnd: null, anchor: lit('A') },
    { mode: { op: 'tight' }, insert: null, replaceEnd: 'left', anchor: EOF },
  ]);
});

test('insert at the end of the file "... >>>"', () => {
  const m = firstMatch(wrapMatch('... >>>'));
  assert.deepStrictEqual(strip(m), [
    { mode: { op: 'skipAny' }, insert: 'right', replaceEnd: null, anchor: EOF },
  ]);
});

test('insert at the beginning of the file ">>> foo"', () => {
  const m = firstMatch(wrapMatch('>>> foo'));
  assert.deepStrictEqual(strip(m), [
    { mode: { op: 'tight' }, insert: 'left', replaceEnd: null, anchor: lit('foo') },
  ]);
});

test('gluing: adjacent literals → ONE multiline literal', () => {
  const m = firstMatch(wrapMatch('line one\nline two\nline three\n>>>'));

  assert.deepStrictEqual(strip(m), [
    {
      mode: { op: 'tight' },
      insert: null,
      replaceEnd: null,
      anchor: lit('line one\nline two\nline three'),
    },
    { mode: { op: 'tight' }, insert: 'left', replaceEnd: null, anchor: EOF },
  ]);
});

test('gluing: mdSpan covers [First line, Last line]', () => {
  const m = firstMatch(wrapMatch('line one\nline two\nline three\n>>>'));
  const a = m.steps[0]!.anchor;
  assert.equal(a.target, 'literal');
  assert.deepStrictEqual(a.target === 'literal' ? a.literal.mdSpan : null, [2, 4]);
});

test('gluing does NOT occur via the operator (... breaks the adjacency)', () => {
  const m = firstMatch(wrapMatch('a\n...\nb\n>>>'));
  assert.equal(strip(m).length, 3);
  assert.equal(strip(m)[1]!.mode.op, 'skipAny');
});

test('Python:the leading indentation of the inner line is preserved in the glued raw', () => {
  const m = firstMatch(wrapMatch('def foo():\n    return None\n>>>', 'python'));
  assert.equal(strip(m)[0]!.anchor.raw, 'def foo():\n    return None');
  assert.equal(strip(m).length, 2);
});

test('include with a leading space: spaces are saved in raw', () => {
  const m = firstMatch(wrapMatch('  #include "x.h"\n>>>'));
  assert.equal(strip(m)[0]!.anchor.raw, '  #include "x.h"');
});

test('the escaped "\\..." becomes the literal "..." (not an operator)', () => {
  const m = firstMatch(wrapMatch('\\... >>> foo'));
  assert.equal(strip(m)[0]!.anchor.kind, 'literal');
  assert.equal(strip(m)[0]!.anchor.raw, '...');
});

test('"\\..." in the middle of a word stays as-is (escape is positional)', () => {
  const m = firstMatch(wrapMatch('foo\\...bar >>>'));
  assert.equal(strip(m)[0]!.anchor.raw, 'foo\\...bar');
});

test('standalone "\\\\..." loses exactly ONE backslash (escape of the escape)', () => {
  const m = firstMatch(wrapMatch('x \\\\... y >>>'));
  assert.equal(strip(m)[0]!.anchor.raw, 'x \\... y');
});

test('the language is determined by the "# match <lang>" heading', () => {
  const file = parseSirFile(wrapMatch('foo >>>', 'cpp'));
  assert.equal(file.language, 'cpp');
});

test('a heading without a language is fine', () => {
  const file = parseSirFile(md('# match', '    foo >>>', '# end', '# patch', '    X', '# end'));
  assert.equal(file.language, undefined);
  assert.equal(file.hunks.length, 1);
});

test('the same language in several headings is fine', () => {
  const text = [wrapMatch('foo >>>', 'cpp'), wrapMatch('bar >>>', 'cpp')].join('\n');
  assert.equal(parseSirFile(text).language, 'cpp');
});

test('FAIL: mixed languages in one file', () => {
  const text = [wrapMatch('foo >>>', 'cpp'), wrapMatch('bar >>>', 'python')].join('\n');
  expectParseError(text, 'language');
});

test('FAIL: <<< without preceding >>>', () => {
  expectParseError(wrapMatch('foo\n<<<\n>>>'), 'end of range before start');
});

test('FAIL: repeat insertion point >>>', () => {
  expectParseError(wrapMatch('foo >>> bar >>> baz'), 'repeat insertion point');
});

test('FAIL: repeat end-of-range marker <<< — the line of the first one, and the fix', () => {
  const e = expectParseError(wrapMatch('foo >>> bar <<< baz\nqux <<< end'), 'repeat end-of-range marker <<<');
  assert.match(e.message, /the first one is on line 2/);
  assert.equal(e.mdLine, 3);
  assert.match(e.hint ?? '', /exactly one end/);
});

test('FAIL: two skip operators in one gap (mark is transparent)', () => {
  expectParseError(wrapMatch('foo ... >>> ... bar'), 'two skip operators');
});

test('FAIL: two ... in a row are still two skips', () => {
  expectParseError(wrapMatch('foo ... ... bar >>>'), 'two skip operators');
});

test('FAIL: match block with no insertion point >>>', () => {
  expectParseError(wrapMatch('foo\nbar'), 'no insertion point');
});

test('FAIL: a body line without the four-space gutter', () => {
  expectParseError(md('# match', 'not indented', '# end'), 'must start with four spaces');
});

test('FAIL: match block not followed by a patch heading', () => {
  expectParseError(
    md('# match', '    foo >>>', '# end', 'garbage instead of patch'),
    'patch header is expected',
  );
});

test('FAIL: file truncated mid-block ("# end" is missing)', () => {
  expectParseError(md('# match', '    foo >>>'), 'not closed');
});

test('FAIL: a heading where "# end" was expected', () => {
  expectParseError(md('# match', '    foo >>>', '# patch', '    X', '# end'), 'not closed');
});

test('FAIL: file has no match/patch pairs at all', () => {
  expectParseError('just text, no sir here\n', 'no match/patch pairs');
});

test('FAIL: text between hunks — the hint names the note block', () => {
  const err = expectParseError(
    wrapMatch('foo >>>') + '\nstray commentary\n' + wrapMatch('bar >>>'),
    'text between hunks must be in a note block',
  );
  assert.match(err.hint ?? '', /# note/);
});

const HUNK = ['# match c', '    foo >>>', '# end', '# patch', '    X', '# end'];

test('note: attaches to the next hunk, prose in any column, edges trimmed', () => {
  const file = parseSirFile(md(
    ...HUNK, '',
    '# note', '', 'Why: the driver hangs', '  without WAIT.', '', '# end', '',
    ...HUNK,
  ));
  assert.equal(file.hunks[0]!.note, undefined);
  assert.deepStrictEqual(file.hunks[1]!.note, {
    text: 'Why: the driver hangs\n  without WAIT.',
    mdSpan: [8, 13],
  });
  assert.deepStrictEqual(file.hunks[1]!.mdSpan, [15, 20]);
});

test('note: before the first hunk, after the header', () => {
  const file = parseSirFile(md(
    'Sir: 2', 'Target: a.c', '', '# note', 'first', '# end', '', ...HUNK,
  ));
  assert.deepStrictEqual(file.hunks[0]!.note, { text: 'first', mdSpan: [4, 6] });
});

test('header: the fields sir knows, names in any case, unknown ones read past', () => {
  const file = parseSirFile(md(
    'Sir: 2', 'target: src/a.c', 'Base-Blob: 3f2a9c1e', 'SIR-VERSION: 0.5.0',
    'Grammar: tree-sitter-c@0.23.0', 'X-Reviewed-By: someone', '', ...HUNK,
  ));
  assert.deepStrictEqual(file.header, {
    format: 2,
    target: 'src/a.c',
    baseBlob: '3f2a9c1e',
    sirVersion: '0.5.0',
    grammar: 'tree-sitter-c@0.23.0',
  });
  assert.deepStrictEqual(file.hunks[0]!.mdSpan![0], 8, 'lines are counted from the top of the file');
});

test('header: a header 0.4.1 wrote — Hatch: 1 — is refused as older, whatever follows', () => {
  const error = expectParseError(md(
    'Hatch: 1', 'Target: src/a.c', 'Generated-From: 3f2a9c1e', 'Generated-By: hatch 0.4.1',
    'Grammar: tree-sitter-c@0.23.0', '', ...HUNK,
  ), 'format 1');
  assert.match(error.hint ?? '', /regenerate the patch/);
});

test('header: none is hunks alone, read as format 2 — a hand-written patch, or prose before the hunks', () => {
  assert.deepStrictEqual(parseSirFile(md(...HUNK)).header, { format: 2 });
  assert.deepStrictEqual(parseSirFile(md('Target: a.c', '', ...HUNK)).header, { format: 2 }, 'Sir must come first');
  assert.deepStrictEqual(parseSirFile(md('some prose', '', ...HUNK)).header, { format: 2 });
});

test('header: a format out of the range names the side to update', () => {
  assert.match(expectParseError(md('Sir: 3', '', ...HUNK)).hint ?? '', /update sir/);
  assert.match(expectParseError(md('Sir: 0', '', ...HUNK)).hint ?? '', /regenerate the patch/);
  expectParseError(md('Sir: one', '', ...HUNK), 'format number');
});

test('header: Target out of its root is refused; a line that is no field ends nothing', () => {
  for (const bad of ['../x.c', 'a/../../x.c', '/etc/passwd', 'C:\\x.c']) {
    const e = expectParseError(md('Sir: 2', `Target: ${bad}`, '', ...HUNK), 'Target');
    assert.equal(e.mdLine, 2, bad);
  }
  expectParseError(md('Sir: 2', 'not a field', '', ...HUNK), "'Name: value'");
});

test('note: the matcher never sees it — same pattern with or without', () => {
  const plain = parseSirFile(md(...HUNK));
  const noted = parseSirFile(md('# note', 'foo >>> ...', '# end', ...HUNK));
  assert.deepStrictEqual(strip(noted.hunks[0]!.match), strip(plain.hunks[0]!.match));
  assert.equal(noted.hunks[0]!.patch, plain.hunks[0]!.patch);
});

test('note: a preamble that only looks like a note stays prose (F1)', () => {
  for (const pre of [
    ['# Note', 'an old heading, never closed'],
    ['# note', 'closed', '# end', 'but text follows'],
    ['# note', 'x', '# patch', 'y', '# end'],
  ]) {
    const file = parseSirFile(md(...pre, '', ...HUNK));
    assert.equal(file.hunks[0]!.note, undefined, pre.join(' / '));
  }
});

test('FAIL: a note with no hunk after it', () => {
  expectParseError(md(...HUNK, '# note', 'dangling', '# end'), 'no hunk after it');
});

test('FAIL: two notes for one hunk', () => {
  expectParseError(
    md(...HUNK, '# note', 'a', '# end', '# note', 'b', '# end', ...HUNK),
    'second note',
  );
});

test('FAIL: a note not closed before the next heading', () => {
  expectParseError(md(...HUNK, '# note', 'forgot the end', ...HUNK), 'note block is not closed');
});

test('FAIL: a note not closed at the end of the file', () => {
  expectParseError(md(...HUNK, '# note', 'forgot the end'), 'note block is not closed');
});

test('FAIL: a note between match and patch', () => {
  expectParseError(
    md('# match c', '    foo >>>', '# end', '# note', 'x', '# end', '# patch', '    X', '# end'),
    'patch header is expected',
  );
});

test('FAIL: a note heading inside a match block', () => {
  expectParseError(md('# match c', '    foo >>>', '# note', 'x', '# end'), 'not closed');
});

test('FAIL: the old fenced format is reported by name, with the fix in the hint', () => {
  const err = expectParseError(
    md('# match', '```cpp', 'foo >>>', '```', '# patch', '```cpp', 'X', '```'),
    'fenced format is no longer supported',
  );
  assert.match(err.hint ?? '', /four spaces/);
  assert.match(err.hint ?? '', /# end/);
});

test('a fence inside the patch body survives verbatim', () => {
  const file = parseSirFile(
    md('# match cpp', '    foo >>>', '# end',
       '# patch', '    ```cpp', '    int sample = 1;', '    ```', '# end'),
  );
  assert.equal(file.hunks[0]!.patch, '```cpp\nint sample = 1;\n```');
});

test('a bare fence inside the match block is an ordinary literal', () => {
  const m = firstMatch(md('# match cpp', '    ```', '    >>>', '# end',
                          '# patch', '    X', '# end'));
  assert.deepStrictEqual(strip(m)[0]!.anchor, { kind: 'literal', raw: '```' });
});

test('"# patch" and "# end" inside the payload are payload, not structure', () => {
  const file = parseSirFile(
    md('# match cpp', '    foo >>>', '# end',
       '# patch', '    # patch', '    # end', '# end'),
  );
  assert.equal(file.hunks.length, 1);
  assert.equal(file.hunks[0]!.patch, '# patch\n# end');
});

test('blank lines in the patch body are kept, trailing ones included', () => {
  const file = parseSirFile(
    md('# match cpp', '    foo >>>', '# end',
       '# patch', '    a();', '', '    b();', '', '# end'),
  );
  assert.equal(file.hunks[0]!.patch, 'a();\n\nb();\n');
});

test('a patch body of blank lines only', () => {
  const file = parseSirFile(
    md('# match cpp', '    foo >>>', '# end', '# patch', '', '', '# end'),
  );
  assert.equal(file.hunks[0]!.patch, '\n');
});

test('an empty patch body is a deletion', () => {
  const file = parseSirFile(md('# match cpp', '    foo >>>', '# end', '# patch', '# end'));
  assert.equal(file.hunks[0]!.patch, '');
});

test('a payload line of four spaces is an empty payload line, not a blank', () => {
  const file = parseSirFile(
    md('# match cpp', '    foo >>>', '# end', '# patch', '    a();', '    ', '# end'),
  );
  assert.equal(file.hunks[0]!.patch, 'a();\n');
});

test('the gutter is stripped exactly: deeper indentation is preserved', () => {
  const file = parseSirFile(
    md('# match cpp', '    foo >>>', '# end', '# patch', '        deep();', '# end'),
  );
  assert.equal(file.hunks[0]!.patch, '    deep();');
});

test('prose before the first "# match" is ignored', () => {
  const prose = 'Instructions for foo.cc.\n\nAny text at all, even ``` and # end.\n\n';
  assert.equal(parseSirFile(prose + wrapMatch('foo >>>')).hunks.length, 1);
});

test('mdSpan of a hunk spans the "# match" heading and the closing "# end"', () => {
  const file = parseSirFile(md('# match cpp', '    foo >>>', '# end', '# patch', '    X', '# end'));
  assert.deepStrictEqual(file.hunks[0]!.mdSpan, [1, 6]);
});

test('header: the known fields in their order, each once; unknown ones anywhere after Sir', () => {
  parseSirFile(md('Sir: 2', 'X-Note: a', 'Target: a.c', 'X-Other: b', 'Grammar: g', '', ...HUNK));
  parseSirFile(md('Sir: 2', 'Grammar: g', '', ...HUNK));
  const swapped = expectParseError(md('Sir: 2', 'Sir-Version: 0.5.0', 'Target: a.c', '', ...HUNK), 'Target must come before Sir-Version');
  assert.equal(swapped.mdLine, 3);
  expectParseError(md('Sir: 2', 'Target: a.c', 'target: b.c', '', ...HUNK), 'twice');
});

test('one patch, one language — the same name in another case is the same language', () => {
  const hunk = (heading: string): string => `${heading}\n    ...\n    a();\n    >>>\n    ...\n# end\n# patch\n    b();\n# end\n`;
  const file = parseSirFile(`${hunk('# match cpp')}\n${hunk('# match CPP')}`);
  assert.equal(file.hunks.length, 2);
  assert.equal(file.language, 'cpp', 'the first spelling is the one kept');
  assert.throws(() => parseSirFile(`${hunk('# match cpp')}\n${hunk('# match c')}`), /already uses 'cpp'/);
});
