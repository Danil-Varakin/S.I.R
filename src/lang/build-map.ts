import type { Canon } from './canon.ts';
import type { SourceMap, BlockSpan } from './source-map.ts';
import { isWordChar } from './word.ts';

export function makeSourceMap(canon: Canon, spans: readonly BlockSpan[], closesByOutdent = false): SourceMap {
  const text = canon.text;
  const eof = text.length;

  const assertPos = (pos: number, name: string): void => {
    if (!Number.isInteger(pos) || pos < 0 || pos > eof) {
      throw new RangeError(`SourceMap: ${name}=${pos} out of [0, ${eof}]`);
    }
  };
  const assertNorm = (norm: string): void => {
    if (norm.length === 0) throw new Error('SourceMap: empty literal');
  };
  const assertFromTo = (from: number, to: number): void => {
    if (from > to) throw new RangeError(`SourceMap: from=${from} > to=${to}`);
  };
  const inside = (s: BlockSpan, pos: number): boolean => s.open < pos && pos <= s.close;
  // Checked when called, not when first iterated: a bad argument fails at the call.
  const checkedScan = (norm: string, from: number, to: number): Iterable<number> => {
    assertNorm(norm);
    assertPos(from, 'from');
    assertPos(to, 'to');
    assertFromTo(from, to);
    return scan(text, norm, from, to);
  };

  // the ends of the blocks with no closing token, once a map, and only where the language
  // closes by outdent: a brace language never asks
  const implicitEnds = closesByOutdent
    ? new Set(spans.filter((s) => s.closeEnd === undefined).map((s) => s.close))
    : null;

  return {
    eof,
    closesByOutdent,

    endsImplicitBlock(close: number): boolean {
      return implicitEnds !== null && implicitEnds.has(close);
    },

    matchesAt(norm: string, pos: number): boolean {
      assertNorm(norm);
      assertPos(pos, 'pos');
      return text.startsWith(norm, pos) && boundaryOk(text, norm, pos);
    },

    occurrences(norm: string, from: number, to: number): Iterable<number> {
      return checkedScan(norm, from, to);
    },

    countOccurrences(norm: string, from: number, to: number): number {
      let n = 0;
      for (const _ of checkedScan(norm, from, to)) n++;
      return n;
    },

    enclosing(pos: number): BlockSpan[] {
      assertPos(pos, 'pos');
      const out: BlockSpan[] = [];
      for (const s of spans) if (inside(s, pos)) out.push(cloneSpan(s));
      out.sort((a, b) => b.open - a.open);
      return out;
    },

    blocksWithin(from: number, to: number): BlockSpan[] {
      assertPos(from, 'from');
      assertPos(to, 'to');
      assertFromTo(from, to);
      const out: BlockSpan[] = [];
      for (const s of spans) if (s.open >= from && s.close < to) out.push(cloneSpan(s));
      out.sort((a, b) => a.open - b.open);
      return out;
    },

    toOriginalPos(pos: number, side: 'left' | 'right'): number {
      assertPos(pos, 'pos');
      if (side !== 'left' && side !== 'right') throw new Error(`SourceMap: invalid side='${String(side)}'`);
      return canon.toOriginalPos(pos, side);
    },

    toCanonPos(origPos: number): number {
      return canon.toCanonPos(origPos);
    },
  };
}

function* scan(text: string, norm: string, from: number, to: number): Generator<number> {
  for (let p = text.indexOf(norm, from); p !== -1 && p <= to; p = text.indexOf(norm, p + 1)) {
    if (boundaryOk(text, norm, p)) yield p;
  }
}

function cloneSpan(s: BlockSpan): BlockSpan {
  const out: BlockSpan = { open: s.open, close: s.close };
  if (s.headerStart !== undefined) out.headerStart = s.headerStart;
  if (s.closeEnd !== undefined) out.closeEnd = s.closeEnd;
  return out;
}

function boundaryOk(text: string, norm: string, pos: number): boolean {
  const n = norm.length;
  if (n === 0) return true;
  if (isWordChar(norm[0]!) && pos > 0 && isWordChar(text[pos - 1]!)) return false;
  const right = pos + n;
  if (isWordChar(norm[n - 1]!) && right < text.length && isWordChar(text[right]!)) return false;
  return true;
}
