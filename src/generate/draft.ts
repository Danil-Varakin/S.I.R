import type { Hunk, MatchPattern, Step } from '../core/ast.ts';
import { SynthesisError } from '../core/errors.ts';
import type { ChangeSegment } from './diff.ts';

// Where a person takes over from synthesis: a hunk to start a change from, and the draft
// a run hands over when it cannot anchor one — the editor in the CLI (`steer.ts`), the
// `SynthesisError` of the service. One code for both.

/** The same failure, with the draft to write the change by hand: the hunks so far and,
 *  last, the hunk to start from. `current` is the old version with the hunks so far laid
 *  — the text `segment` is in lines of. */
export function withDraft(
  e: SynthesisError,
  hunks: readonly Hunk[],
  segment: ChangeSegment,
  current: string,
): SynthesisError {
  return new SynthesisError(e.message, e.reason, e.because, e.newLine, {
    hunks: [...hunks, template(segment, current)],
    change: { line: segment.oldStart, removed: segment.removed, added: segment.added },
  });
}

const CONTEXT_LINES = 3;

/** The change with the lines just above it for context — the classic diff hunk, in the
 *  pattern language. Synthesis failed on it, so it is most likely ambiguous as it
 *  stands: a place to start editing, not an answer. Blank lines are left out of the
 *  context: the canon drops them, and a literal cannot be made of them. Laid as it is, the
 *  draft makes the change it was drafted for, blank lines included. */
export function template(segment: ChangeSegment, current: string): Hunk {
  const lines = current.split('\n');
  const at = segment.oldStart - 1;
  const above: string[] = [];
  let last = at;
  for (let k = at - 1; k >= 0 && above.length < CONTEXT_LINES; k--) {
    if (lines[k]!.trim() === '') continue;
    if (above.length === 0) last = k + 1;
    above.unshift(lines[k]!);
  }
  const context = above.join('\n');
  // The blank lines between the context and the change: the mark sits right after the
  // context, so they fall inside what the hunk replaces, and the body writes them back.
  const blanks = lines.slice(last, at);
  const removed = segment.removed.join('\n');
  const added = segment.added.join('\n');
  const left = { side: 'left' as const, mdLine: 0 };
  const right = { side: 'right' as const, mdLine: 0 };
  const eof = { target: 'eof' as const };

  // `... context >>> removed <<< ...`, the patch taking up after the context's last
  // character; with no context, `... >>> removed <<< ...` or, for a bare insertion,
  // `>>> ...` at the top of the file. An insertion under blank lines has no place of its
  // own to mark — a mark stands only next to a character — so it replaces the next line
  // that is not blank, `... context >>> next <<< ...`, and writes it back after the
  // inserted lines; with no such line, the rest of the file.
  const steps: Step[] = [];
  let patch: string;
  if (context !== '' && removed === '' && blanks.length > 0) {
    let next = at;
    while (next < lines.length && lines[next]!.trim() === '') next++;
    steps.push({ gap: { mode: { op: 'skipAny' } }, anchor: literal(context) });
    if (next < lines.length) {
      steps.push({ gap: { mode: { op: 'tight' }, insert: left }, anchor: literal(lines[next]!) });
      steps.push({ gap: { mode: { op: 'skipAny' }, replaceEnd: left }, anchor: eof });
    } else {
      steps.push({ gap: { mode: { op: 'skipAny' }, insert: left, replaceEnd: right }, anchor: eof });
    }
    patch = `\n${[...blanks, ...segment.added, ...lines.slice(at, next + 1)].join('\n')}`;
  } else if (context !== '') {
    steps.push({ gap: { mode: { op: 'skipAny' } }, anchor: literal(context) });
    if (removed !== '') {
      steps.push({ gap: { mode: { op: 'tight' }, insert: left }, anchor: literal(removed) });
      steps.push({ gap: { mode: { op: 'skipAny' }, replaceEnd: left }, anchor: eof });
    } else {
      steps.push({ gap: { mode: { op: 'skipAny' }, insert: left }, anchor: eof });
    }
    const prefix = blanks.map((b) => `\n${b}`).join('');
    patch = added === '' ? prefix : `${prefix}\n${added}`;
  } else if (removed !== '') {
    steps.push({ gap: { mode: { op: 'skipAny' }, insert: right }, anchor: literal(removed) });
    steps.push({ gap: { mode: { op: 'skipAny' }, replaceEnd: left }, anchor: eof });
    patch = added;
  } else {
    steps.push({ gap: { mode: { op: 'skipAny' }, insert: left }, anchor: eof });
    patch = `${added}\n`;
  }
  const match: MatchPattern = { steps };
  return { match, patch };
}

function literal(raw: string): Step['anchor'] {
  return { target: 'literal', literal: { raw, mdSpan: [0, 0] } };
}
