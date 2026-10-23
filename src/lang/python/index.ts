import { makeAdapter } from '../make-adapter.ts';
import { normalize } from './normalize.ts';
import type { Node } from '../treesitter.ts';
import type { BlockOf, OrigSpan } from '../block-spans.ts';

export { normalize } from './normalize.ts';

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

function colonBefore(node: Node): Node | null {
  const prev = node.previousSibling;
  return prev !== null && prev.type === ':' ? prev : null;
}

const pythonBlockOf: BlockOf = (node: Node): OrigSpan | null => {
  const pair = bracketPair(node);
  if (pair !== null) {
    const span: OrigSpan = {
      open: pair.first.startIndex,
      close: pair.last.startIndex,
      closeEnd: pair.last.endIndex,
    };
    const owner = node.parent;
    if (owner !== null && bracketPair(owner) === null && owner.startIndex < node.startIndex) {
      span.headerStart = owner.startIndex;
    }
    return span;
  }

  if (node.type !== 'block') return null;
  const colon = colonBefore(node);
  if (colon === null) return null;
  const span: OrigSpan = { open: colon.startIndex, close: node.endIndex };
  const parent = node.parent;
  if (parent !== null) span.headerStart = parent.startIndex;
  return span;
};

export const pythonAdapter = makeAdapter({
  name: 'python',
  grammar: {
    file: 'tree-sitter-python.wasm',
    package: 'tree-sitter-python',
    version: '0.25.0',
    sha256: '16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47',
  },
  extensions: ['.py', '.pyi', '.star'],
  fileNames: ['DEPS'],
  normalize,
  blockOf: pythonBlockOf,
  closesByOutdent: true,
});
