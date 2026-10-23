import { makeTextAdapter } from '../make-text-adapter.ts';
import { replaceWhitespaceOutsideStrings } from '../zones.ts';
import type { StringRule } from '../zones.ts';

const ZONES: readonly StringRule[] = [];

export function normalize(raw: string): string {
  return replaceWhitespaceOutsideStrings(raw, ZONES, (ws, off) => {
    if (off === 0) return ws.replace(/^\uFEFF/, '');
    const newline = ws.lastIndexOf('\n');
    if (newline !== -1) return ws.slice(0, newline + 1).replace(/[^\n]/g, '') + ws.slice(newline + 1);
    return off + ws.length === raw.length ? '' : ' ';
  });
}

export const textAdapter = makeTextAdapter({
  name: 'text',
  extensions: ['.txt'],
  normalize,
  zones: ZONES,
});
