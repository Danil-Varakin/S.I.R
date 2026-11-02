import type { MatchPattern, Gap, Literal } from './ast.ts';
import type { BlockSpan, SourceMap } from '../lang/source-map.ts';
import { isWordChar } from '../lang/word.ts';
import { MatchError, AmbiguityError } from './errors.ts';

export interface LocatedMark {
  pos: number;
  side: 'left' | 'right';
}

export interface Landed {
  readonly step: number;
  readonly pos: number;
  readonly len: number;
}

export interface MatchMarks {
  insert: LocatedMark;
  replaceEnd?: LocatedMark;
  landed: readonly Landed[];
}

interface Marks {
  insert?: LocatedMark;
  replaceEnd?: LocatedMark;
}

function landedOf(last: Matched | null): Landed[] {
  const out: Landed[] = [];
  for (let m = last; m !== null; m = m.prev) out.push({ step: m.step, pos: m.pos, len: m.len });
  return out.reverse();
}

export function matchPattern(
  pattern: MatchPattern,
  map: SourceMap,
  normalize: (raw: string) => string,
): MatchMarks {
  const steps = pattern.steps;
  const eof = map.eof;

  const normCache = new Map<Literal, string>();
  const normOf = (lit: Literal): string => {
    let n = normCache.get(lit);
    if (n === undefined) {
      n = normalize(lit.raw);
      normCache.set(lit, n);
    }
    return n;
  };

  const edits = new Map<string, MatchMarks>();
  let stop = false;
  let deepestPos = -1;
  let deepestStep = 0;
  let deepestAnchor: string | undefined;
  let deepestMatched: Matched | null = null;
  const recordDeepest = (pos: number, i: number, anchor: string | undefined, last: Matched | null): void => {
    if (pos > deepestPos) {
      deepestPos = pos;
      deepestStep = i;
      deepestAnchor = anchor;
      deepestMatched = last;
    }
  };
  const enclosingCache = new Map<number, BlockSpan[]>();
  const enclosing = (p: number): BlockSpan[] => {
    let spans = enclosingCache.get(p);
    if (spans === undefined) {
      spans = map.enclosing(p);
      enclosingCache.set(p, spans);
    }
    return spans;
  };

  const advance = (norm: string, A: number, stack: readonly number[]): { pos: number; stack: number[] } => {
    const B = A + norm.length;
    const s = stack.slice();
    while (s[s.length - 1]! >= A && s[s.length - 1]! < B) s.pop();
    const entered = enclosing(B).filter((sp) => sp.open >= A);
    for (let k = entered.length - 1; k >= 0; k--) s.push(entered[k]!.close);
    return { pos: B, stack: s };
  };

  const isCloser = (p: number, len: number): boolean =>
    enclosing(p).some((s) => s.close < p + len);

  const closedTogether = (overdue: readonly number[], p: number, len: number): boolean => {
    if (!map.closesByOutdent || !overdue.every((c) => map.endsImplicitBlock(c))) return false;
    const closed = enclosing(p).filter((s) => s.close < p + len && s.closeEnd === undefined);
    return overdue.every((c) => closed.some((s) => s.open < c));
  };

  const applySide = (marks: Marks, gap: Gap, side: 'left' | 'right', at: number): Marks => {
    let m = marks;
    if (gap.insert !== undefined && gap.insert.side === side) m = { ...m, insert: { pos: at, side } };
    if (gap.replaceEnd !== undefined && gap.replaceEnd.side === side) m = { ...m, replaceEnd: { pos: at, side } };
    return m;
  };

  const wordGapAt = (i: number, pos: number, norm: string): boolean => {
    const prev = i > 0 ? steps[i - 1]!.anchor : undefined;
    if (prev === undefined || prev.target !== 'literal') return false;
    const before = normOf(prev.literal);
    return isWordChar(before[before.length - 1]!) && isWordChar(norm[0]!) && map.matchesAt(' ', pos);
  };

  const recordFull = (m: Marks, last: Matched | null): void => {
    edits.set(`${m.insert!.pos}|${m.replaceEnd?.pos}`, { ...m, landed: landedOf(last) } as MatchMarks);
    if (edits.size >= 2) stop = true;
  };

  const walk = (i: number, pos: number, stack: number[], marks: Marks, last: Matched | null): boolean => {
    if (i === steps.length) {
      if (pos !== eof) {
        recordDeepest(pos, i, undefined, last);
        return false;
      }
      recordFull(marks, last);
      return true;
    }

    const { gap, anchor } = steps[i]!;
    const mL = applySide(marks, gap, 'left', pos);

    if (anchor.target === 'eof') {
      if (gap.mode.op === 'skipAny') {
        const mR = applySide(mL, gap, 'right', eof);
        return walk(i + 1, eof, stack, mR, last);
      }
      return walk(i + 1, pos, stack, mL, last);
    }

    const norm = normOf(anchor.literal);

    if (gap.mode.op === 'tight') {
      const at = wordGapAt(i, pos, norm) ? pos + 1 : pos;
      if (!map.matchesAt(norm, at)) {
        recordDeepest(pos, i, anchor.literal.raw, last);
        return false;
      }
      const adv = advance(norm, at, stack);
      return walk(i + 1, adv.pos, adv.stack, mL, { text: anchor.literal.raw, pos: at, len: norm.length, step: i, prev: last });
    }

    const W = stack[stack.length - 1] ?? -1;
    let obligation = W >= pos && map.matchesAt(norm, W);
    if (obligation && map.closesByOutdent) {
      const left = stack.filter((c) => c < W && map.endsImplicitBlock(c));
      obligation = left.length === 0 || closedTogether(left, W, norm.length);
    }
    if (obligation) {
      const mR = applySide(mL, gap, 'right', W);
      const adv = advance(norm, W, stack);
      if (walk(i + 1, adv.pos, adv.stack, mR, { text: anchor.literal.raw, pos: W, len: norm.length, step: i, prev: last })) return true;
      if (stop) return edits.size > 0;
    }

    let found = false;
    let sawCandidate = false;
    for (const p of map.occurrences(norm, pos, eof)) {
      if (obligation && p === W) continue;
      let open = stack;
      if (isCloser(p, norm.length) && stack.some((c) => c < p)) {
        const overdue = stack.filter((c) => c < p);
        if (!closedTogether(overdue, p, norm.length)) continue;
        open = stack.filter((c) => c >= p);
      }
      sawCandidate = true;
      const mR = applySide(mL, gap, 'right', p);
      const adv = advance(norm, p, open);
      if (walk(i + 1, adv.pos, adv.stack, mR, { text: anchor.literal.raw, pos: p, len: norm.length, step: i, prev: last })) found = true;
      if (stop) return edits.size > 0;
    }
    if (!found && !sawCandidate && !obligation) recordDeepest(pos, i, anchor.literal.raw, last);
    return found;
  };

  walk(0, 0, [], {}, null);

  if (edits.size === 0) throw noMatch();
  if (edits.size >= 2) {
    const positions = [...edits.values()].map((m) => map.toOriginalPos(m.insert.pos, m.insert.side));
    const ends = [...edits.values()].map(({ replaceEnd: e }) => (e === undefined ? undefined : map.toOriginalPos(e.pos, e.side)));
    throw new AmbiguityError(
      'ambiguous match: the pattern fits in more than one place — add context',
      positions,
      ends,
    );
  }
  return [...edits.values()][0]!;

  function noMatch(): MatchError {
    const ranPastEnd = deepestStep >= steps.length;
    const detail: {
      totalSteps: number;
      origPos?: number;
      anchorText?: string;
      matchedText?: string;
      matchedPos?: number;
      hint?: string;
    } = { totalSteps: steps.length, origPos: map.toOriginalPos(deepestPos, 'right') };
    if (deepestAnchor !== undefined) detail.anchorText = deepestAnchor;
    const matched: Matched | null = deepestMatched;
    if (matched !== null) {
      detail.matchedText = matched.text;
      detail.matchedPos = map.toOriginalPos(matched.pos, 'right');
    }
    if (ranPastEnd) {
      detail.hint =
        'the pattern requires the file to END here: a match block that stops without a ' +
        'trailing `...` describes the file to its last character. Add `...` at the end.';
    }
    return new MatchError(
      ranPastEnd
        ? 'no match: the pattern ran out of steps while the file went on'
        : 'no match: the pattern did not fit the file',
      deepestPos,
      deepestStep,
      detail,
    );
  }
}

interface Matched {
  readonly text: string;
  readonly pos: number;
  readonly len: number;
  readonly step: number;
  readonly prev: Matched | null;
}
