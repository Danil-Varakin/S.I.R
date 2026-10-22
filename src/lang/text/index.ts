import { makeTextAdapter } from '../make-text-adapter.ts';
import { replaceWhitespaceOutsideStrings } from '../zones.ts';
import type { StringRule } from '../zones.ts';

// Plain text: lists, templates, any file with no format of its own (`unsafe_buffers_paths.txt`,
// `control.template`, `chrome.release`). No strings, no comments; brackets still pair, so
// a `{` … `}` in a template is a block. Picked by `.txt` or by name: `--language text`.

const ZONES: readonly StringRule[] = [];

// The indentation of a line stays as it is: a list may nest by it. A run of whitespace
// inside a line reads as one space, and a space is never dropped — in a text with no
// grammar nothing says which spaces mean nothing.
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
