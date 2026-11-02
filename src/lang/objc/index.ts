import { makeAdapter } from '../make-adapter.ts';
import { isWordChar } from '../word.ts';
import { replaceWhitespaceOutsideStrings } from '../zones.ts';
import type { StringRule } from '../zones.ts';
import type { Node } from '../treesitter.ts';
import type { BlockOf, OrigSpan } from '../block-spans.ts';

const STRINGS: readonly StringRule[] = [
  { open: '//', close: '\n', opaque: false },
  { open: '/*', close: '*/', multiline: true, opaque: false },
  { open: '"', close: '"', escape: '\\' },
  { open: /(?<![0-9a-fA-F])'|'(?![0-9a-fA-F])/, close: "'", escape: '\\' },
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

const objcBlockOf: BlockOf = (node: Node): OrigSpan | null => {
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

export const objcAdapter = makeAdapter({
  name: 'objc',
  grammar: {
    file: 'tree-sitter-objc.wasm',
    package: 'tree-sitter-objc',
    version: '3.0.2',
    sha256: '155bf61fc94941fa9d07c86cd46895f14dfb2549fb7f646faeb83765af05c970',
  },
  extensions: ['.m', '.mm'],
  normalize,
  preproc: {
    open: /^[ \t]*#[ \t]*(?:if|ifdef|ifndef)\b/,
    middle: /^[ \t]*#[ \t]*(?:else|elif|elifdef|elifndef)\b/,
    close: /^[ \t]*#[ \t]*endif\b/,
  },
  lines: {
    comments: ['//'],
    blockComments: [['/*', '*/']],
    closers: ',;)]}',
    continues: '([{<,',
    resumes: ')]}>',
    continuation: '\\',
  },
  blockOf: objcBlockOf,
});
