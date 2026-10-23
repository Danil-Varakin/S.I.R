import type { Hunk, MatchPattern, Step } from '../core/ast.ts';
import { SynthesisError } from '../core/errors.ts';
import type { ChangeSegment } from './diff.ts';

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
  const blanks = lines.slice(last, at);
  const removed = segment.removed.join('\n');
  const added = segment.added.join('\n');
  const left = { side: 'left' as const, mdLine: 0 };
  const right = { side: 'right' as const, mdLine: 0 };
  const eof = { target: 'eof' as const };

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
