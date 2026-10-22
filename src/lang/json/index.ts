import { makeAdapter } from '../make-adapter.ts';
import { isWordChar } from '../word.ts';
import { replaceWhitespaceOutsideStrings } from '../zones.ts';
import type { StringRule } from '../zones.ts';
import type { Node } from '../treesitter.ts';
import type { BlockOf, OrigSpan } from '../block-spans.ts';

// The grammar reads comments, which JSON has not; a file with them is read as it is.
const STRINGS: readonly StringRule[] = [
  { open: '//', close: '\n', opaque: false },
  { open: '/*', close: '*/', multiline: true, opaque: false },
  { open: '"', close: '"', escape: '\\' },
];

export function normalize(raw: string): string {
  return replaceWhitespaceOutsideStrings(raw, STRINGS, (ws, off) =>
    off > 0 && isWordChar(raw[off - 1]!) && isWordChar(raw[off + ws.length] ?? '')
      ? ' '
      : '',
  );
}

const PAIR = new Map<string, string>([
  ['{', '}'],
  ['[', ']'],
]);

function bracketPair(node: Node): { first: Node; last: Node } | null {
  if (!node.isNamed) return null;
  const first = node.firstChild;
  if (first === null) return null;
  const wantClose = PAIR.get(first.type);
  if (wantClose === undefined) return null;
  const last = node.lastChild;
  if (last === null || last.type !== wantClose) return null;
  return { first, last };
}

// An object or an array; one that is the value of a pair has the key for its header —
// `"permissions": [`.
const jsonBlockOf: BlockOf = (node: Node): OrigSpan | null => {
  const pair = bracketPair(node);
  if (pair === null) return null;
  const { first, last } = pair;
  const span: OrigSpan = { open: first.startIndex, close: last.startIndex, closeEnd: last.endIndex };
  const parent = node.parent;
  if (parent !== null && parent.type === 'pair' && parent.startIndex < node.startIndex) {
    span.headerStart = parent.startIndex;
  }
  return span;
};

export const jsonAdapter = makeAdapter({
  name: 'json',
  grammar: {
    file: 'tree-sitter-json.wasm',
    package: 'tree-sitter-json',
    version: '0.24.8',
    sha256: 'd2119fb98d5912719b13f9458574f8608d2d29dfbe45f6be1f860ea1fe2a2405',
  },
  extensions: ['.json'],
  normalize,
  blockOf: jsonBlockOf,
});
