import type { HeaderFields } from './header.ts';

export type GapMode =
  | { op: 'tight' }
  | { op: 'skipAny' };

export interface PlacedMark {
  side: 'left' | 'right';
  mdLine: number;
}

export interface Literal {
  raw: string;
  mdSpan: [number, number];
}

export interface Gap {
  mode: GapMode;
  insert?: PlacedMark;
  replaceEnd?: PlacedMark;
}

export type Anchor =
  | { target: 'literal'; literal: Literal }
  | { target: 'eof' };

export interface Step {
  gap: Gap;
  anchor: Anchor;
}

export interface MatchPattern {
  steps: Step[];
}

export interface Hunk {
  match: MatchPattern;
  patch: string;
  mdSpan?: [number, number];
  /** The `# note` … `# end` block right before `# match`: the author's own words, never
   *  read by the matcher. */
  note?: Note;
}

export interface Note {
  text: string;
  /** lines of the `.sirp` from `# note` to its `# end`, counted from 1 (`md` is the
   *  name from the format the patch had before 0.4; the field keeps it) */
  mdSpan: [number, number];
}

/** The header of a `.sirp` (`core/header.ts`): the format number and the fields sir
 *  knows — `HeaderFields`, the one list of them. A file with no header is hunks alone,
 *  read as `FORMAT_MIN` with no fields (VERSIONING.md H1). */
export interface SirHeader extends HeaderFields {
  format: number;
}

export interface SirFile {
  /** always there in a parsed file; one built in code may go without */
  header?: SirHeader;
  hunks: Hunk[];
  language?: string;
}
