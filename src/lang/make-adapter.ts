import { loadGrammar, parse } from './treesitter.ts';
import type { Language } from './treesitter.ts';
import { buildCanon } from './canon.ts';
import { makeSourceMap } from './build-map.ts';
import { collectBlockSpans } from './block-spans.ts';
import type { BlockOf } from './block-spans.ts';
import type { SourceMap, LanguageAdapter, BlockSpan } from './source-map.ts';
import type { LineRules } from './line-edges.ts';
import { preprocVariants } from './preproc-variants.ts';
import type { PreprocRules } from './preproc-variants.ts';
import { resolveGrammar } from '../infra/grammar-store.ts';
import type { GrammarSource } from '../infra/grammar-store.ts';

export interface LanguageRules {
  name: string;
  grammar: GrammarSource;
  extensions: readonly string[];
  fileNames?: readonly string[];
  normalize: (raw: string) => string;
  blockOf: BlockOf;
  closesByOutdent?: boolean;
  lines?: LineRules;
  indentIsStructure?: boolean;
  preproc?: PreprocRules;
}

export type GrammarAdapter = LanguageAdapter & { readonly grammar: GrammarSource };

export function makeAdapter(rules: LanguageRules): GrammarAdapter {
  let grammar: Language | null = null;

  return {
    name: rules.name,
    extensions: rules.extensions,
    fileNames: rules.fileNames,
    normalize: rules.normalize,
    grammar: rules.grammar,
    indentIsStructure: rules.indentIsStructure,

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
        let spans = collectBlockSpans(tree, canon.toCanonPos, rules.blockOf);
        if (rules.preproc !== undefined && tree.rootNode.hasError) {
          spans = blocksByBuilds(grammar, source, canon.toCanonPos, rules, rules.preproc) ?? spans;
        }
        return makeSourceMap(canon, spans, rules.closesByOutdent === true, rules.lines);
      } finally {
        tree.delete();
      }
    },
  };
}

function blocksByBuilds(
  grammar: Language,
  source: string,
  toCanonPos: (origPos: number) => number,
  rules: LanguageRules,
  preproc: PreprocRules,
): BlockSpan[] | null {
  const seen = new Map<number, BlockSpan>();
  let clean = 0;
  for (const variant of preprocVariants(source, preproc)) {
    const tree = parse(grammar, variant);
    try {
      if (tree.rootNode.hasError) continue;
      clean++;
      for (const span of collectBlockSpans(tree, toCanonPos, rules.blockOf)) {
        const known = seen.get(span.close);
        if (known === undefined || span.open < known.open) seen.set(span.close, span);
      }
    } finally {
      tree.delete();
    }
  }
  return clean === 0 ? null : [...seen.values()];
}
