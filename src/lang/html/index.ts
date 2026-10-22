import { makeAdapter } from '../make-adapter.ts';
import { isWordChar } from '../word.ts';
import { replaceWhitespaceOutsideStrings } from '../zones.ts';
import type { StringRule } from '../zones.ts';
import type { Node } from '../treesitter.ts';
import type { BlockOf } from '../block-spans.ts';

// A string is the value of an attribute — a quote after `=`. A quote in text is a letter
// (`Don't`), not the start of a string to the end of the line.
const STRINGS: readonly StringRule[] = [
  { open: '<!--', close: '-->', multiline: true, opaque: false },
  { open: /(?<==\s*)"/, close: '"', multiline: true },
  { open: /(?<==\s*)'/, close: "'", multiline: true },
];

export function normalize(raw: string): string {
  return replaceWhitespaceOutsideStrings(raw, STRINGS, (ws, off) =>
    off > 0 && isWordChar(raw[off - 1]!) && isWordChar(raw[off + ws.length] ?? '')
      ? ' '
      : '',
  );
}

// Elements whose tags pair: `<div …>` … `</div>`, and `<script>` / `<style>` with their
// raw text. The block opens at the `>` of the start tag — the whole start tag is its
// header — and closes with the end tag. An element with no end tag (`<img>`, `<p>` left
// open) and `<br/>` are no block: nothing closes them in the text.
const ELEMENTS = new Set(['element', 'script_element', 'style_element']);

const htmlBlockOf: BlockOf = (node: Node) => {
  if (!ELEMENTS.has(node.type)) return null;
  const start = node.firstChild;
  const end = node.lastChild;
  if (start === null || end === null || start.type !== 'start_tag' || end.type !== 'end_tag') return null;
  const gt = start.lastChild;
  if (gt === null || gt.type !== '>') return null;
  return { open: gt.startIndex, close: end.startIndex, closeEnd: end.endIndex, headerStart: start.startIndex };
};

export const htmlAdapter = makeAdapter({
  name: 'html',
  grammar: {
    file: 'tree-sitter-html.wasm',
    package: 'tree-sitter-html',
    version: '0.23.2',
    sha256: 'c48fcd82c7ea8bf943180088ba7f28c48b2bb5287874179168bf9d31e394cf85',
  },
  extensions: ['.html', '.htm'],
  normalize,
  blockOf: htmlBlockOf,
});
