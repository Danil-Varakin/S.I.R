import type { SourceMap } from '../lang/source-map.ts';
import type { MatchMarks } from './matcher.ts';
import { lineEndAt, toCrlf } from './eol.ts';
import type { LineEnd } from './eol.ts';

export interface Edit {
  start: number;
  end: number;
  text: string;
}

export function cutOf(map: SourceMap, marks: MatchMarks): { start: number; end: number } {
  const start = map.toOriginalPos(marks.insert.pos, marks.insert.side);
  const end =
    marks.replaceEnd === undefined ? start : map.toOriginalPos(marks.replaceEnd.pos, marks.replaceEnd.side);
  if (end < start) {
    throw new RangeError(`patcher: replace end ${end} is before insert start ${start}`);
  }
  return { start, end };
}

export function planEdit(source: string, map: SourceMap, marks: MatchMarks, patch: string): Edit {
  const { start, end } = cutOf(map, marks);
  return { start, end, text: landed(patch, lineEndAt(source, start)) };
}

export function applyEdit(source: string, edit: Edit): string {
  return source.slice(0, edit.start) + edit.text + source.slice(edit.end);
}

export function patchHunk(
  source: string,
  map: SourceMap,
  marks: MatchMarks,
  patch: string,
): { source: string; edit: Edit } {
  const edit = planEdit(source, map, marks, patch);
  return { source: applyEdit(source, edit), edit };
}

function landed(patch: string, lineEnd: LineEnd): string {
  return lineEnd === '\n' ? patch : toCrlf(patch);
}
