
export interface GrammarSource {
  readonly file: string;
  readonly package?: string;
  readonly version?: string;
  readonly sha256?: string;
  /** absolute: this file instead of the search (tests, a grammar of one's own) */
  readonly path?: string;
}

export interface BlockSpan {
  open: number;
  close: number;
  headerStart?: number;
  closeEnd?: number;
}

export interface SourceMap {
  matchesAt(norm: string, pos: number): boolean;
  occurrences(norm: string, from: number, to: number): Iterable<number>;
  countOccurrences(norm: string, from: number, to: number): number;
  enclosing(pos: number): BlockSpan[];
  blocksWithin(from: number, to: number): BlockSpan[];
  readonly eof: number;
  /** The language closes a block by outdent: a line with less indent ends every block
   *  deeper than itself at once (Python). */
  readonly closesByOutdent: boolean;
  /** A block with no closing token ends at `close`. Always false unless `closesByOutdent`. */
  endsImplicitBlock(close: number): boolean;
  toOriginalPos(pos: number, side: 'left' | 'right'): number;
  toCanonPos(origPos: number): number;
}

export type MapCache = Map<string, SourceMap>;

export function mapFor(adapter: LanguageAdapter, source: string, cache?: MapCache): SourceMap {
  if (cache === undefined) return adapter.buildMap(source);
  const known = cache.get(source);
  if (known !== undefined) return known;
  const built = adapter.buildMap(source);
  cache.set(source, built);
  return built;
}

export interface LanguageAdapter {
  /** Loads the grammar (WASM), once. Nothing to choose: grammars ship inside sir and
   *  are never downloaded (`infra/grammar-store.ts`). */
  init(): Promise<void>;

  buildMap(source: string): SourceMap;

  normalize(raw: string): string;

  readonly name: string;

  extensions: readonly string[];

  /** Whole file names that are this language though they carry no extension of it —
   *  `DEPS` is Python. Matched exactly, before the extension. */
  readonly fileNames?: readonly string[] | undefined;

  /** The tree-sitter grammar the language is read with. None for a language read as
   *  text — blocks by the balance of its brackets (`make-text-adapter.ts`). */
  readonly grammar?: GrammarSource | undefined;
}
