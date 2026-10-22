import { makeTextAdapter } from '../make-text-adapter.ts';
import { isWordChar } from '../word.ts';
import { replaceWhitespaceOutsideStrings } from '../zones.ts';
import type { StringRule } from '../zones.ts';

// Mojom, Chromium's IPC interfaces: no tree-sitter grammar exists. Read as text —
// `interface X {` … `};` and `struct S {` … `};` are blocks by their braces.

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

export const mojomAdapter = makeTextAdapter({
  name: 'mojom',
  extensions: ['.mojom'],
  normalize,
  zones: ZONES,
});
