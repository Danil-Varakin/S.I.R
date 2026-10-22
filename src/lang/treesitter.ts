import { Parser, Language } from 'web-tree-sitter';
import type { Tree, Node } from 'web-tree-sitter';
import { embeddedAsset } from '../infra/runtime.ts';

export type { Language, Tree, Node } from 'web-tree-sitter';

let initOnce: Promise<void> | null = null;
let parser: Parser | null = null;
const grammars = new Map<string, Promise<Language>>();

function ensureInit(): Promise<void> {
  if (initOnce === null) {
    // inside sir-apply the runtime's own .wasm is an asset, not a file beside the JS
    const wasmBinary = embeddedAsset('web-tree-sitter.wasm');
    const p = wasmBinary !== null ? Parser.init({ wasmBinary }) : Parser.init();
    p.catch(() => {
      if (initOnce === p) initOnce = null;
    });
    initOnce = p;
  }
  return initOnce;
}

export function loadGrammar(key: string, input: string | Uint8Array): Promise<Language> {
  if (typeof key !== 'string' || key.length === 0) throw new Error('loadGrammar: empty grammar key');
  let g = grammars.get(key);
  if (g === undefined) {
    const p = ensureInit()
      .then(() => Language.load(input))
      .catch((e: unknown) => {
        const detail = (e as Error).message;
        throw new Error(
          `failed to load grammar ${key}${detail ? `: ${detail}` : ''}` +
            ` (a grammar built with tree-sitter cli older than ABI 14 cannot be loaded)`,
        );
      });
    p.catch(() => {
      if (grammars.get(key) === p) grammars.delete(key);
    });
    grammars.set(key, p);
    g = p;
  }
  return g;
}

export function parse(grammar: Language, source: string): Tree {
  (parser ??= new Parser()).setLanguage(grammar);
  const tree = parser.parse(source);
  if (tree === null) throw new Error('tree-sitter: parse() returned null');
  return tree;
}

export function* walk(tree: Tree): Generator<Node> {
  const cursor = tree.walk();
  try {
    yield cursor.currentNode;
    let descend = true;
    for (;;) {
      if (descend && cursor.gotoFirstChild()) {
        yield cursor.currentNode;
      } else if (cursor.gotoNextSibling()) {
        yield cursor.currentNode;
        descend = true;
      } else if (cursor.gotoParent()) {
        descend = false;
      } else {
        break;
      }
    }
  } finally {
    cursor.delete();
  }
}
