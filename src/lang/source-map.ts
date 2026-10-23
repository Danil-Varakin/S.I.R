export interface GrammarSource {
  readonly file: string;
  readonly package?: string;
  readonly version?: string;
  readonly sha256?: string;
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
  readonly closesByOutdent: boolean;
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
  init(): Promise<void>;

  buildMap(source: string): SourceMap;

  normalize(raw: string): string;

  readonly name: string;

  extensions: readonly string[];

  readonly fileNames?: readonly string[] | undefined;

  readonly grammar?: GrammarSource | undefined;
}
