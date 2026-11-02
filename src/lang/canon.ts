export interface Canon {
  source: string;
  text: string;
  toCanonPos(origPos: number): number;
  toOriginalPos(canonPos: number, side: 'left' | 'right'): number;
}

export function buildCanon(
  source: string,
  canonicalize: (s: string) => string,
): Canon {
  const text = canonicalize(source);
  const origAt = nonWsIndices(source);
  const canonAt = nonWsIndices(text);
  const nonWsCount = origAt.length;

  if (nonWsCount !== canonAt.length) {
    throw new Error(
      `canon: non-whitespace desync (${nonWsCount} in original, ${canonAt.length} in canon) — normalize touched more than whitespace`,
    );
  }

  return {
    source,
    text,
    toCanonPos(origPos: number): number {
      if (!Number.isInteger(origPos) || origPos < 0 || origPos > source.length) {
        throw new RangeError(`canon.toCanonPos: origPos=${origPos} out of [0, ${source.length}]`);
      }
      const rank = lowerBound(origAt, origPos);
      return rank < nonWsCount ? canonAt[rank]! : text.length;
    },
    toOriginalPos(canonPos: number, side: 'left' | 'right'): number {
      if (!Number.isInteger(canonPos) || canonPos < 0 || canonPos > text.length) {
        throw new RangeError(`canon.toOriginalPos: canonPos=${canonPos} out of [0, ${text.length}]`);
      }
      if (side !== 'left' && side !== 'right') {
        throw new Error(`canon.toOriginalPos: side='${String(side)}'`);
      }
      const cnt = lowerBound(canonAt, canonPos);
      if (side === 'left') return cnt === 0 ? 0 : origAt[cnt - 1]! + 1;
      return cnt < nonWsCount ? origAt[cnt]! : source.length;
    },
  };
}

function nonWsIndices(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (!isSpace(s.charCodeAt(i))) out.push(i);
  }
  return out;
}

function lowerBound(arr: number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function isSpace(code: number): boolean {
  return (
    code === 0x20 ||
    (code >= 0x09 && code <= 0x0d) ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}
