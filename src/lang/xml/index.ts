import { makeAdapter } from '../make-adapter.ts';
import { isWordChar } from '../word.ts';
import { replaceWhitespaceOutsideStrings } from '../zones.ts';
import type { StringRule } from '../zones.ts';
import type { Node } from '../treesitter.ts';
import type { BlockOf } from '../block-spans.ts';

// A string is the value of an attribute — a quote after `=` — and a CDATA section, which
// is data byte for byte. A quote in character data is a letter.
const STRINGS: readonly StringRule[] = [
  { open: '<!--', close: '-->', multiline: true, opaque: false },
  { open: '<![CDATA[', close: ']]>', multiline: true, opaque: true },
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

// `<tag …>` … `</tag>`: the block opens at the `>` of the start tag — the whole start tag
// is its header — and closes with the end tag. `<tag/>` is no block.
const xmlBlockOf: BlockOf = (node: Node) => {
  if (node.type !== 'element') return null;
  const start = node.firstChild;
  const end = node.lastChild;
  if (start === null || end === null || start.type !== 'STag' || end.type !== 'ETag') return null;
  const gt = start.lastChild;
  if (gt === null || gt.type !== '>') return null;
  return { open: gt.startIndex, close: end.startIndex, closeEnd: end.endIndex, headerStart: start.startIndex };
};

export const xmlAdapter = makeAdapter({
  name: 'xml',
  grammar: {
    file: 'tree-sitter-xml.wasm',
    package: '@tree-sitter-grammars/tree-sitter-xml',
    version: '0.7.0',
    sha256: '9950327f8542a3d563fe4192aa05986a53e6fd6adca518cbb1a1699cbc8970ad',
  },
  extensions: ['.xml', '.plist'],
  normalize,
  blockOf: xmlBlockOf,
});
