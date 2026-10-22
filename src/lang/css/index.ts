import { makeAdapter } from '../make-adapter.ts';
import { replaceWhitespaceOutsideStrings } from '../zones.ts';
import type { StringRule } from '../zones.ts';
import type { Node } from '../treesitter.ts';
import type { BlockOf, OrigSpan } from '../block-spans.ts';

const STRINGS: readonly StringRule[] = [
  { open: '/*', close: '*/', multiline: true, opaque: false },
  { open: '"', close: '"', escape: '\\' },
  { open: "'", close: "'", escape: '\\' },
];

// A space in a selector is the descendant combinator — `.a .b` is not `.a.b` — and one
// between two values separates them (`0 -1px`). So a run of whitespace is one space,
// unless punctuation stands on either side of it, where it means nothing.
const PUNCTUATION = new Set(['{', '}', '(', ')', ';', ':', ',', '>', '+', '~']);

export function normalize(raw: string): string {
  return replaceWhitespaceOutsideStrings(raw, STRINGS, (ws, off) => {
    const before = raw[off - 1];
    const after = raw[off + ws.length];
    if (before === undefined || after === undefined) return '';
    return PUNCTUATION.has(before) || PUNCTUATION.has(after) ? '' : ' ';
  });
}

const PAIR = new Map<string, string>([
  ['{', '}'],
  ['(', ')'],
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

// A block of declarations: `{` … `}` of a rule, `@media`, `@supports`, `@keyframes`; its
// header is the selector or the at-rule before it — the node that holds both.
const cssBlockOf: BlockOf = (node: Node): OrigSpan | null => {
  const pair = bracketPair(node);
  if (pair === null) return null;
  const { first, last } = pair;
  const span: OrigSpan = { open: first.startIndex, close: last.startIndex, closeEnd: last.endIndex };
  const parent = node.parent;
  if (parent !== null && bracketPair(parent) === null && parent.startIndex < node.startIndex) {
    span.headerStart = parent.startIndex;
  }
  return span;
};

export const cssAdapter = makeAdapter({
  name: 'css',
  grammar: {
    file: 'tree-sitter-css.wasm',
    package: 'tree-sitter-css',
    version: '0.25.0',
    sha256: '8a23977fe271357cce6f254ef88c9bebf3854602d8046605aef6a45c02135c59',
  },
  extensions: ['.css'],
  normalize,
  blockOf: cssBlockOf,
});
