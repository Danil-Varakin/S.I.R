import { makeAdapter } from '../make-adapter.ts';
import { isWordChar } from '../word.ts';
import { replaceWhitespaceOutsideStrings } from '../zones.ts';
import type { StringRule } from '../zones.ts';
import type { Node } from '../treesitter.ts';
import type { BlockOf, OrigSpan } from '../block-spans.ts';

const STRINGS: readonly StringRule[] = [
  { open: '//', close: '\n', opaque: false },
  { open: '/*', close: '*/', multiline: true, opaque: false },
  { open: /R"([^\s()\\]{0,16})\(/, close: (m) => `)${m[1] ?? ''}"`, multiline: true },
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

const cppBlockOf: BlockOf = (node: Node): OrigSpan | null => {
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

export const cppAdapter = makeAdapter({
  name: 'cpp',
  grammar: {
    file: 'tree-sitter-cpp.wasm',
    package: 'tree-sitter-cpp',
    version: '0.23.4',
    sha256: '174eb0deb75b2ec7881bcacda9f995648d8e683956e5c2267e69ab6dc503fcbf',
  },
  extensions: ['.cc', '.cpp', '.cxx', '.h', '.hpp', '.inc'],
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
  blockOf: cppBlockOf,
});
