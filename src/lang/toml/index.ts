import { makeTextAdapter } from '../make-text-adapter.ts';
import { isWordChar } from '../word.ts';
import { replaceWhitespaceOutsideStrings } from '../zones.ts';
import type { StringRule } from '../zones.ts';

// TOML: read as text — `[table]` headers are lines, inline tables and arrays pairs of
// brackets. Whitespace means nothing outside strings.

const ZONES: readonly StringRule[] = [
  { open: '#', close: '\n', opaque: false },
  { open: '"""', close: '"""', escape: '\\', multiline: true },
  { open: "'''", close: "'''", multiline: true },
  { open: '"', close: '"', escape: '\\' },
  { open: "'", close: "'" },
];

export function normalize(raw: string): string {
  return replaceWhitespaceOutsideStrings(raw, ZONES, (ws, off) =>
    off > 0 && isWordChar(raw[off - 1]!) && isWordChar(raw[off + ws.length] ?? '')
      ? ' '
      : '',
  );
}

export const tomlAdapter = makeTextAdapter({
  name: 'toml',
  extensions: ['.toml'],
  normalize,
  zones: ZONES,
});
