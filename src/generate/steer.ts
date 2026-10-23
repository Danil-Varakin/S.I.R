import type { Hunk } from '../core/ast.ts';
import { SirError, SynthesisError, firstLineOf } from '../core/errors.ts';
import { MATCH_HEADING, NOTE_HEADING, parseSirFile } from '../core/sir-parser.ts';
import { resolveHunks, spanThrough } from '../core/resolve.ts';
import { planHunk } from '../core/apply.ts';
import { applyEdit } from '../core/patcher.ts';
import { mapFor } from '../lang/source-map.ts';
import type { Span } from '../core/resolve.ts';
import { checkHeading } from '../lang/adapter.ts';
import type { LanguageAdapter, MapCache } from '../lang/source-map.ts';
import { InputClosed } from '../infra/ask.ts';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { changeSegments } from './diff.ts';
import type { ChangeSegment } from './diff.ts';
import { printSirFile } from './printer.ts';
import { template, withDraft } from './draft.ts';
import { getLineStartOffsets, sameIgnoringSpace, synthesizeOne } from './synth.ts';
import type { PartialLimits, Tracer } from './synth.ts';

export type Verdict =
  | 'keep'
  | 'skip'
  | 'decline';

export interface Steering {
  readonly review?: ((hunk: Hunk, number: number, total: number) => Promise<Verdict>) | undefined;
  readonly offerEdit: (why: string) => Promise<boolean>;
  readonly edit: (text: string) => Promise<string>;
}

export interface SteerRequest {
  readonly oldText: string;
  readonly newText: string;
  readonly adapter: LanguageAdapter;
  readonly label: string;
  readonly bridgeGap: number;
  readonly exact: boolean;
  readonly limits?: PartialLimits | undefined;
  readonly trace?: Tracer | undefined;
  readonly maps?: MapCache | undefined;
  readonly keep?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export const unattended: Steering = {
  offerEdit: async () => false,
  edit: () => {
    throw new Error('unattended synthesis has no editor');
  },
};

export interface Steered {
  readonly hunks: readonly Hunk[];
  readonly reproducesNew: boolean;
}

export async function steerSynthesis(request: SteerRequest, steering: Steering): Promise<Steered> {
  const { oldText, newText, adapter, bridgeGap, exact, trace, maps, signal } = request;
  let state: Laid = request.keep === undefined ? { hunks: [], current: oldText, settled: [] } : replayed(kept(request.keep, request), request);
  let target = newText;

  for (;;) {
    signal?.throwIfAborted();
    if (signal !== undefined) await nextTurn();
    const { hunks, current, settled } = state;
    const offsets = getLineStartOffsets(current);
    const pending = changeSegments(current, target, bridgeGap).filter((s) => !touches(s, offsets, settled));
    if (pending.length === 0) {
      return { hunks, reproducesNew: exact ? current === newText : sameIgnoringSpace(current, newText, adapter) };
    }

    const segment = pending[0]!;
    const number = hunks.length + 1;
    const total = hunks.length + pending.length;
    trace?.({ kind: 'segment', index: hunks.length, total, seg: segment });

    let candidate: Hunk;
    try {
      candidate = synthesizeOne(segment, current, target, adapter, { bridgeGap, exact, limits: request.limits, trace, maps });
    } catch (e) {
      if (!(e instanceof SynthesisError)) throw e;
      const why = `hunk ${number}: the change at line ${segment.oldStart} could not be anchored — ${e.because}`;
      if (!(await steering.offerEdit(why))) throw withDraft(e, hunks, segment, current);
      state = replayed(await editUntilItStands([...hunks, template(segment, current)], why, segment, request, steering), request);
      continue;
    }

    const verdict = await verdictOn(candidate, number, total, steering);
    if (verdict === 'keep') {
      state = laidOn(state, candidate, request);
    } else if (verdict === 'skip') {
      target = leftOut(segment, target);
    } else {
      const why = `hunk ${number}: declined`;
      if (!(await steering.offerEdit(why))) throw new Error(`${why} — nothing was written`);
      state = replayed(await editUntilItStands([...hunks, candidate], why, segment, request, steering), request);
    }
  }
}

interface Laid {
  readonly hunks: readonly Hunk[];
  readonly current: string;
  readonly settled: readonly Span[];
}

function laidOn(state: Laid, hunk: Hunk, request: SteerRequest): Laid {
  const { adapter, maps } = request;
  const edit = planHunk(state.current, mapFor(adapter, state.current, maps), hunk, adapter);
  return {
    hunks: [...state.hunks, hunk],
    current: applyEdit(state.current, edit),
    settled: [...state.settled.map((span) => spanThrough(span, edit)), { start: edit.start, end: edit.start + edit.text.length }],
  };
}

function replayed(hunks: readonly Hunk[], request: SteerRequest): Laid {
  const { applied, links } = resolveHunks(request.oldText, { hunks: [...hunks], language: request.label }, request.adapter, request.maps);
  return { hunks, current: applied, settled: links.flatMap((l) => (l.final !== undefined ? [l.final] : [])) };
}

async function verdictOn(hunk: Hunk, number: number, total: number, steering: Steering): Promise<Verdict> {
  if (steering.review === undefined) return 'keep';
  try {
    return await steering.review(hunk, number, total);
  } catch (e) {
    if (!(e instanceof InputClosed)) throw e;
    throw new Error(
      `-a: the input closed at hunk ${number} of ${total}, before it was answered — nothing was written\n` +
        '  answer every hunk (one line each, Enter keeps it), or drop -a',
    );
  }
}

async function editUntilItStands(
  hunks: readonly Hunk[],
  why: string,
  segment: ChangeSegment,
  request: SteerRequest,
  steering: Steering,
): Promise<readonly Hunk[]> {
  let body = printSirFile(hunks, request.label);
  let reason = why;
  for (;;) {
    const edited = await steering.edit(`${note(reason, segment)}${body}`);
    const checked = check(edited, request);
    if (typeof checked !== 'string') return checked;
    if (!(await steering.offerEdit(checked))) throw new Error(`${checked}\n  nothing was written`);
    reason = checked;
    body = bodyOf(edited);
  }
}

function check(text: string, request: SteerRequest): readonly Hunk[] | string {
  const checked = standing(text, request);
  return 'hunks' in checked ? checked.hunks : checked.why;
}

function kept(keep: string, request: SteerRequest): readonly Hunk[] {
  const checked = standing(keep, request);
  if ('hunks' in checked) return checked.hunks;
  throw checked.error;
}

type Standing =
  | { readonly hunks: readonly Hunk[] }
  | { readonly why: string; readonly error: unknown };

function standing(text: string, request: SteerRequest): Standing {
  let file;
  try {
    file = parseSirFile(text);
  } catch (e) {
    return { why: `the edited patch does not parse: ${firstLineOf(e)}`, error: e };
  }
  if (file.language !== undefined) {
    try {
      checkHeading(file.language, request.adapter);
    } catch (e) {
      return { why: firstLineOf(e), error: e };
    }
  }
  const { links } = resolveHunks(request.oldText, file, request.adapter, request.maps);
  const bad = links.find((l) => l.status !== 'ok');
  if (bad === undefined) return { hunks: file.hunks };
  const at = bad.failure?.mdLine ?? bad.mdSpan?.[0];
  const error = landingError(file.hunks, bad.index, at, request);
  return { why: error.message, error };
}

function landingError(hunks: readonly Hunk[], index: number, mdLine: number | undefined, request: SteerRequest): SirError {
  const { adapter, maps } = request;
  const after = (count: number): string =>
    count === 0 ? request.oldText : resolveHunks(request.oldText, { hunks: [...hunks.slice(0, count)] }, adapter, maps).applied;
  const failure = (text: string): unknown => {
    try {
      planHunk(text, mapFor(adapter, text, maps), hunks[index]!, adapter);
      return undefined;
    } catch (e) {
      return e;
    }
  };
  const error = failure(after(index));
  if (!(error instanceof SirError)) throw error;
  let because = error.message;
  if (index > 0 && failure(request.oldText) === undefined) {
    let culprit = 1;
    while (culprit < index && failure(after(culprit)) === undefined) culprit++;
    because = `it lands on the old version by itself, but hunk ${culprit} rewrote the text it anchors on — ${because}`;
  }
  error.message = `hunk ${index + 1}${mdLine !== undefined ? ` (line ${mdLine})` : ''} does not land: ${because}`;
  error.hunkAt = { hunk: index + 1, ...(mdLine !== undefined ? { mdLine } : {}) };
  return error;
}

const NOTE_WIDTH = 80;

function note(reason: string, segment: ChangeSegment): string {
  const quote = (lines: readonly string[], mark: string): string[] => lines.map((l) => `  ${mark} ${l}`);
  return [
    'Sir — edit the hunks below, then save and close the editor. The hunks are applied',
    'in order to the OLD version, and everything above the first "# match" is ignored.',
    '',
    ...reason.split('\n').map((l) => `  ${l}`),
    '',
    `The change this is about (line ${segment.oldStart} of the text so far):`,
    ...quote(segment.removed, '-'),
    ...quote(segment.added, '+'),
    '',
    '-'.repeat(NOTE_WIDTH),
    '',
  ].join('\n');
}

export function hunksOf(text: string): string {
  let at = 0;
  for (const line of text.split('\n')) {
    const bare = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (MATCH_HEADING.test(bare) || NOTE_HEADING.test(bare)) return text.slice(at);
    at += line.length + 1;
  }
  return text;
}

function bodyOf(edited: string): string {
  const lines = edited.split(/\r?\n/);
  const at = lines.findIndex((line) => MATCH_HEADING.test(line) || NOTE_HEADING.test(line));
  return at === -1 ? edited : lines.slice(at).join('\n');
}

function touches(segment: ChangeSegment, offsets: readonly number[], settled: readonly Span[]): boolean {
  const lineAt = (k: number): number => offsets[Math.min(k, offsets.length - 1)]!;
  const start = lineAt(segment.oldStart - 1);
  const end = lineAt(segment.oldStart - 1 + segment.removed.length);
  return settled.some((s) =>
    start < end ? start < s.end && s.start < end : s.start < start && start < s.end,
  );
}

function leftOut(segment: ChangeSegment, target: string): string {
  const lines = target.split('\n');
  lines.splice(segment.newStart - 1, segment.added.length, ...segment.removed);
  return lines.join('\n');
}
