import { makeTextAdapter } from '../make-text-adapter.ts';
import { isWordChar } from '../word.ts';
import { replaceWhitespaceOutsideStrings } from '../zones.ts';
import type { StringRule } from '../zones.ts';

// Web IDL and Blink's IDL (`.idl`, `.webidl`): no grammar worth shipping — the one on npm is
// OMG IDL, and the WebIDL grammars on GitHub are young and miss the dialects Chromium
// keeps (docs/10-brave-languages.md, stage 6). Read as text: `interface X {` … `};` is a
// block by its braces, `[Attr]` a pair of brackets.

const ZONES: readonly StringRule[] = [
  { open: '//', close: '\n', opaque: false },
  { open: '/*', close: '*/', multiline: true, opaque: false },
  { open: '"', close: '"', escape: '\\' },
];

export function normalize(raw: string): string {
  return replaceWhitespaceOutsideStrings(raw, ZONES, (ws, off) =>
    off > 0 && isWordChar(raw[off - 1]!) && isWordChar(raw[off + ws.length] ?? '')
      ? ' '
      : '',
  );
}

export const idlAdapter = makeTextAdapter({
  name: 'idl',
  extensions: ['.idl', '.webidl'],
  normalize,
  zones: ZONES,
});
