import { makeAdapter } from '../make-adapter.ts';
import { isWordChar } from '../word.ts';
import { replaceWhitespaceOutsideStrings } from '../zones.ts';
import type { StringRule } from '../zones.ts';
import type { Node } from '../treesitter.ts';
import type { BlockOf, OrigSpan } from '../block-spans.ts';

const STRINGS: readonly StringRule[] = [
  { open: '//', close: '\n', opaque: false },
  { open: '/*', close: '*/', multiline: true, opaque: false },
  { open: '"""', close: '"""', multiline: true },
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
  ['(', ')'],
  ['[', ']'],
  ['<', '>'],
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

function ownerStart(node: Node): number | undefined {
  let owner = node.parent;
  while (owner !== null && bracketPair(owner) === null && owner.startIndex === node.startIndex) {
    owner = owner.parent;
  }
  if (owner === null || bracketPair(owner) !== null) return undefined;
  return owner.startIndex < node.startIndex ? owner.startIndex : undefined;
}

const kotlinBlockOf: BlockOf = (node: Node): OrigSpan | null => {
  const pair = bracketPair(node);
  if (pair === null) return null;
  const { first, last } = pair;
  const span: OrigSpan = { open: first.startIndex, close: last.startIndex, closeEnd: last.endIndex };
  const header = ownerStart(node);
  if (header !== undefined) span.headerStart = header;
  return span;
};

export const kotlinAdapter = makeAdapter({
  name: 'kotlin',
  grammar: {
    file: 'tree-sitter-kotlin.wasm',
    package: '@tree-sitter-grammars/tree-sitter-kotlin',
    version: '1.1.0',
    sha256: '7009d69453bc8735e438b2818a633efb21c88f99782769abba60dffedfab73f7',
  },
  extensions: ['.kt', '.kts'],
  normalize,
  lines: {
    comments: ['//'],
    blockComments: [['/*', '*/']],
    closers: ',;)]}',
    continues: '([{<,',
    resumes: ')]}>',
  },
  blockOf: kotlinBlockOf,
});
