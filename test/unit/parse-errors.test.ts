import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSirFile, MATCH_HEADING, PATCH_HEADING, END_HEADING, NOTE_HEADING } from '../../src/core/sir-parser.ts';
import { readHeader, headerFields, parseHeader, isContainedPath, formatSide } from '../../src/core/header.ts';
import { ParseError } from '../../src/core/errors.ts';

const H = (match: string, patch = '    x'): string => `# match cpp\n${match}\n# end\n# patch\n${patch}\n# end\n`;

interface Refusal {
  readonly name: string;
  readonly text: string;
  readonly line: number;
  readonly says: string;
  readonly hint?: string;
}

const NO_END = "every block ends with a '# end' line in column 0";
const ORDER = 'the order is Sir, Target, Base-Blob, Sir-Version, Grammar; fields sir does not know may stand anywhere after Sir';
const TARGET = (v: string): string => `Target must be a relative path inside the project, with no '..': '${v}'`;

const REFUSALS: Refusal[] = [
  {
    name: 'two skips in one gap',
    text: H('    ...\n    ...\n    >>>'),
    line: 3,
    says: 'two skip operators in one gap',
    hint: 'the labels are transparent: "... >>> ..." — also two passes in a row; leave one',
  },
  {
    name: 'a mark between two skips is no gap between them',
    text: H('    ... >>> ...'),
    line: 2,
    says: 'two skip operators in one gap',
    hint: 'the labels are transparent: "... >>> ..." — also two passes in a row; leave one',
  },
  {
    name: 'a second >>>',
    text: H('    a\n    >>>\n    b\n    >>>'),
    line: 5,
    says: 'repeat insertion point >>> (the first one is on line 3)',
    hint: 'you need two insertion points — make two match/patch hunks',
  },
  {
    name: '<<< before >>>',
    text: H('    <<<\n    >>>'),
    line: 2,
    says: 'marker <<< without preceding >>>: end of range before start',
    hint: '<<< always after >>> is the end of the replacement range started by the insertion',
  },
  {
    name: 'a second <<<',
    text: H('    >>> a <<<\n    b <<<'),
    line: 3,
    says: 'repeat end-of-range marker <<< (the first one is on line 2)',
    hint: 'a replacement range has exactly one end; remove the extra <<<',
  },
  {
    name: 'no >>> — named at the # match',
    text: '\n' + H('    ...\n    a\n    ...'),
    line: 2,
    says: 'there is no insertion point >>> in the match block',
    hint: 'each patch body needs exactly one insertion position',
  },
  { name: 'a match block never closed — named at its heading', text: '# match cpp\n    >>>\n', line: 1, says: 'the match block is not closed', hint: NO_END },
  {
    name: 'a patch block never closed — named at its heading',
    text: '# match cpp\n    >>>\n# end\n# patch\n    x\n',
    line: 4,
    says: 'the patch block is not closed',
    hint: NO_END,
  },
  {
    name: 'a heading inside a block — quoted trimmed',
    text: '# match cpp\n    >>>\n# patch   \n# end\n',
    line: 3,
    says: "the match block is not closed: '# patch' found where '# end' was expected",
  },
  {
    name: 'the fences of the old format',
    text: '# match cpp\n```cpp\n# end\n',
    line: 2,
    says: 'the fenced format is no longer supported',
    hint:
      "drop the ``` fences, indent every payload line with four spaces and close each block with '# end'; " +
      "the language goes into the heading: '# match cpp'",
  },
  {
    name: 'a payload line without the gutter — quoted',
    text: '# match cpp\n  >>> x\n# end\n',
    line: 2,
    says: 'a line of the match block must start with four spaces',
    hint: "indent '>>> x', or close the block with '# end'",
  },
  {
    name: 'a payload line without the gutter — forty characters are quoted whole',
    text: `# match cpp\n${'y'.repeat(40)}\n# end\n`,
    line: 2,
    says: 'a line of the match block must start with four spaces',
    hint: `indent '${'y'.repeat(40)}', or close the block with '# end'`,
  },
  {
    name: 'a payload line without the gutter — longer is cut at forty',
    text: `# match cpp\n${'x'.repeat(45)}\n# end\n`,
    line: 2,
    says: 'a line of the match block must start with four spaces',
    hint: `indent '${'x'.repeat(40)}…', or close the block with '# end'`,
  },
  {
    name: 'a payload line of the patch block without the gutter',
    text: '# match cpp\n    >>>\n# end\n# patch\nx\n# end\n',
    line: 5,
    says: 'a line of the patch block must start with four spaces',
    hint: "indent 'x', or close the block with '# end'",
  },
  {
    name: 'no # patch after the match block — another line',
    text: '# match cpp\n    >>>\n# end\nfoo\n',
    line: 4,
    says: 'the patch header is expected after the match block',
    hint: "a match block without a patch doesn't make sense",
  },
  {
    name: 'no # patch after the match block — the end of the file',
    text: '# match cpp\n    >>>\n# end\n\n',
    line: 3,
    says: 'the patch header is expected after the match block',
    hint: "a match block without a patch doesn't make sense",
  },
  {
    name: 'text between hunks',
    text: H('    >>>') + 'stray\n' + H('    >>>'),
    line: 7,
    says: 'text between hunks must be in a note block',
    hint: "put the comment into '# note' … '# end' right before the '# match' it is about",
  },
  {
    name: 'two languages in one patch',
    text: H('    >>>') + '\n' + H('    >>>').replace('cpp', 'python'),
    line: 8,
    says: "match block declares language 'python', but the file already uses 'cpp'",
    hint: 'one patch — one language; split the hunks into separate files',
  },
  {
    name: 'a second note for one hunk',
    text: H('    >>>') + '# note\na\n# end\n# note\nb\n# end\n' + H('    >>>'),
    line: 10,
    says: 'a second note for one hunk (the first one is on line 7)',
    hint: "a hunk has at most one '# note'; merge the two",
  },
  {
    name: 'a note closed by a heading — quoted trimmed',
    text: H('    >>>') + '# note\nwhy\n# match cpp  \n    >>>\n# end\n# patch\n# end\n',
    line: 9,
    says: "the note block is not closed: '# match cpp' found where '# end' was expected",
    hint: "close the note with '# end' before the next heading",
  },
  { name: 'a note never closed — named at its heading', text: H('    >>>') + '# note\nwhy\n', line: 7, says: 'the note block is not closed', hint: NO_END },
  {
    name: 'a note with no hunk after it',
    text: H('    >>>') + '\n# note\nwhy\n# end\n',
    line: 8,
    says: "a note with no hunk after it: '# match' is expected",
    hint: "a '# note' belongs to the '# match' that follows it",
  },
  { name: 'no hunk at all', text: 'just prose\n', line: 1, says: 'no match/patch pairs were found in the file' },
  { name: 'seven #s are no heading', text: '####### match cpp\n    >>>\n# end\n# patch\n# end\n', line: 1, says: 'no match/patch pairs were found in the file' },
  {
    name: '# end with a word after it is no end',
    text: '# match cpp\n    >>>\n# end x\n# end\n# patch\n# end\n',
    line: 3,
    says: "'# end x' is not a heading: '# end' takes nothing after it",
  },
  {
    name: '# patch with a word after it is no heading',
    text: '# match cpp\n    >>>\n# patch now\n# end\n# patch\n# end\n',
    line: 3,
    says: "'# patch now' is not a heading: '# patch' takes nothing after it",
  },
  {
    name: '# note with a word after it inside a patch block',
    text: '# match cpp\n    >>>\n# end\n# patch\n# note here\n# end\n',
    line: 5,
    says: "'# note here' is not a heading: '# note' takes nothing after it",
  },
  {
    name: '# match with two words after it is no heading',
    text: '# match cpp\n    >>>\n## Match cpp now\n# end\n# patch\n# end\n',
    line: 3,
    says: "'## Match cpp now' is not a heading: '# match' takes a language name and nothing more",
  },
  {
    name: '# endif is a line of code, not a heading',
    text: '# match cpp\n    >>>\n# endif\n# end\n# patch\n# end\n',
    line: 3,
    says: 'a line of the match block must start with four spaces',
    hint: "indent '# endif', or close the block with '# end'",
  },
  {
    name: 'a header line that is no Name: value — quoted trimmed',
    text: 'Sir: 2\nno colon here  \n\n' + H('    >>>'),
    line: 2,
    says: "a header line must be 'Name: value': 'no colon here'",
    hint: 'the header ends at the first blank line — put one before the patch',
  },
  {
    name: 'a header with no blank line before the first hunk',
    text: 'Sir: 2\n' + H('    >>>'),
    line: 2,
    says: "a header line must be 'Name: value': '# match cpp'",
    hint: 'the header ends at the first blank line — put one before the patch',
  },
  {
    name: 'a space before the colon',
    text: 'Sir: 2\nTarget : a\n\n' + H('    >>>'),
    line: 2,
    says: "a header line must be 'Name: value': 'Target : a'",
    hint: 'the header ends at the first blank line — put one before the patch',
  },
  {
    name: 'a name that starts with a digit',
    text: 'Sir: 2\n2X: v\n\n' + H('    >>>'),
    line: 2,
    says: "a header line must be 'Name: value': '2X: v'",
    hint: 'the header ends at the first blank line — put one before the patch',
  },
  { name: 'a field twice, in another case', text: 'Sir: 2\nTarget: a\ntarget: b\n\n' + H('    >>>'), line: 3, says: 'the header names Target twice' },
  { name: 'known fields out of order', text: 'Sir: 2\nGrammar: g@1\nTarget: a\n\n' + H('    >>>'), line: 3, says: 'Target must come before Grammar in the header', hint: ORDER },
  {
    name: 'a header of format 1 — its first field was Hatch',
    text: 'Hatch: 1\nTarget: a\n\n' + H('    >>>'),
    line: 1,
    says: 'the patch is format 1, this sir reads 2–2',
    hint: 'regenerate the patch',
  },
  { name: 'Sir not a number', text: 'Sir: one\n\n' + H('    >>>'), line: 1, says: "Sir must be a format number: 'one'" },
  { name: 'Sir with a word after the number', text: 'Sir: 1x\n\n' + H('    >>>'), line: 1, says: "Sir must be a format number: '1x'" },
  { name: 'Sir with a sign', text: 'Sir: +1\n\n' + H('    >>>'), line: 1, says: "Sir must be a format number: '+1'" },
  { name: 'a newer format — update sir', text: 'Sir: 3\n\n' + H('    >>>'), line: 1, says: 'the patch is format 3, this sir reads 2–2', hint: 'update sir' },
  { name: 'an older format — regenerate', text: 'Sir: 0\n\n' + H('    >>>'), line: 1, says: 'the patch is format 0, this sir reads 2–2', hint: 'regenerate the patch' },
  {
    name: 'the format named at its own line, past blank lines',
    text: '\n\nSir: 7\n\n' + H('    >>>'),
    line: 3,
    says: 'the patch is format 7, this sir reads 2–2',
    hint: 'update sir',
  },
  { name: 'Target with ..', text: 'Sir: 2\nX-Note: hi\nTarget: ../x\n\n' + H('    >>>'), line: 3, says: TARGET('../x') },
  { name: 'Target absolute', text: 'Sir: 2\nTarget: /x\n\n' + H('    >>>'), line: 2, says: TARGET('/x') },
  { name: 'Target with a drive', text: 'Sir: 2\nTarget: C:x\n\n' + H('    >>>'), line: 2, says: TARGET('C:x') },
  { name: 'Target UNC', text: 'Sir: 2\nTarget: \\\\srv\\x\n\n' + H('    >>>'), line: 2, says: TARGET('\\\\srv\\x') },
  { name: 'Target empty', text: 'Sir: 2\nTarget:\n\n' + H('    >>>'), line: 2, says: TARGET('') },
];

for (const r of REFUSALS) {
  test(`refused: ${r.name}`, () => {
    assert.throws(
      () => parseSirFile(r.text),
      (e: unknown) => {
        assert.ok(e instanceof ParseError, `${(e as Error).name}: ${(e as Error).message}`);
        assert.equal(e.mdLine, r.line, 'the line');
        assert.equal(e.message.split('\n')[0], `line ${r.line}: ${r.says}`, 'the sentence');
        assert.equal(e.hint, r.hint, 'the hint');
        return true;
      },
    );
  });
}

const ONE = H('    >>>');

test('header: names are read without regard to case, values trimmed, a colon inside a value kept', () => {
  assert.deepEqual(parseSirFile('sir: 2\nTARGET:\t a/b.cc \t\nGrammar: tree:sitter@1:2  \n\n' + ONE).header, {
    format: 2,
    target: 'a/b.cc',
    grammar: 'tree:sitter@1:2',
  });
});

test('header: unknown fields stand anywhere after Sir, and are kept under their name lower-cased', () => {
  const text = 'Sir: 2\nX-Who: me\nTarget: a\nX-2a: two\nGrammar: g@1\n\n' + ONE;
  const read = readHeader(text);
  assert.deepEqual([...read.fields], [['sir', '2'], ['x-who', 'me'], ['target', 'a'], ['x-2a', 'two'], ['grammar', 'g@1']]);
  assert.equal(read.endLine, 5, 'the blank line after it');
  assert.equal(read.formatLine, 1);
  assert.equal(read.targetLine, 3);
});

test('header: blank lines before it are skipped, and the lines are counted from the file', () => {
  const read = readHeader('\n\nSir: 2\nTarget: a\n\n' + ONE);
  assert.equal(read.formatLine, 3);
  assert.equal(read.targetLine, 4);
  assert.equal(read.endLine, 4);
});

test('header: CRLF lines read the same', () => {
  assert.deepEqual(parseSirFile('Sir: 2\r\nTarget: a\r\n\r\n' + ONE.replace(/\n/g, '\r\n')).header, { format: 2, target: 'a' });
});

test('header: none when the first line is not Sir — what follows is prose before the first hunk', () => {
  const read = readHeader('Target: a\nSir: 2\n\n' + ONE);
  assert.deepEqual(read, { format: 2, fields: new Map(), endLine: 0, formatLine: 0, targetLine: undefined });
  assert.deepEqual(parseSirFile('Target: a\nSir: 2\n\n' + ONE).header, { format: 2 });
});

test('header: Sir with a leading zero is the same number', () => {
  assert.equal(parseSirFile('Sir: 02\n\n' + ONE).header!.format, 2);
});

test('header: the names format 1 had are not read — Generated-From, Generated-By, Hatch-Version are unknown fields', () => {
  const fields = headerFields(parseHeader('Sir: 2\nGenerated-From: abc\nGenerated-By: hatch 0.4.1\nHatch-Version: 0.4.1\n\n' + ONE));
  assert.deepEqual(fields, {});
  assert.deepEqual(headerFields(parseHeader('Sir: 2\nSir-Version: 0.5.0\n\n' + ONE)), { sirVersion: '0.5.0' });
  assert.deepEqual(headerFields(parseHeader('Sir: 2\n\n' + ONE)), {}, 'no field, no derived one');
});

test('header: the side of a format outside the range, and none inside', () => {
  assert.equal(formatSide(1), 'older');
  assert.equal(formatSide(2), undefined);
  assert.equal(formatSide(3), 'newer');
});

test('header: a contained path — relative, no .., no root, no drive', () => {
  for (const ok of ['a', 'a/b.cc', 'a\\b.cc', '.a/b', 'a..b/c', 'x/./y']) assert.equal(isContainedPath(ok), true, ok);
  for (const bad of ['', '/a', '\\a', 'C:a', 'c:/a', '..', 'a/../b', 'a\\..\\b', 'a/..']) assert.equal(isContainedPath(bad), false, bad);
});

test('headings: one to six #, with or without a space, a colon or the language, in any case', () => {
  const f = parseSirFile('## Match: CPP\n    >>>\n#end\n#PATCH:\n# end\t\n');
  assert.equal(f.language, 'CPP');
  assert.equal(parseSirFile('#match cpp\n    >>>\n# END   \n###### patch\n# end\n').hunks.length, 1);
  assert.equal(parseSirFile('# matches cpp\n# match\n    >>>\n# end\n# patch\n# end\n').language, undefined, '"# matches" is prose');
});

test('escapes: \\... is a literal ..., and one backslash of \\\\>>> is taken off', () => {
  const steps = parseSirFile('# match cpp\n    \\... >>> \\\\>>> x\n# end\n# patch\n# end\n').hunks[0]!.match.steps;
  assert.deepEqual(
    steps.map((s) => (s.anchor.target === 'literal' ? s.anchor.literal.raw : 'EOF')),
    ['...', '\\>>> x'],
  );
});

test('notes: blank lines at the edges of a note are trimmed, inside kept, trailing spaces dropped', () => {
  const f = parseSirFile(H('    >>>') + '\n# note\n\n  why  \n\nand how\n\n# end\n' + H('    >>>'));
  assert.equal(f.hunks[1]!.note!.text, '  why\n\nand how');
  assert.deepEqual(f.hunks[1]!.note!.mdSpan, [8, 14]);
});

test('notes: before the first hunk only a closed note followed by blank lines is one — the rest is prose', () => {
  assert.equal(parseSirFile('# note\nwhy\n# end\n\n\n' + ONE).hunks[0]!.note?.text, 'why');
  assert.equal(parseSirFile('# note\nwhy\n# end\nprose\n' + ONE).hunks[0]!.note, undefined, 'prose after it');
  assert.equal(parseSirFile('# note\nwhy\n' + ONE).hunks[0]!.note, undefined, 'never closed');
  assert.equal(parseSirFile('# note\nwhy\n# end\n# patch\n# end\n' + ONE).hunks[0]!.note, undefined, 'a block between');
  assert.equal(parseSirFile('# note\na\n# end\n# note\nb\n# end\n' + ONE).hunks[0]!.note?.text, 'b', 'the last of two');
  assert.equal(parseSirFile('# end\n' + ONE).hunks[0]!.note, undefined, 'an # end with no note');
});

test('headings: what each heading pattern takes, and what it leaves as text', () => {
  const kind = (line: string): string => {
    const m = line.match(MATCH_HEADING);
    if (m !== null) return `match ${m[1] ?? '-'}`;
    if (PATCH_HEADING.test(line)) return 'patch';
    if (END_HEADING.test(line)) return 'end';
    if (NOTE_HEADING.test(line)) return 'note';
    return 'text';
  };
  const table: [string, string][] = [
    ['# match', 'match -'],
    ['#match', 'match -'],
    ['# match cpp', 'match cpp'],
    ['# match  cpp', 'match cpp'],
    ['# match: cpp', 'match cpp'],
    ['# MATCH CPP  ', 'match CPP'],
    ['# match:cpp', 'text'],
    ['# match cpp extra', 'text'],
    ['####### match', 'text'],
    ['x # match', 'text'],
    ['# matches', 'text'],
    ['# patch', 'patch'],
    ['#  patch', 'patch'],
    ['# patch:', 'patch'],
    ['# patches', 'text'],
    ['# patchx', 'text'],
    ['# patch x', 'text'],
    ['x # patch', 'text'],
    ['# note', 'note'],
    ['#note', 'note'],
    ['#  note', 'note'],
    ['## note', 'note'],
    ['# note:', 'note'],
    ['# notes', 'text'],
    ['# note x', 'text'],
    ['x # note', 'text'],
    ['# end', 'end'],
    ['#  end', 'end'],
    ['# end:', 'text'],
    ['# ends', 'text'],
    ['x # end', 'text'],
  ];
  for (const [line, want] of table) assert.equal(kind(line), want, JSON.stringify(line));
});

test('blank: a line of spaces between # end and # patch, between hunks, inside a block', () => {
  assert.equal(parseSirFile('# match cpp\n    >>>\n# end\n   \n# patch\n    x\n# end\n').hunks[0]!.patch, 'x');
  assert.equal(parseSirFile(ONE + '   \n' + ONE).hunks.length, 2);
  assert.equal(parseSirFile('# match cpp\n    >>>\n  \n# end\n# patch\n    x\n  \n# end\n').hunks[0]!.patch, 'x\n', 'blank, not payload of spaces');
});

test('blank: lines of spaces at the edges of a note are trimmed', () => {
  assert.equal(parseSirFile(ONE + '# note\n   \nwhy\n \t\n# end\n' + ONE).hunks[1]!.note!.text, 'why');
});

test('blank: a line of spaces ends the header, and lines of spaces before it are skipped', () => {
  assert.deepEqual(parseSirFile('Sir: 2\nTarget: a\n   \n' + ONE).header, { format: 2, target: 'a' });
  assert.deepEqual(parseSirFile('  \nSir: 2\nTarget: a\n\n' + ONE).header, { format: 2, target: 'a' });
});

test('blank: a line of spaces between a note before the first hunk and the hunk keeps the note', () => {
  assert.equal(parseSirFile('# note\nwhy\n# end\n   \n' + ONE).hunks[0]!.note?.text, 'why');
});

test('header: only a leading "sir " is taken off a version — not one inside it', () => {
  assert.equal(headerFields(parseHeader('Sir: 2\nSir-Version: mysir 1.0\n\n' + ONE)).sirVersion, 'mysir 1.0');
});

test('header: a drive is refused only at the start of a path — a colon further in is a name', () => {
  assert.equal(isContainedPath('dir/c:x'), true);
  assert.equal(isContainedPath('c:x'), false);
});
