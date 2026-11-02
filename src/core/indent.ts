import type { Hunk } from './ast.ts';
import type { MatchMarks } from './matcher.ts';
import type { Edit } from './patcher.ts';
import type { SourceMap } from '../lang/source-map.ts';

export interface Reindented {
  readonly edit: Edit;
  readonly nested: boolean;
  readonly shift: number;
}

export function reindent(source: string, edit: Edit, hunk: Hunk, marks: MatchMarks, map: SourceMap): Reindented {
  const same: Reindented = { edit, nested: false, shift: 0 };
  if (edit.start !== edit.end) return same;
  const at = markedStep(hunk);
  if (at === undefined) return same;
  const neighbor = neighborOf(hunk, at.index, at.side);
  if (neighbor === undefined) return same;
  const landed = marks.landed.find((l) => l.step === neighbor.step);
  const line = neighbor.literal.line;
  if (landed === undefined || line === undefined) return same;
  if (/"""|'''/.test(edit.text)) return same;

  let F: string | undefined;
  let T: string | undefined;
  if (at.side === 'right') {
    F = lineIndentAt(source, map.toOriginalPos(landed.pos, 'right'));
    T = line.opens ? line.indent.first : undefined;
    const cut = source.lastIndexOf('\n', edit.start - 1) + 1;
    const written = edit.text.split('\n');
    if (edit.start > cut && source.slice(cut, edit.start).trim() === '' && written.length >= 2 && written[written.length - 1]!.trim() === '') {
      T = written[written.length - 1]!;
    }
  } else {
    const end = map.toOriginalPos(landed.pos + landed.len, 'left');
    F = lineIndentAt(source, end - 1);
    T = leftTemplateIndent(hunk, marks, map, neighbor.step, source, end - 1);
  }
  const file = spacesOnly(F);
  const base = spacesOnly(T);
  if (file === undefined || base === undefined || file === base) return same;

  const parts = edit.text.split('\n');
  const lineStart = source.lastIndexOf('\n', edit.start - 1) + 1;
  const before = source.slice(lineStart, edit.start);
  const insideBlanks = before.trim() === '';
  const startsLine = edit.start === lineStart;
  const rest = source.slice(edit.end, source.indexOf('\n', edit.end) === -1 ? source.length : source.indexOf('\n', edit.end));
  const textFollows = rest.trim() !== '';

  const first = parts.findIndex((p, k) => k >= 1 && p.trim() !== '' && (k < parts.length - 1 || !textFollows));
  const lastBlank = parts.length - 1 >= 1 && parts[parts.length - 1]!.trim() === '' && textFollows;
  let level: string | undefined;
  if (parts[0]!.trim() !== '' && (insideBlanks || startsLine)) {
    if (!startsLine && parts[0]!.length - parts[0]!.trimStart().length !== 0) return same;
    level = startsLine ? blanks(parts[0]!) : base === undefined ? undefined : ' '.repeat(base);
  } else if (first !== -1) level = blanks(parts[first]!);
  else if (lastBlank) level = parts[parts.length - 1]!;
  if (level === undefined || level.includes('\t') || level.length !== base) return same;
  const shift = file - base;

  const out: string[] = [];
  let nested = false;
  for (const [k, part] of parts.entries()) {
    const isLast = k === parts.length - 1;
    const carries = k >= 1 && (part.trim() !== '' || (isLast && textFollows));
    if (!carries) {
      out.push(part);
      continue;
    }
    if (part.trim() !== '' && blanks(part).length > level.length) nested = true;
    if (shift > 0) out.push(' '.repeat(shift) + part);
    else {
      const gone = -shift;
      if (!part.startsWith(' '.repeat(gone))) return same;
      out.push(part.slice(gone));
    }
  }
  return { edit: { ...edit, text: out.join('\n') }, nested, shift };
}

function markedStep(hunk: Hunk): { index: number; side: 'left' | 'right' } | undefined {
  for (const [index, step] of hunk.match.steps.entries()) {
    if (step.gap.insert !== undefined) return { index, side: step.gap.insert.side };
  }
  return undefined;
}

function neighborOf(hunk: Hunk, index: number, side: 'left' | 'right') {
  const step = side === 'left' ? hunk.match.steps[index - 1] : hunk.match.steps[index];
  if (step === undefined || step.anchor.target !== 'literal') return undefined;
  return { step: side === 'left' ? index - 1 : index, literal: step.anchor.literal };
}

function leftTemplateIndent(
  hunk: Hunk,
  marks: MatchMarks,
  map: SourceMap,
  step: number,
  source: string,
  lineAt: number,
): string | undefined {
  const lineStart = source.lastIndexOf('\n', lineAt) + 1;
  const neighbor = hunk.match.steps[step]!.anchor;
  if (neighbor.target === 'literal' && neighbor.literal.raw.includes('\n') && neighbor.literal.line !== undefined) {
    return neighbor.literal.line.indent.last;
  }
  for (const l of marks.landed) {
    if (l.step > step) break;
    const anchor = hunk.match.steps[l.step]!.anchor;
    if (anchor.target !== 'literal') continue;
    if (map.toOriginalPos(l.pos, 'right') < lineStart) continue;
    const line = anchor.literal.line;
    if (line === undefined || !line.opens) return undefined;
    return line.indent.first;
  }
  return undefined;
}

function lineIndentAt(source: string, pos: number): string {
  const start = source.lastIndexOf('\n', pos - 1) + 1;
  return blanks(source.slice(start, start + 256));
}

const blanks = (line: string): string => /^[ \t]*/.exec(line)![0];

function spacesOnly(indent: string | undefined): number | undefined {
  return indent === undefined || indent.includes('\t') ? undefined : indent.length;
}
