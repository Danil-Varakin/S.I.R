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
  note?: Note;
}

export interface Note {
  text: string;
  mdSpan: [number, number];
}

export interface SirHeader extends HeaderFields {
  format: number;
}

export interface SirFile {
  header?: SirHeader;
  hunks: Hunk[];
  language?: string;
}
