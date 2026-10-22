import { buildCanon } from './canon.ts';
import { makeSourceMap } from './build-map.ts';
import { stringZones, inZone } from './zones.ts';
import type { StringRule } from './zones.ts';
import type { BlockSpan, SourceMap, LanguageAdapter } from './source-map.ts';

// A language read as text: no grammar, the blocks are the pairs of `()`, `[]`, `{}` that
// balance outside the strings and comments of the format — the way comby reads code it
// has no grammar for. For formats with no tree-sitter grammar worth shipping: IDL,
// Mojom, Proto, shell scripts, YAML, TOML, plain text (docs/10-brave-languages.md,
// stage 6). What a format is — its extensions, its strings and comments, how its
// whitespace reads — is the format's own folder; this is only the reading.

export interface TextRules {
  name: string;
  extensions: readonly string[];
  /** whole file names that are this format (`postinst`) */
  fileNames?: readonly string[];
  normalize: (raw: string) => string;
  /** the strings and comments of the format: a bracket inside one is no structure */
  zones: readonly StringRule[];
}

const CLOSER_OF: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set([')', ']', '}']);
/** a line ending in one of these ends a statement, not a header */
const ENDS_STATEMENT = new Set([';', ',', '{', '}']);

export function makeTextAdapter(rules: TextRules): LanguageAdapter {
  return {
    name: rules.name,
    extensions: rules.extensions,
    fileNames: rules.fileNames,
    normalize: rules.normalize,
    grammar: undefined,

    async init(): Promise<void> {},

    buildMap(source: string): SourceMap {
      if (typeof source !== 'string') throw new TypeError('adapter.buildMap: source is not a string');
      const canon = buildCanon(source, rules.normalize);
      const spans = bracketSpans(source, rules.zones).map((s) => {
        const out: BlockSpan = {
          open: canon.toCanonPos(s.open),
          close: canon.toCanonPos(s.close),
          closeEnd: canon.toCanonPos(s.close + 1),
        };
        if (s.headerStart !== undefined) out.headerStart = canon.toCanonPos(s.headerStart);
        return out;
      });
      return makeSourceMap(canon, spans, false);
    },
  };
}

interface Pair {
  open: number;
  close: number;
  headerStart?: number;
}

/** Every pair of brackets that balances outside the zones, with its header: what stands
 *  before the opener on its line — after a pair opened on an earlier line and closed on
 *  this one (`[⏎Exposed=Window⏎] interface X {` is headed `interface X {`; `f() {` keeps
 *  `f()`) — or, with nothing there, the line above when it is no statement of its own
 *  (`interface X⏎{`). A closer that matches no opener is passed by. */
export function bracketSpans(source: string, zones: readonly StringRule[]): Pair[] {
  const inside = stringZones(source, zones);
  const stack: number[] = [];
  const out: Pair[] = [];
  const openerOf = new Map<number, number>();
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (CLOSER_OF[ch] === undefined && !CLOSERS.has(ch)) continue;
    if (inZone(inside, i)) continue;
    if (CLOSER_OF[ch] !== undefined) {
      stack.push(i);
      continue;
    }
    const top = stack[stack.length - 1];
    if (top === undefined || CLOSER_OF[source[top]!] !== ch) continue;
    stack.pop();
    openerOf.set(i, top);
    const pair: Pair = { open: top, close: i };
    const header = headerOf(source, top, openerOf);
    if (header !== undefined) pair.headerStart = header;
    out.push(pair);
  }
  return out;
}

function headerOf(source: string, open: number, openerOf: ReadonlyMap<number, number>): number | undefined {
  const lineStart = source.lastIndexOf('\n', open - 1) + 1;
  let from = lineStart;
  for (let i = lineStart; i < open; i++) {
    const opener = openerOf.get(i);
    if (opener !== undefined && opener < lineStart) from = i + 1;
  }
  const own = firstNonSpace(source, from, open);
  if (own !== undefined) return own;
  // nothing before the opener on its line: the line above heads it, unless it ends a statement
  let end = lineStart - 1;
  while (end > 0) {
    const prevStart = source.lastIndexOf('\n', end - 1) + 1;
    const text = source.slice(prevStart, end).trimEnd();
    if (text.trim() === '') {
      end = prevStart - 1;
      continue;
    }
    if (ENDS_STATEMENT.has(text[text.length - 1]!)) return undefined;
    return firstNonSpace(source, prevStart, end);
  }
  return undefined;
}

function firstNonSpace(source: string, from: number, to: number): number | undefined {
  for (let i = from; i < to; i++) if (!/\s/.test(source[i]!)) return i;
  return undefined;
}
