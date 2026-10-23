import type { MatchPattern, Gap, Literal } from './ast.ts';
import type { SourceMap } from '../lang/source-map.ts';
import { isWordChar } from '../lang/word.ts';
import { MatchError, AmbiguityError } from './errors.ts';

export interface LocatedMark {
  pos: number;
  side: 'left' | 'right';
}

export interface MatchMarks {
  insert: LocatedMark;
  replaceEnd?: LocatedMark;
}

interface Marks {
  insert?: LocatedMark;
  replaceEnd?: LocatedMark;
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
    // Stryker disable next-line ConditionalExpression: a cache — without it a literal is normalized again, to the same text
    if (n === undefined) {
      n = normalize(lit.raw);
      // Stryker disable next-line CallExpression: a cache — see above
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

  const advance = (norm: string, A: number, stack: readonly number[]): { pos: number; stack: number[] } => {
    const B = A + norm.length;
    const s = stack.slice();
    while (s[s.length - 1]! >= A && s[s.length - 1]! < B) s.pop();
    const entered = map.enclosing(B).filter((sp) => sp.open >= A);
    for (let k = entered.length - 1; k >= 0; k--) s.push(entered[k]!.close);
    return { pos: B, stack: s };
  };

  const isCloser = (p: number, len: number): boolean =>
    map.enclosing(p).some((s) => s.close < p + len);

  // A closer met with an overdue block on the stack steps out of that block — unless the
  // language closes by outdent and the overdue block, one with no closing token, lies
  // inside a block this closer ends: the outdent closed both at once (`class B:` at column
  // 0 ends the method and the class before it).
  const closedTogether = (overdue: readonly number[], p: number, len: number): boolean => {
    if (!map.closesByOutdent || !overdue.every((c) => map.endsImplicitBlock(c))) return false;
    const closed = map.enclosing(p).filter((s) => s.close < p + len && s.closeEnd === undefined);
    return overdue.every((c) => closed.some((s) => s.open < c));
  };

  const applySide = (marks: Marks, gap: Gap, side: 'left' | 'right', at: number): Marks => {
    let m = marks;
    if (gap.insert !== undefined && gap.insert.side === side) m = { ...m, insert: { pos: at, side } };
    if (gap.replaceEnd !== undefined && gap.replaceEnd.side === side) m = { ...m, replaceEnd: { pos: at, side } };
    return m;
  };

  // Between two words the canon keeps one space, and it belongs to neither literal: in
  // `foo >>> bar` the operator took the spaces of the pattern, so `bar` would have to
  // start on that space and never could. A tight gap steps over it — only there, so a
  // pattern that fitted before fits the same (a word literal can never stand right before
  // a word, `boundaryOk`), and the marks of the gap stay before the space.
  const wordGapAt = (i: number, pos: number, norm: string): boolean => {
    const prev = i > 0 ? steps[i - 1]!.anchor : undefined;
    if (prev === undefined || prev.target !== 'literal') return false;
    const before = normOf(prev.literal);
    return isWordChar(before[before.length - 1]!) && isWordChar(norm[0]!) && map.matchesAt(' ', pos);
  };

  const recordFull = (m: Marks): void => {
    edits.set(`${m.insert!.pos}|${m.replaceEnd?.pos}`, m as MatchMarks);
    if (edits.size >= 2) stop = true;
  };

  const walk = (i: number, pos: number, stack: number[], marks: Marks, last: Matched | null): boolean => {
    if (i === steps.length) {
      if (pos !== eof) {
        recordDeepest(pos, i, undefined, last);
        return false;
      }
      recordFull(marks);
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
      return walk(i + 1, adv.pos, adv.stack, mL, { text: anchor.literal.raw, pos: at });
    }

    const W = stack[stack.length - 1] ?? -1;
    const obligation = W >= pos && map.matchesAt(norm, W);
    if (obligation) {
      const mR = applySide(mL, gap, 'right', W);
      const adv = advance(norm, W, stack);
      if (walk(i + 1, adv.pos, adv.stack, mR, { text: anchor.literal.raw, pos: W })) return true;
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
      if (walk(i + 1, adv.pos, adv.stack, mR, { text: anchor.literal.raw, pos: p })) found = true;
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
}
