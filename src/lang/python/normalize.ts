import { isWordChar } from '../word.ts';
import { replaceWhitespaceOutsideStrings } from '../zones.ts';
import type { StringRule } from '../zones.ts';

const STRINGS: readonly StringRule[] = [
  { open: '#', close: '\n', opaque: false },
  { open: '"""', close: '"""', escape: '\\', multiline: true },
  { open: "'''", close: "'''", escape: '\\', multiline: true },
  { open: '"', close: '"', escape: '\\' },
  { open: "'", close: "'", escape: '\\' },
];

export function normalize(raw: string): string {
  return replaceWhitespaceOutsideStrings(raw, STRINGS, (ws, off) => collapseRun(raw, ws, off));
}

function collapseRun(raw: string, ws: string, off: number): string {
  // The indentation at the start of the file stays, as on every line — but a BOM is no
  // indentation: kept, it stood before a pattern pinned to the first line (07-findings Н6)
  if (off === 0) return ws.replace(/^\uFEFF/, '');
  const lastNewline = ws.lastIndexOf('\n');
  if (lastNewline !== -1) {
    const newlines = ws.slice(0, lastNewline + 1).replace(/[^\n]/g, '');
    return newlines + ws.slice(lastNewline + 1);
  }
  return isWordChar(raw[off - 1]!) && isWordChar(raw[off + ws.length] ?? '') ? ' ' : '';
}
