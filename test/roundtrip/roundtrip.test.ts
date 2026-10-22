import { test } from 'node:test';
import assert from 'node:assert/strict';

import { strip, firstMatch, wrapMatch, roundtrip } from '../helpers.ts';
import { printSirFile } from '../../src/generate/printer.ts';
import { parseSirFile } from '../../src/core/sir-parser.ts';
import type { Hunk } from '../../src/core/ast.ts';

const CASES: ReadonlyArray<readonly [name: string, body: string, lang?: string]> = [
  ['simple insertion after a literal', '#include "a.h"\n>>>'],
  ['inline insertion between literals', 'foo >>> bar'],
  ['nested namespace + skipAny + }', 'namespace features {\n...\nkFoo,\n>>>\n}'],
  ['multiline literal (gluing adjacent lines)', 'a\nb\nc\n>>>'],
  ['multi-line with indents (Python)', 'def f():\n    x = 1\n    y = 2\n>>>', 'python'],
  ['replacement range A >>> ... <<< B', 'A >>> ... <<< B'],
  ['old code >>> A <<<', '>>> A <<<'],
  ['empty range >>> <<<', '>>> <<<'],
  ['paste at the end of the file ... >>>', '... >>>'],
  ['inserting at the beginning of the file >>> foo', '>>> foo'],
  ['Python indented in raw', 'def foo():\n    return None\n>>>', 'python'],
  ['include with a leading space', '  #include "x.h"\n>>>'],
];

for (const [name, body, lang] of CASES) {
  test(`round-trip: ${name}`, () => {
    const original = firstMatch(wrapMatch(body, lang ?? 'cpp'));
    const reparsed = roundtrip(original, lang ?? 'cpp');
    assert.deepStrictEqual(strip(reparsed), strip(original));
  });
}

test('the round trip is stable when run twice', () => {
  const original = firstMatch(wrapMatch('namespace N {\n...\n>>>\n}'));
  const once = roundtrip(original);
  const twice = roundtrip(once);
  assert.deepStrictEqual(strip(twice), strip(once));
});

for (const [name, body] of [
  ['a separate "..." as a literal', '\\... >>> foo'],
  ['the operator in the middle of the literal', 'a \\... b >>>'],
  ['the escaped operator inside the gluing', 'a\n\\... \nb\n>>>'],
  ['several screened ones in a row', '\\>>> \\<<< >>> x'],
  ['a real backslash before the operator survives', 'x \\\\... y >>>'],
  ['"\\..." in the middle of a word is plain text', 'foo\\...bar >>>'],
] as const) {
  test(`round-trip (screening): ${name}`, () => {
    const original = firstMatch(wrapMatch(body));
    const reparsed = roundtrip(original);
    assert.deepStrictEqual(strip(reparsed), strip(original));
  });
}

function payloadRoundtrip(patch: string, matchBody = 'foo >>>'): void {
  const original: Hunk = { match: firstMatch(wrapMatch(matchBody)), patch };
  const file = parseSirFile(printSirFile([original], 'cpp'));
  assert.equal(file.hunks.length, 1);
  assert.equal(file.hunks[0]!.patch, patch);
  assert.deepStrictEqual(strip(file.hunks[0]!.match), strip(original.match));
}

for (const [name, patch] of [
  ['a bare fence', '```'],
  ['a markdown block inside a raw string', '```cpp\nint sample = 1;\n```'],
  ['an empty markdown block (two fences in a row)', '```\n```'],
  ['sir headings as payload', '# match cpp\n# patch\n# end'],
  ['a blank line at the start', '\nint x = 1;'],
  ['blank lines inside', 'a();\n\nb();'],
  ['blank lines at the end', 'a();\n\n'],
  ['nothing but blank lines', '\n\n'],
  ['an empty body (deletion)', ''],
  ['indentation deeper than the gutter', '        deep();'],
  ['a line of significant trailing whitespace', 'a();\n   '],
] as const) {
  test(`round-trip (payload): ${name}`, () => {
    payloadRoundtrip(patch);
  });
}

test('round-trip (payload): a bare fence works as a literal anchor too', () => {
  payloadRoundtrip('X();', '```\n>>>');
});
