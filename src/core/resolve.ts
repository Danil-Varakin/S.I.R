import type { HatchFile, Hunk } from './ast.ts';
import type { LanguageAdapter, SourceMap, MapCache } from '../lang/source-map.ts';
import { mapFor } from '../lang/source-map.ts';
import type { Edit } from './patcher.ts';
import { matchPattern } from './matcher.ts';
import { applyEdit } from './patcher.ts';
import { planHunk } from './apply.ts';
import { AmbiguityError, MatchError } from './errors.ts';

export interface Span {
  readonly start: number;
  readonly end: number;
}

export type LinkStatus = 'ok' | 'no-match' | 'ambiguous' | 'error';

export interface LinkFailure {
  readonly kind: string;
  readonly message: string;
  readonly mdLine?: number;
  readonly failedStepIndex?: number;
  readonly totalSteps?: number;
  readonly origPos?: number;
  readonly anchorText?: string;
  readonly candidates?: readonly number[];
}

export interface HunkLink {
  readonly index: number;
  readonly status: LinkStatus;
  readonly mdSpan?: readonly [number, number];
  /** the hunk's `# note` text, when it has one. Protocol 4. */
  readonly note?: string;
  /** lines of the `.hatch` from `# note` to its `# end`. Protocol 4. */
  readonly noteSpan?: readonly [number, number];
  readonly base?: Span;
  readonly final?: Span;
  readonly finalText?: string;
  readonly dependsOnEarlier: boolean;
  readonly failure?: LinkFailure;
}

export interface ResolveResult {
  readonly links: readonly HunkLink[];
  readonly applied: string;
}

export function resolveHunks(
  baseline: string,
  file: HatchFile,
  adapter: LanguageAdapter,
  maps?: MapCache,
): ResolveResult {
  const baselineMap = mapFor(adapter, baseline, maps);
  const staged: (Edit | null)[] = [];
  const drafts: Draft[] = [];
  let current = baseline;

  for (const [index, hunk] of file.hunks.entries()) {
    const untouched = current === baseline;
    const map = untouched ? baselineMap : mapFor(adapter, current, maps);
    try {
      const edit = planHunk(current, map, hunk, adapter);
      drafts.push({
        index,
        hunk,
        edit,
        dependsOnEarlier: untouched ? false : !fitsBaseline(hunk, baselineMap, adapter),
      });
      staged.push(edit);
      current = applyEdit(current, edit);
    } catch (e) {
      drafts.push({ index, hunk, edit: null, dependsOnEarlier: false, failure: describe(e, hunk) });
      staged.push(null);
    }
  }

  return { links: drafts.map((d) => project(d, staged, current)), applied: current };
}

/** A hunk laid — or, with no edit, refused, and then always with what it failed with. */
type Draft =
  | { readonly index: number; readonly hunk: Hunk; readonly edit: Edit; readonly dependsOnEarlier: boolean }
  | { readonly index: number; readonly hunk: Hunk; readonly edit: null; readonly dependsOnEarlier: false; readonly failure: LinkFailure };

function project(draft: Draft, staged: readonly (Edit | null)[], applied: string): HunkLink {
  const mdSpan = draft.hunk.mdSpan;
  const note = draft.hunk.note;
  const noted = note !== undefined ? { note: note.text, noteSpan: note.mdSpan } : {};
  if (draft.edit === null) {
    const failure = draft.failure;
    return {
      index: draft.index,
      status: statusOf(failure.kind),
      dependsOnEarlier: false,
      ...(mdSpan !== undefined ? { mdSpan } : {}),
      ...noted,
      failure,
    };
  }

  let base: Span = { start: draft.edit.start, end: draft.edit.end };
  for (let j = draft.index - 1; j >= 0; j--) {
    const earlier = staged[j];
    if (earlier === null || earlier === undefined) continue;
    base = spanBack(base, earlier);
  }
  const { start: baseStart, end: baseEnd } = base;

  let final: Span = { start: draft.edit.start, end: draft.edit.start + draft.edit.text.length };
  for (let j = draft.index + 1; j < staged.length; j++) {
    const later = staged[j];
    if (later === null || later === undefined) continue;
    final = spanThrough(final, later);
  }
  const { start: finalStart, end: finalEnd } = final;

  return {
    index: draft.index,
    status: 'ok',
    dependsOnEarlier: draft.dependsOnEarlier,
    base: { start: baseStart, end: baseEnd },
    final: { start: finalStart, end: finalEnd },
    finalText: applied.slice(finalStart, finalEnd),
    ...(mdSpan !== undefined ? { mdSpan } : {}),
    ...noted,
  };
}

/** Where `span` of the text after `edit` was before it. What `edit` replaced is never
 *  inside the span — the start goes past it, the end stays before it; inside what `edit`
 *  wrote the baseline has no place, and both go to where the edit writes. */
function spanBack(span: Span, edit: Edit): Span {
  const start = backThrough(span.start, edit, 'start');
  const end = backThrough(span.end, edit, 'end');
  return end < start ? { start: end, end } : { start, end };
}

function backThrough(pos: number, edit: Edit, side: 'start' | 'end'): number {
  if (side === 'start' ? pos < edit.start : pos <= edit.start) return pos;
  const writtenEnd = edit.start + edit.text.length;
  if (pos >= writtenEnd) return pos - edit.text.length + (edit.end - edit.start);
  return edit.start; // inside what the edit wrote — the baseline has no such place
}

/** Where `span` of the text before `edit` is after it — the projection `resolve` does
 *  for `final`, for a caller that lays hunks one at a time (`generate/steer.ts`). What
 *  `edit` writes is never inside the span: the start goes past it, the end stays before
 *  it. A span `edit` replaced whole is left empty where it stood. */
export function spanThrough(span: Span, edit: Edit): Span {
  const start = startThrough(span.start, edit);
  const end = endThrough(span.end, edit);
  return end < start ? { start: end, end } : { start, end };
}

function startThrough(pos: number, edit: Edit): number {
  if (pos < edit.start) return pos;
  if (pos >= edit.end) return pos + edit.text.length - (edit.end - edit.start);
  return edit.start + edit.text.length; // inside what the edit replaced — the rest follows its text
}

function endThrough(pos: number, edit: Edit): number {
  if (pos <= edit.start) return pos;
  if (pos > edit.end) return pos + edit.text.length - (edit.end - edit.start);
  return edit.start; // up to the end of what the edit replaced — the rest precedes its text
}

function fitsBaseline(hunk: Hunk, baselineMap: SourceMap, adapter: LanguageAdapter): boolean {
  try {
    matchPattern(hunk.match, baselineMap, adapter.normalize);
    return true;
  } catch {
    return false;
  }
}

function statusOf(kind: string): LinkStatus {
  if (kind === 'MatchError') return 'no-match';
  if (kind === 'AmbiguityError') return 'ambiguous';
  return 'error';
}

function describe(e: unknown, hunk: Hunk): LinkFailure {
  const message = e instanceof Error ? e.message : String(e);

  if (e instanceof MatchError) {
    const mdLine = anchorLine(hunk, e.failedStepIndex);
    return {
      kind: 'MatchError',
      message,
      failedStepIndex: e.failedStepIndex,
      ...(mdLine !== undefined ? { mdLine } : {}),
      ...(e.totalSteps !== undefined ? { totalSteps: e.totalSteps } : {}),
      ...(e.origPos !== undefined ? { origPos: e.origPos } : {}),
      ...(e.anchorText !== undefined ? { anchorText: e.anchorText } : {}),
    };
  }

  if (e instanceof AmbiguityError) {
    return { kind: 'AmbiguityError', message, candidates: e.positions };
  }

  return { kind: e instanceof Error ? e.name : 'Error', message };
}

function anchorLine(hunk: Hunk, stepIndex: number): number | undefined {
  const step = hunk.match.steps[stepIndex];
  if (step === undefined || step.anchor.target !== 'literal') return undefined;
  return step.anchor.literal.mdSpan[0];
}
