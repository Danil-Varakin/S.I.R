import { makeAdapter } from '../make-adapter.ts';
import { isWordChar } from '../word.ts';
import { replaceWhitespaceOutsideStrings } from '../zones.ts';
import type { StringRule } from '../zones.ts';
import type { Node } from '../treesitter.ts';
import type { BlockOf, OrigSpan } from '../block-spans.ts';

// JSON5 is read by the JavaScript grammar: a JSON5 file is an object literal of
// JavaScript — keys without quotes, strings in single quotes, comments, a trailing comma.
// The JSON grammar puts such a file in ERROR whole (docs/10-brave-languages.md, stage 6).

const STRINGS: readonly StringRule[] = [
  { open: '//', close: '\n', opaque: false },
  { open: '/*', close: '*/', multiline: true, opaque: false },
  { open: '"', close: '"', escape: '\\' },
  { open: "'", close: "'", escape: '\\' },
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
// `data: [`. An object that is an element of an array has no key: what names it is its
// first pair — `{ name: "AIPromptAPI",` in Blink's feature lists — so that pair is its
// header and the block opens after it. Two features with the same body are then told
// apart by their names, as two functions by theirs.
const json5BlockOf: BlockOf = (node: Node): OrigSpan | null => {
  const pair = bracketPair(node);
  if (pair === null) return null;
  const { first, last } = pair;
  if (node.type === 'object' && node.parent?.type === 'array') {
    const name = node.namedChildren.find((c) => c?.type === 'pair');
    if (name !== undefined && name !== null) {
      const comma = name.nextSibling;
      const open = comma !== null && comma.type === ',' ? comma.startIndex : name.endIndex - 1;
      return { open, close: last.startIndex, closeEnd: last.endIndex, headerStart: first.startIndex };
    }
  }
  const span: OrigSpan = { open: first.startIndex, close: last.startIndex, closeEnd: last.endIndex };
  const parent = node.parent;
  if (parent !== null && parent.type === 'pair' && parent.startIndex < node.startIndex) {
    span.headerStart = parent.startIndex;
  }
  return span;
};

export const json5Adapter = makeAdapter({
  name: 'json5',
  grammar: {
    file: 'tree-sitter-javascript.wasm',
    package: 'tree-sitter-javascript',
    version: '0.25.0',
    sha256: '5fb488d0cabb4775a594bab85682de5ad6ce83c0d6ac997a9f82dd084d571240',
  },
  extensions: ['.json5'],
  normalize,
  blockOf: json5BlockOf,
});
