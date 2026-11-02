import type { Hunk } from './ast.ts';
import type { MatchMarks } from './matcher.ts';
import type { SourceMap } from '../lang/source-map.ts';

export function lineEdgeNotes(hunk: Hunk, marks: MatchMarks, map: SourceMap): string[] {
  const touched = new Set<number>();
  for (const [i, { gap }] of hunk.match.steps.entries()) {
    for (const mark of [gap.insert, gap.replaceEnd]) {
      if (mark !== undefined) touched.add(mark.side === 'left' ? i - 1 : i);
    }
  }
  const notes: string[] = [];
  for (const l of marks.landed) {
    if (!touched.has(l.step)) continue;
    const anchor = hunk.match.steps[l.step]!.anchor;
    if (anchor.target !== 'literal') continue;
    const { raw, line } = anchor.literal;
    if (line === undefined) continue;
    const fault = map.lineEdge(l.pos, l.len, raw, line.opens, line.closes);
    if (fault === null) continue;
    const flat = raw.trim().replace(/\s*\n\s*/g, ' ');
    const shown = flat.length > 40 ? `${flat.slice(0, 40)}…` : flat;
    const where = fault.side === 'before' ? 'before it' : 'after it';
    notes.push(
      `'${shown}' stands in the middle of a line (on the line, ${where}: '${fault.text}') — ` +
        'the patch has it as the whole of its line. Laid where it fits; check that this is the place',
    );
  }
  return notes;
}
