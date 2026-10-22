import { loadGrammar, parse } from './treesitter.ts';
import type { Language } from './treesitter.ts';
import { buildCanon } from './canon.ts';
import { makeSourceMap } from './build-map.ts';
import { collectBlockSpans } from './block-spans.ts';
import type { BlockOf } from './block-spans.ts';
import type { SourceMap, LanguageAdapter } from './source-map.ts';
import { resolveGrammar } from '../infra/grammar-store.ts';
import type { GrammarSource } from '../infra/grammar-store.ts';

export interface LanguageRules {
  name: string;
  grammar: GrammarSource;
  extensions: readonly string[];
  fileNames?: readonly string[];
  normalize: (raw: string) => string;
  blockOf: BlockOf;
  /** A line with less indent closes every block deeper than itself at once — blocks with
   *  no closing token of their own. Left out: every block closes by its own token. */
  closesByOutdent?: boolean;
}

/** An adapter read through a tree-sitter grammar: its grammar is always there. */
export type GrammarAdapter = LanguageAdapter & { readonly grammar: GrammarSource };

export function makeAdapter(rules: LanguageRules): GrammarAdapter {
  let grammar: Language | null = null;

  return {
    name: rules.name,
    extensions: rules.extensions,
    fileNames: rules.fileNames,
    normalize: rules.normalize,
    grammar: rules.grammar,

    async init(): Promise<void> {
      const input = await resolveGrammar(rules.grammar, rules.name);
      const key = `${rules.grammar.file}@${rules.grammar.version ?? rules.grammar.sha256 ?? 'local'}`;
      grammar = await loadGrammar(key, input);
    },

    buildMap(source: string): SourceMap {
      if (grammar === null) throw new Error('adapter: init() was not called before buildMap');
      if (typeof source !== 'string') throw new TypeError('adapter.buildMap: source is not a string');
      const tree = parse(grammar, source);
      try {
        const canon = buildCanon(source, rules.normalize);
        const spans = collectBlockSpans(tree, canon.toCanonPos, rules.blockOf);
        return makeSourceMap(canon, spans, rules.closesByOutdent === true);
      } finally {
        tree.delete();
      }
    },
  };
}
