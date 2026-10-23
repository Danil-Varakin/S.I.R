import { setImmediate as nextTurn } from 'node:timers/promises';
import type { MatchPattern, Step, Gap, Anchor, Hunk } from '../core/ast.ts';
import type { LanguageAdapter, SourceMap, BlockSpan, MapCache } from '../lang/source-map.ts';
import { mapFor } from '../lang/source-map.ts';
import { matchPattern } from '../core/matcher.ts';
import { cutOf, patchHunk } from '../core/patcher.ts';
import { printPattern } from '../core/sir-printer.ts';
import { literalAsRead } from '../core/sir-parser.ts';
import { AmbiguityError, MatchError, SynthesisError, firstLineOf } from '../core/errors.ts';
import { withDraft } from './draft.ts';
import { firstLineEnd } from '../core/eol.ts';
import { changeSegments } from './diff.ts';
import type { ChangeSegment } from './diff.ts';
import { resolveLimits } from './limits.ts';
import type { PartialLimits, SynthLimits } from './limits.ts';

export { DEFAULT_SYNTH_LIMITS, resolveLimits } from './limits.ts';
export type { PartialLimits, SynthLimits } from './limits.ts';

export type SynthEvent =
  | { kind: 'segment'; index: number; total: number; seg: ChangeSegment }
  | { kind: 'attempt'; pattern: MatchPattern; result: 'unique' | 'ambiguous' | 'no-match'; matches: number }
  | { kind: 'hunk'; pattern: MatchPattern; patch: string };
export type Tracer = (event: SynthEvent) => void;

export interface SynthOptions {
  bridgeGap?: number;
  exact?: boolean;
  trace?: Tracer | undefined;
  limits?: PartialLimits | undefined;
  maps?: MapCache | undefined;
}

type MatchMarks = ReturnType<typeof matchPattern>;

interface HunkContext {
  readonly segment: ChangeSegment;
  readonly adapter: LanguageAdapter;
  readonly source: string;
  readonly map: SourceMap;
  readonly lines: string[];
  readonly lineStartOffsets: number[];
  readonly lineCount: number;
  readonly firstChangedRowIndex: number;
  readonly rowIndexAfterChange: number;
  readonly changeStartOffset: number;
  readonly changeEndOffset: number;
  readonly canonStart: number;
  readonly canonEnd: number;
  readonly parents: readonly BlockSpan[];
  readonly intendedSource: string;
  readonly normalizedIntendedLines: readonly string[];
  readonly requireExact: boolean;
  readonly limits: SynthLimits;
  readonly trace: Tracer | undefined;
  readonly hits: Map<string, number>;
}

interface ResolvedHunk {
  readonly pattern: MatchPattern;
  readonly patch: string;
  readonly appliedSource: string;
}

export function synthesize(
  oldSource: string,
  newSource: string,
  adapter: LanguageAdapter,
  options: SynthOptions = {},
): Hunk[] {
  const steps = synthesisSteps(oldSource, newSource, adapter, options);
  for (;;) {
    const step = steps.next();
    if (step.done === true) return step.value;
  }
}

export async function synthesizeAsync(
  oldSource: string,
  newSource: string,
  adapter: LanguageAdapter,
  options: SynthOptions & { readonly signal?: AbortSignal | undefined } = {},
): Promise<Hunk[]> {
  const steps = synthesisSteps(oldSource, newSource, adapter, options);
  for (;;) {
    options.signal?.throwIfAborted();
    const step = steps.next();
    if (step.done === true) return step.value;
    await nextTurn();
  }
}

function* synthesisSteps(
  oldSource: string,
  newSource: string,
  adapter: LanguageAdapter,
  options: SynthOptions,
): Generator<void, Hunk[], void> {
  const { bridgeGap = 0, exact = false } = options;
  const setup = setupOf(adapter, newSource, options);
  const segments = changeSegments(oldSource, newSource, bridgeGap);
  const hunks: Hunk[] = [];

  let currentSource = oldSource;
  let rowShift = 0;

  for (const [index, originalSegment] of segments.entries()) {
    setup.trace?.({ kind: 'segment', index, total: segments.length, seg: originalSegment });
    const segment: ChangeSegment = { ...originalSegment, oldStart: originalSegment.oldStart + rowShift };

    const context = makeHunkContext(segment, currentSource, setup);
    let resolved;
    try {
      resolved = resolveHunk(context);
    } catch (e) {
      throw e instanceof SynthesisError ? withDraft(e, hunks, segment, currentSource) : e;
    }

    hunks.push({ match: resolved.pattern, patch: resolved.patch });
    currentSource = resolved.appliedSource;
    rowShift += segment.added.length - segment.removed.length;
    yield;
  }

  const reproduced = exact ? currentSource === newSource : sameIgnoringSpace(currentSource, newSource, adapter);
  if (!reproduced) {
    const lf = exact && firstLineEnd(oldSource) === '\r\n' ? bareLfLine(newSource) : 0;
    if (lf > 0 && sameIgnoringSpace(currentSource, newSource, adapter)) {
      const because = `the new version mixes line endings (line ${lf} ends with LF)`;
      throw new SynthesisError(
        `${because}; a patch writes the endings of the base — turn exact off or make the endings one`,
        'unreproduced',
        because,
      );
    }
    const because = `${hunks.length} hunk(s) applied give another text (${exact ? 'verbatim' : 'normalized'} check)`;
    throw new SynthesisError(`the hunks do not give the new version: ${because} — a fault of synthesis`, 'unreproduced', because);
  }
  return hunks;
}

function bareLfLine(text: string): number {
  const lines = text.split('\n');
  return lines.findIndex((l, k) => k < lines.length - 1 && !l.endsWith('\r')) + 1;
}

export function synthesizeOne(
  segment: ChangeSegment,
  source: string,
  target: string,
  adapter: LanguageAdapter,
  options: SynthOptions = {},
): Hunk {
  const resolved = resolveHunk(makeHunkContext(segment, source, setupOf(adapter, target, options)));
  return { match: resolved.pattern, patch: resolved.patch };
}

interface HunkSetup {
  readonly adapter: LanguageAdapter;
  readonly targetEndsWithNewline: boolean;
  readonly requireExact: boolean;
  readonly limits: SynthLimits;
  readonly trace: Tracer | undefined;
  readonly maps: MapCache | undefined;
}

function setupOf(adapter: LanguageAdapter, target: string, options: SynthOptions): HunkSetup {
  return {
    adapter,
    targetEndsWithNewline: target.endsWith('\n'),
    requireExact: options.exact ?? false,
    limits: resolveLimits(options.limits),
    trace: options.trace,
    maps: options.maps,
  };
}

function makeHunkContext(segment: ChangeSegment, source: string, setup: HunkSetup): HunkContext {
  const { adapter, targetEndsWithNewline, requireExact, limits, trace, maps } = setup;
  const lineStartOffsets = getLineStartOffsets(source);
  const lineCount = lineStartOffsets.length - 1;
  const firstChangedRowIndex = segment.oldStart - 1;
  const rowIndexAfterChange = firstChangedRowIndex + segment.removed.length;
  if (firstChangedRowIndex < 0 || rowIndexAfterChange > lineCount) {
    throw new Error(
      `synth: segment outside the file (oldStart=${segment.oldStart}, removed=${segment.removed.length}, lines=${lineCount})`,
    );
  }
  const changeStartOffset = lineStartOffsets[firstChangedRowIndex]!;
  const changeEndOffset = lineStartOffsets[rowIndexAfterChange]!;
  const map = mapFor(adapter, source, maps);
  const canonStart = map.toCanonPos(changeStartOffset);
  const canonEnd = map.toCanonPos(changeEndOffset);

  const endsFile = changeEndOffset === source.length;
  const terminator = endsFile && !targetEndsWithNewline ? '' : '\n';
  const addedBlock = segment.added.length > 0 ? segment.added.join('\n') + terminator : '';
  const intendedSource = source.slice(0, changeStartOffset) + addedBlock + source.slice(changeEndOffset);

  return {
    segment,
    adapter,
    source,
    map,
    lines: source.split('\n'),
    lineStartOffsets,
    lineCount,
    firstChangedRowIndex,
    rowIndexAfterChange,
    changeStartOffset,
    changeEndOffset,
    canonStart,
    canonEnd,
    parents: map
      .enclosing(canonStart)
      .filter((span) => span.headerStart !== undefined && span.close >= canonEnd),
    intendedSource,
    normalizedIntendedLines: normalizedLines(intendedSource, adapter),
    requireExact,
    limits,
    trace,
    hits: new Map(),
  };
}

function resolveHunk(context: HunkContext): ResolvedHunk {
  let fallback: ResolvedHunk | undefined;
  let bestFailure: unknown;
  const tried = new Map<string, Attempt>();

  const ladder = candidatePatterns(context);
  let verdict: Attempt | undefined;

  for (;;) {
    const step = ladder.next(verdict);
    if (step.done === true) break;
    const pattern = step.value;
    const signature = patternSignature(pattern);
    const attempt = tried.get(signature) ?? verifyPattern(context, pattern);
    tried.set(signature, attempt);
    verdict = attempt;

    if ('failure' in attempt) {
      bestFailure = moreInformative(bestFailure, attempt.failure);
      continue;
    }
    if (attempt.exact || !context.requireExact) {
      context.trace?.({ kind: 'hunk', pattern, patch: attempt.hunk.patch });
      return attempt.hunk;
    }
    fallback ??= attempt.hunk;
  }

  if (fallback !== undefined) {
    context.trace?.({ kind: 'hunk', pattern: fallback.pattern, patch: fallback.patch });
    return fallback;
  }
  throw anchorFailure(context.segment, bestFailure);
}

export function anchorFailure(segment: ChangeSegment, failure: unknown): SynthesisError {
  const because = failure === undefined ? 'no pattern could be built around it' : firstLineOf(failure);
  return new SynthesisError(
    `could not anchor the change at line ${segment.newStart} of the new version — ${because}`,
    failure instanceof AmbiguityError ? 'ambiguous' : 'no-match',
    because,
    segment.newStart,
  );
}

export function moreInformative(current: unknown, next: unknown): unknown {
  if (current === undefined) return next;
  const a = rankFailure(current);
  const b = rankFailure(next);
  if (b > a) return next;
  if (b < a) return current;
  if (current instanceof MatchError && next instanceof MatchError) {
    return next.failedStepIndex > current.failedStepIndex ? next : current;
  }
  return current;
}

function rankFailure(e: unknown): number {
  if (e instanceof AmbiguityError) return 2;
  if (e instanceof MatchError) return 1;
  return 0;
}

function patternSignature(pattern: MatchPattern): string {
  return printPattern(pattern);
}

type Attempt = { hunk: ResolvedHunk; exact: boolean } | { failure: unknown };

type Ladder = Generator<MatchPattern, void, Attempt | undefined>;

function verifyPattern(context: HunkContext, pattern: MatchPattern): Attempt {
  const { map, adapter, source, trace } = context;
  let marks: MatchMarks;
  try {
    marks = matchPattern(pattern, map, adapter.normalize);
  } catch (error) {
    if (error instanceof MatchError) {
      trace?.({ kind: 'attempt', pattern, result: 'no-match', matches: 0 });
      return { failure: error };
    }
    if (error instanceof AmbiguityError) {
      trace?.({ kind: 'attempt', pattern, result: 'ambiguous', matches: error.positions.length });
      return { failure: error };
    }
    throw error;
  }
  trace?.({ kind: 'attempt', pattern, result: 'unique', matches: 1 });

  const cut = cutOf(map, marks);
  const patch = extractReplacementText(context.intendedSource, source, cut.start, cut.end);
  const appliedSource = patchHunk(source, map, marks, patch).source;
  if (appliedSource === context.intendedSource) {
    return { hunk: { pattern, patch, appliedSource }, exact: true };
  }
  if (!sameByLines(normalizedLines(appliedSource, adapter), context.normalizedIntendedLines)) {
    return { failure: new MatchError('anchor matched but did not reproduce the change', cut.start, 0) };
  }
  return { hunk: { pattern, patch, appliedSource }, exact: false };
}

export function sameIgnoringSpace(a: string, b: string, adapter: LanguageAdapter): boolean {
  return sameByLines(normalizedLines(a, adapter), normalizedLines(b, adapter));
}

function normalizedLines(text: string, adapter: LanguageAdapter): string[] {
  return text.split('\n').map((line) => adapter.normalize(line));
}

function sameByLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

function extractReplacementText(intendedSource: string, source: string, startOffset: number, endOffset: number): string {
  const suffixLength = source.length - endOffset;
  return intendedSource.slice(startOffset, intendedSource.length - suffixLength);
}

interface DetailPolicy {
  readonly base: number;
  readonly spelled: ReadonlySet<number>;
}

interface Policies {
  readonly parent: DetailPolicy;
  readonly sibling: DetailPolicy;
  readonly widened: ReadonlySet<number>;
  readonly pressed: boolean;
}

type PolicyOwner = 'parent' | 'sibling';

interface Generalized {
  readonly owner: PolicyOwner;
  readonly from: number;
  readonly to: number;
  readonly collapsed: readonly BlockSpan[];
  readonly candidates: readonly BlockSpan[];
  readonly widen?: { readonly parentOpen: number; readonly to: number };
}

function withSpelled(policies: Policies, owner: PolicyOwner, open: number): Policies {
  const next = new Set(policies[owner].spelled);
  next.add(open);
  return { ...policies, [owner]: { base: policies[owner].base, spelled: next } };
}

function withWidened(policies: Policies, parentOpen: number): Policies {
  const next = new Set(policies.widened);
  next.add(parentOpen);
  return { ...policies, widened: next };
}

type Move =
  | { kind: 'spell'; owner: PolicyOwner; open: number }
  | { kind: 'widen'; parentOpen: number };

function mostSelective(
  context: HunkContext,
  generalized: readonly Generalized[],
  policies: Policies,
): Move | null {
  let best: { move: Move; drop: number; width: number } | null = null;
  const offer = (move: Move, drop: number, width: number): void => {
    if (drop <= 0) return;
    if (best === null || drop > best.drop || (drop === best.drop && width < best.width)) {
      best = { move, drop, width };
    }
  };

  for (const g of generalized) {
    const policy = policies[g.owner];
    const before = selectivity(context, g, policy);

    if (g.collapsed.length > 0) {
      for (const span of g.candidates) {
        const after = selectivity(context, g, {
          base: policy.base,
          spelled: new Set([...policy.spelled, span.open]),
        });
        offer({ kind: 'spell', owner: g.owner, open: span.open }, before - after, span.close - span.open);
      }
    }

    if (g.widen !== undefined) {
      const wider = { ...g, to: g.widen.to };
      const after = selectivity(context, wider, policy);
      offer({ kind: 'widen', parentOpen: g.widen.parentOpen }, before - after, g.widen.to - g.to);
    }
  }
  return best === null ? null : (best as { move: Move }).move;
}

function selectivity(context: HunkContext, g: Generalized, policy: DetailPolicy): number {
  const steps = stepsForRange(context, g.from, g.to, policy, null, g.owner);
  let fewest = Number.POSITIVE_INFINITY;
  for (const step of steps) {
    if (step.anchor.target !== 'literal') continue;
    const norm = context.adapter.normalize(step.anchor.literal.raw);
    if (norm === '') continue;
    let n = context.hits.get(norm);
    if (n === undefined) {
      n = context.map.countOccurrences(norm, 0, context.map.eof);
      context.hits.set(norm, n);
    }
    fewest = Math.min(fewest, n);
  }
  return fewest === Number.POSITIVE_INFINITY ? 0 : fewest;
}

function* candidatePatterns(context: HunkContext): Ladder {
  for (const cut of cutForms(context)) yield* contextLadder(context, cut, false);
  for (const cut of cutForms(context)) yield* contextLadder(context, cut, true);
}

function* contextLadder(context: HunkContext, cut: Cut, pressed: boolean): Ladder {
  const { minParents, maxParents, minSiblings, maxSiblings, parentsRequired } = context.limits;

  const available = context.parents.length;
  const topParents = maxParents === 'all' ? available : Math.min(maxParents, available);
  const baseParents = Math.min(minParents, topParents);
  const baseAbove = Math.min(minSiblings, maxSiblings);

  for (let parents = baseParents; parents <= topParents && !pressed; parents++) {
    yield* rung(context, cut, parents, baseAbove, 0, false);
  }
  for (let distance = 1; distance <= 2 * maxSiblings - baseAbove; distance++) {
    for (let extraAbove = 0; extraAbove <= Math.min(distance, maxSiblings - baseAbove); extraAbove++) {
      const below = distance - extraAbove;
      if (below > maxSiblings) continue;
      if (below > 0 || !pressed) yield* rung(context, cut, topParents, baseAbove + extraAbove, below, pressed);
    }
  }
  if (baseParents > 0 && !parentsRequired && !pressed) {
    yield* rung(context, cut, 0, baseAbove, 0, false);
  }
}

function* rung(
  context: HunkContext,
  cut: Cut,
  parentCount: number,
  aboveRows: number,
  belowRows: number,
  pressed: boolean,
): Ladder {
  let policies: Policies = {
    parent: { base: context.limits.parentDetailBase, spelled: new Set() },
    sibling: { base: context.limits.siblingDetailBase, spelled: new Set() },
    widened: new Set(),
    pressed,
  };

  for (;;) {
    const built = patternFor(context, cut, parentCount, policies, aboveRows, belowRows);
    if (built === null) return;

    const verdict = yield built.pattern;
    if (verdict === undefined || !('failure' in verdict)) return;
    if (!(verdict.failure instanceof AmbiguityError)) return;

    const pick = mostSelective(context, built.generalized, policies);
    if (pick === null) return;
    policies =
      pick.kind === 'spell'
        ? withSpelled(policies, pick.owner, pick.open)
        : withWidened(policies, pick.parentOpen);
  }
}

function patternFor(
  context: HunkContext,
  cut: Cut,
  parentCount: number,
  policies: Policies,
  aboveRows: number,
  belowRows: number,
): { pattern: MatchPattern; generalized: Generalized[] } | null {
  const minBelow = cut.pinsRight ? Math.min(context.limits.minSiblings, context.limits.maxSiblings) : 0;
  const generalized: Generalized[] = [];
  const lead = buildLead(context, parentCount, policies, cut.needsAbove ? aboveRows : 0, generalized);
  if (needsFlushLead(cut) && !flushGapCanClose(context, generalized)) return null;
  const tail = buildTail(context, parentCount, policies, Math.max(belowRows, minBelow), generalized);
  const pattern = assemblePattern(context, lead, cut, tail);
  return pattern === null ? null : { pattern, generalized };
}

function needsFlushLead(cut: Cut): boolean {
  return (cut.kind === 'context' || cut.kind === 'contextAbove') && cut.looseLeft !== true;
}

function flushGapCanClose(context: HunkContext, leadRanges: readonly Generalized[]): boolean {
  const last = leadRanges[leadRanges.length - 1];
  if (last === undefined) return true;
  const { map, source, adapter } = context;
  const leadEnd = map.toOriginalPos(map.toCanonPos(last.to), 'left');
  const cutStart = map.toOriginalPos(context.canonStart, 'right');
  if (cutStart <= leadEnd) return true;
  return adapter.normalize(source.slice(leadEnd, cutStart)) === '';
}

type Cut =
  | { kind: 'insert'; side: 'left' | 'right'; needsAbove: boolean; pinsRight: boolean; allowEdge: boolean; looseLeft?: false }
  | { kind: 'exact'; needsAbove: false; pinsRight: false; looseLeft?: false }
  | { kind: 'context'; needsAbove: true; pinsRight: true; allowEdge: boolean; looseLeft?: boolean }
  | { kind: 'contextBelow'; needsAbove: false; pinsRight: true; allowEdge: boolean; looseLeft?: false }
  | { kind: 'contextAbove'; needsAbove: true; pinsRight: false; allowEdge: boolean; looseLeft?: boolean }
  | { kind: 'span'; needsAbove: true; pinsRight: true; allowEdge: boolean; looseLeft?: false };

function* cutForms(context: HunkContext): Generator<Cut> {
  const { segment, map, parents, canonStart, canonEnd } = context;

  if (segment.removed.length === 0) {
    const atBlockEnd = parents.length > 0 && canonStart === parents[0]!.close;
    const atFileEnd = canonStart === map.eof;
    const toLeft: Cut = { kind: 'insert', side: 'left', needsAbove: true, pinsRight: false, allowEdge: true };
    const toRight: Cut = { kind: 'insert', side: 'right', needsAbove: false, pinsRight: true, allowEdge: true };
    if (atBlockEnd || atFileEnd) yield* [toRight, toLeft];
    else yield* [toLeft, toRight];
    yield { kind: 'span', needsAbove: true, pinsRight: true, allowEdge: true };
    return;
  }

  if (canonStart === 0 && canonEnd === map.eof) {
    yield { kind: 'span', needsAbove: true, pinsRight: true, allowEdge: true };
  }
  if (segment.added.length > 0 && preservesBoundaryWhitespace(segment.removed, segment.added)) {
    yield { kind: 'exact', needsAbove: false, pinsRight: false };
  }
  yield { kind: 'context', needsAbove: true, pinsRight: true, allowEdge: false };
  yield { kind: 'contextBelow', needsAbove: false, pinsRight: true, allowEdge: false };
  yield { kind: 'contextAbove', needsAbove: true, pinsRight: false, allowEdge: false };
  yield { kind: 'span', needsAbove: true, pinsRight: true, allowEdge: false };
  yield { kind: 'context', needsAbove: true, pinsRight: true, allowEdge: false, looseLeft: true };
  yield { kind: 'contextAbove', needsAbove: true, pinsRight: false, allowEdge: false, looseLeft: true };
  yield { kind: 'context', needsAbove: true, pinsRight: true, allowEdge: true };
  yield { kind: 'span', needsAbove: true, pinsRight: true, allowEdge: true };
}

function assemblePattern(context: HunkContext, lead: Step[], cut: Cut, tail: Tail): MatchPattern | null {
  const [first, ...rest] = tail.steps;
  const head = first!;

  if (cut.needsAbove && !(lead.length > 0 || (cut.allowEdge && context.canonStart === 0))) return null;
  if (cut.pinsRight && !(tail.startCanon === context.canonEnd && (cut.allowEdge || head.anchor.target === 'literal'))) {
    return null;
  }

  const removedAnchor = (): Anchor | null =>
    literalAnchor(context, context.segment.removed.join('\n'));
  const fromRemoved = (anchor: Anchor): Step => ({ gap: markedGap(skipGap(), ['insert', 'right']), anchor });
  const afterLead = (anchor: Anchor): Step => ({
    gap: markedGap(cut.looseLeft === true ? skipGap() : tightGap(), ['insert', 'left']),
    anchor,
  });

  switch (cut.kind) {
    case 'insert':
      return pattern(lead, [withMarks(head, ['insert', cut.side]), ...rest]);

    case 'exact': {
      const removed = removedAnchor();
      if (removed === null) return null;
      return pattern(lead, [fromRemoved(removed), withMarks(head, ['replaceEnd', 'left']), ...rest]);
    }
    case 'context': {
      const removed = removedAnchor();
      if (removed === null) return null;
      return pattern(lead, [afterLead(removed), withMarks(head, ['replaceEnd', 'right']), ...rest]);
    }
    case 'contextBelow': {
      const removed = removedAnchor();
      if (removed === null) return null;
      return pattern(lead, [fromRemoved(removed), withMarks(head, ['replaceEnd', 'right']), ...rest]);
    }
    case 'contextAbove': {
      const removed = removedAnchor();
      if (removed === null) return null;
      return pattern(lead, [afterLead(removed), withMarks(head, ['replaceEnd', 'left']), ...rest]);
    }
    case 'span': {
      const spanned = pattern(lead, [withMarks(head, ['insert', 'left'], ['replaceEnd', 'right']), ...rest]);
      // A replacement that names nothing — no literal at all — fits every file, and would
      // write over whatever stands there: a one-line file whose line changed gave
      // `>>> ... <<<`, and applied over upstream's version erased what upstream added
      // (07-findings Н5). Such a span spells what it replaces, as the other cuts do: it
      // then fits only a file that still holds that text.
      if (context.segment.removed.length > 0 && !spanned.steps.some((s) => s.anchor.target === 'literal')) {
        const removed = removedAnchor();
        if (removed !== null) return pattern(lead, [fromRemoved(removed), withMarks(head, ['replaceEnd', 'left']), ...rest]);
      }
      return spanned;
    }
  }
}

function pattern(lead: Step[], rest: Step[]): MatchPattern {
  return { steps: [...lead, ...rest] };
}

function buildLead(
  context: HunkContext,
  parentCount: number,
  policies: Policies,
  aboveRows: number,
  generalized: Generalized[],
): Step[] {
  const steps: Step[] = [];
  for (let i = parentCount - 1; i >= 0; i--) {
    steps.push(...headerSteps(context, context.parents[i]!, i, policies, generalized));
  }
  steps.push(...neighbourStepsAbove(context, aboveRows, policies.sibling, generalized));
  return steps;
}

interface Tail {
  readonly steps: Step[];
  readonly startCanon: number;
}

function buildTail(
  context: HunkContext,
  parentCount: number,
  policies: Policies,
  belowRows: number,
  generalized: Generalized[],
): Tail {
  const steps: Step[] = [];
  let startCanon: number | null = null;

  if (belowRows > 0) {
    const below = neighbourStepsBelow(context, belowRows, policies.sibling, generalized);
    if (below.length > 0) {
      if (policies.pressed) below[0] = { gap: tightGap(), anchor: below[0]!.anchor };
      steps.push(...below);
      startCanon = context.canonEnd;
    }
  }
  for (let i = 0; i < parentCount; i++) {
    const span = context.parents[i]!;
    if (span.closeEnd === undefined && i > 0 && context.parents[i - 1]!.close === span.close) continue;
    const closer = closerStep(context, span);
    if (closer === null) break;
    steps.push(closer);
    startCanon ??= context.parents[i]!.close;
  }
  steps.push(skipStep(EOF_ANCHOR));
  return { steps, startCanon: startCanon ?? context.map.eof };
}

function headerSteps(
  context: HunkContext,
  span: BlockSpan,
  index: number,
  policies: Policies,
  generalized: Generalized[],
): Step[] {
  const { map } = context;
  const from = map.toOriginalPos(span.headerStart ?? span.open, 'right');
  const plain = map.toOriginalPos(span.open + 1, 'left');
  const inwards = headerWidenBoundary(context, span, index);
  const widened = policies.widened.has(span.open) && inwards !== null;
  const to = widened ? inwards! : plain;

  const before = generalized.length;
  const steps = stepsForRange(context, from, to, policies.parent, generalized, 'parent');
  if (!widened && inwards !== null && generalized.length > before) {
    const g = generalized[generalized.length - 1]!;
    generalized[generalized.length - 1] = { ...g, widen: { parentOpen: span.open, to: inwards } };
  }
  return steps;
}

function headerWidenBoundary(context: HunkContext, span: BlockSpan, index: number): number | null {
  const { map, parents } = context;
  const inner = index > 0 ? parents[index - 1]! : null;
  const canonEdge = inner === null ? context.canonStart : inner.headerStart ?? inner.open;
  if (canonEdge <= span.open + 1 || canonEdge > span.close) return null;
  const to = map.toOriginalPos(canonEdge, 'left');
  return to > map.toOriginalPos(span.open + 1, 'left') ? to : null;
}

function closerStep(context: HunkContext, span: BlockSpan): Step | null {
  const { map, source } = context;
  if (span.closeEnd !== undefined) {
    const raw = source.slice(map.toOriginalPos(span.close, 'right'), map.toOriginalPos(span.closeEnd, 'left'));
    const anchor = literalAnchor(context, raw);
    return anchor === null ? null : skipStep(anchor);
  }
  const start = map.toOriginalPos(span.close, 'right');
  if (start >= source.length) return null;
  const lineEnd = source.indexOf('\n', start);
  const raw = source.slice(start, lineEnd === -1 ? source.length : lineEnd);
  const anchor = literalAnchor(context, raw);
  return anchor === null ? null : skipStep(anchor);
}

function neighbourStepsAbove(
  context: HunkContext,
  rows: number,
  policy: DetailPolicy,
  generalized: Generalized[],
): Step[] {
  const { parents, map, lines, lineStartOffsets, firstChangedRowIndex } = context;
  const limit = parents.length > 0 ? map.toOriginalPos(parents[0]!.open + 1, 'right') : 0;

  let row = firstChangedRowIndex;
  let taken = 0;
  while (row > 0 && taken < rows && lineStartOffsets[row - 1]! >= limit) {
    row--;
    if (!isBlankLine(lines[row])) taken++;
  }
  const from = taken < rows ? limit : Math.max(lineStartOffsets[row]!, limit);
  return stepsForRange(context, from, context.changeStartOffset, policy, generalized, 'sibling');
}

function neighbourStepsBelow(
  context: HunkContext,
  rows: number,
  policy: DetailPolicy,
  generalized: Generalized[],
): Step[] {
  const { parents, map, lines, lineStartOffsets, lineCount, rowIndexAfterChange } = context;
  const limit = parents.length > 0 ? map.toOriginalPos(parents[0]!.close, 'right') : context.source.length;

  let row = rowIndexAfterChange;
  let taken = 0;
  while (row < lineCount && taken < rows && lineStartOffsets[row]! < limit) {
    if (!isBlankLine(lines[row])) taken++;
    row++;
  }
  const to = Math.min(taken < rows ? limit : lineStartOffsets[row]!, limit);
  return stepsForRange(context, context.changeEndOffset, to, policy, generalized, 'sibling');
}

function stepsForRange(
  context: HunkContext,
  from: number,
  to: number,
  policy: DetailPolicy,
  generalized: Generalized[] | null,
  owner: PolicyOwner,
): Step[] {
  if (to <= from) return [];
  const { map } = context;
  const canonFrom = map.toCanonPos(from);
  const canonTo = map.toCanonPos(to);
  if (canonTo <= canonFrom) return [];

  const within = map.blocksWithin(canonFrom, canonTo);
  const collapsed = bracketsToGeneralize(within, policy);
  if (generalized !== null) {
    const candidates = within.filter((span) => span.close > span.open + 1 && !policy.spelled.has(span.open));
    generalized.push({ owner, from, to, collapsed, candidates });
  }

  const steps: Step[] = [];
  let cursor = canonFrom;
  for (const bracket of collapsed) {
    appendLiteralSegment(context, steps, cursor, bracket.open + 1);
    cursor = bracket.close;
  }
  appendLiteralSegment(context, steps, cursor, canonTo);
  return steps;
}

function bracketsToGeneralize(within: readonly BlockSpan[], policy: DetailPolicy): BlockSpan[] {
  const out: BlockSpan[] = [];
  const open: number[] = [];
  for (const span of within) {
    while (open.length > 0 && open[open.length - 1]! <= span.open) open.pop();
    const depth = open.length;
    open.push(span.close);
    if (span.close <= span.open + 1) continue;
    if (depth < policy.base) continue;
    if (policy.spelled.has(span.open)) continue;
    if (containsSpelled(span, policy.spelled)) continue;
    if (out.length > 0 && span.open < out[out.length - 1]!.close) continue;
    out.push(span);
  }
  return out;
}

function containsSpelled(span: BlockSpan, spelled: ReadonlySet<number>): boolean {
  for (const open of spelled) if (open > span.open && open < span.close) return true;
  return false;
}

function appendLiteralSegment(context: HunkContext, steps: Step[], canonFrom: number, canonTo: number): void {
  if (canonTo <= canonFrom) return;
  const { source, map, lineStartOffsets } = context;
  let start = map.toOriginalPos(canonFrom, 'right');
  const end = map.toOriginalPos(canonTo, 'left');
  const lineStart = lineStartOffsets[findRowIndexAt(lineStartOffsets, start)]!;
  if (source.slice(lineStart, start).trim() === '') start = lineStart;

  const anchor = literalAnchor(context, source.slice(start, end));
  if (anchor !== null) steps.push(skipStep(anchor));
}

function literalAnchor(context: HunkContext, written: string): Anchor | null {
  // the anchor as `apply` will read it, so that it is verified as read: a blank line
  // inside it is no part of a literal, and the Python canon would miss it
  const raw = literalAsRead(written);
  if (context.adapter.normalize(raw) === '') return null;
  return { target: 'literal', literal: { raw, mdSpan: [0, 0] } };
}

export function getLineStartOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) offsets.push(i + 1);
  if (offsets[offsets.length - 1] !== text.length) offsets.push(text.length);
  return offsets;
}

function findRowIndexAt(lineStartOffsets: number[], offset: number): number {
  let lo = 0;
  let hi = lineStartOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (lineStartOffsets[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function isBlankLine(line: string | undefined): boolean {
  return (line ?? '').trim() === '';
}

function preservesBoundaryWhitespace(removed: string[], added: string[]): boolean {
  return (
    added[0]!.startsWith(getLeadingWhitespace(removed[0]!)) &&
    getTrailingWhitespace(removed[removed.length - 1]!) === getTrailingWhitespace(added[added.length - 1]!)
  );
}

function getLeadingWhitespace(line: string): string {
  return /^[ \t]*/.exec(line)![0];
}
function getTrailingWhitespace(line: string): string {
  return /[ \t]*$/.exec(line)![0];
}

const EOF_ANCHOR: Anchor = { target: 'eof' };

type Mark = ['insert' | 'replaceEnd', 'left' | 'right'];

function skipGap(): Gap {
  return { mode: { op: 'skipAny' } };
}
function tightGap(): Gap {
  return { mode: { op: 'tight' } };
}
function markedGap(gap: Gap, ...marks: Mark[]): Gap {
  for (const [mark, side] of marks) gap[mark] = { side, mdLine: 0 };
  return gap;
}
function skipStep(anchor: Anchor): Step {
  return { gap: skipGap(), anchor };
}
function withMarks(step: Step, ...marks: Mark[]): Step {
  const tight = step.gap.mode.op === 'tight';
  const sided = marks.map(([mark, side]): Mark => [mark, tight ? 'left' : side]);
  return { gap: markedGap({ mode: step.gap.mode }, ...sided), anchor: step.anchor };
}
