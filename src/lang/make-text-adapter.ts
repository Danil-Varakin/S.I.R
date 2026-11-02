import { buildCanon } from './canon.ts';
import { makeSourceMap } from './build-map.ts';
import { stringZones, inZone } from './zones.ts';
import type { StringRule } from './zones.ts';
import type { BlockSpan, SourceMap, LanguageAdapter } from './source-map.ts';
import type { LineRules } from './line-edges.ts';

export interface TextRules {
  name: string;
  extensions: readonly string[];
  fileNames?: readonly string[];
  normalize: (raw: string) => string;
  zones: readonly StringRule[];
  noBrackets?: readonly StringRule[];
  lines?: LineRules;
  indentIsStructure?: boolean;
}

const CLOSER_OF: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set([')', ']', '}']);
const ENDS_STATEMENT = new Set([';', ',', '{', '}']);

export function makeTextAdapter(rules: TextRules): LanguageAdapter {
  return {
    name: rules.name,
    extensions: rules.extensions,
    fileNames: rules.fileNames,
    normalize: rules.normalize,
    grammar: undefined,
    indentIsStructure: rules.indentIsStructure,

    async init(): Promise<void> {},

    buildMap(source: string): SourceMap {
      if (typeof source !== 'string') throw new TypeError('adapter.buildMap: source is not a string');
      const canon = buildCanon(source, rules.normalize);
      const spans = bracketSpans(source, [...rules.zones, ...(rules.noBrackets ?? [])]).map((s) => {
        const out: BlockSpan = {
          open: canon.toCanonPos(s.open),
          close: canon.toCanonPos(s.close),
          closeEnd: canon.toCanonPos(s.close + 1),
        };
        if (s.headerStart !== undefined) out.headerStart = canon.toCanonPos(s.headerStart);
        return out;
      });
      return makeSourceMap(canon, spans, false, rules.lines);
    },
  };
}

interface Pair {
  open: number;
  close: number;
  headerStart?: number;
}

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
    let k = stack.length - 1;
    while (k >= 0 && CLOSER_OF[source[stack[k]!]!] !== ch) k--;
    if (k < 0) continue;
    const top = stack[k]!;
    stack.length = k;
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
