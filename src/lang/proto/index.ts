import { makeTextAdapter } from '../make-text-adapter.ts';
import { isWordChar } from '../word.ts';
import { replaceWhitespaceOutsideStrings } from '../zones.ts';
import type { StringRule } from '../zones.ts';

// Protocol Buffers: read as text — `message M {` … `}` is a block by its braces. The
// grammars on GitHub are built from source only, and one of the two reads Chromium's
// files in ERROR whole (docs/10-brave-languages.md, stage 6).

const ZONES: readonly StringRule[] = [
  { open: '//', close: '\n', opaque: false },
  { open: '/*', close: '*/', multiline: true, opaque: false },
  { open: '"', close: '"', escape: '\\' },
  { open: "'", close: "'", escape: '\\' },
];

export function normalize(raw: string): string {
  return replaceWhitespaceOutsideStrings(raw, ZONES, (ws, off) =>
    off > 0 && isWordChar(raw[off - 1]!) && isWordChar(raw[off + ws.length] ?? '')
      ? ' '
      : '',
  );
}

export const protoAdapter = makeTextAdapter({
  name: 'proto',
  extensions: ['.proto'],
  normalize,
  zones: ZONES,
});
