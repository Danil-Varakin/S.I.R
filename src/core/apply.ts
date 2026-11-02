import { matchPattern } from './matcher.ts';
import { reindent } from './indent.ts';
import { lineEdgeNotes } from './line-edges.ts';
import { applyEdit, planEdit } from './patcher.ts';
import type { Edit } from './patcher.ts';
import type { SirFile, Hunk } from './ast.ts';
import { MatchError, SirError } from './errors.ts';
import type { LanguageAdapter, SourceMap } from '../lang/source-map.ts';
import { isWordChar } from '../lang/word.ts';

export interface AppliedEdit {
  edit: Edit;
  oldText: string;
}

export interface HunkNote {
  readonly hunk: number;
  readonly reason: NoteReason;
  readonly message: string;
}

export type NoteReason = 'line-edge' | 'indent';

export interface Planned {
  readonly edit: Edit;
  readonly notes: readonly { readonly reason: NoteReason; readonly message: string }[];
}

export interface ApplyResult {
  source: string;
  edits: AppliedEdit[];
  notes: HunkNote[];
  copies: number[];
}

export function applyAll(source: string, file: SirFile, adapter: LanguageAdapter): ApplyResult {
  let current = source;
  const edits: AppliedEdit[] = [];
  const copies: number[] = [];
  const notes: HunkNote[] = [];
  for (const [index, hunk] of file.hunks.entries()) {
    const planned = planHunk(current, adapter.buildMap(current), hunk, adapter);
    const edit = planned.edit;
    for (const n of planned.notes) notes.push({ hunk: index, ...n });
    edits.push({ edit, oldText: current.slice(edit.start, edit.end) });
    copies.push(copiesAt(current, edit));
    current = applyEdit(current, edit);
  }
  return { source: current, edits, notes, copies };
}

export function planHunk(current: string, map: SourceMap, hunk: Hunk, adapter: LanguageAdapter): Planned {
  const marks = matchPattern(hunk.match, map, adapter.normalize);
  const planned = planEdit(current, map, marks, hunk.patch);
  const moved = adapter.indentIsStructure === true ? reindent(current, planned, hunk, marks, map) : undefined;
  const notes: { reason: NoteReason; message: string }[] = lineEdgeNotes(hunk, marks, map).map((message) => ({ reason: 'line-edge', message }));
  if (moved?.nested === true) {
    const by = moved.shift > 0 ? `${moved.shift} deeper` : `${-moved.shift} shallower`;
    notes.push({
      reason: 'indent',
      message:
        `the text it writes moved ${by}, with the line it stands by; its inner lines kept their depth below its first — ` +
        'if the file changed the step of its indentation, they need moving too',
    });
  }
  return { edit: moved?.edit ?? planned, notes };
}

export function copiesAt(current: string, edit: Edit): number {
  if (edit.start !== edit.end) return 0;
  const want = edit.text.trim();
  if (want === '') return 0;
  let n = 0;
  for (let at = edit.end, end = copyAfter(current, at, want); end !== undefined; end = copyAfter(current, at, want)) {
    n++;
    at = end;
  }
  const back = [...want].reverse().join('');
  const before = [...current.slice(Math.max(0, edit.start - REACH * (2 * want.length + 1)), edit.start)].reverse().join('');
  for (let at = 0, end = copyAfter(before, at, back); end !== undefined; end = copyAfter(before, at, back)) {
    n++;
    at = end;
  }
  return n;
}

function copyAfter(text: string, from: number, want: string): number | undefined {
  let i = skipBlanks(text, from);
  let prev = '';
  for (let j = 0; j < want.length; j++) {
    const w = want[j]!;
    if (isBlank(w)) {
      const k = skipBlanks(text, i);
      if (k === i && isWordChar(prev) && isWordChar(nextSolid(want, j))) return undefined;
      i = k;
      j = skipBlanks(want, j) - 1;
      continue;
    }
    const k = skipBlanks(text, i);
    if (k !== i && isWordChar(prev) && isWordChar(w)) return undefined;
    if (text[k] !== w) return undefined;
    i = k + 1;
    prev = w;
  }
  let k = i;
  while (k < text.length && text[k] !== '\n' && isBlank(text[k]!)) k++;
  return k === text.length || text[k] === '\n' ? i : undefined;
}

const REACH = 64;

const isBlank = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

function skipBlanks(text: string, i: number): number {
  while (i < text.length && isBlank(text[i]!)) i++;
  return i;
}

function nextSolid(text: string, j: number): string {
  return text[skipBlanks(text, j)] ?? '';
}

export type AlreadyThere =
  | { readonly kind: 'clear' }
  | { readonly kind: 'taken'; readonly hunks: readonly number[] }
  | { readonly kind: 'unwitnessed'; readonly hunks: readonly number[] };

export function alreadyThere(copies: readonly number[], file: SirFile, adapter: LanguageAdapter, base: string | undefined): AlreadyThere {
  const found = copies.flatMap((n, i) => (n > 0 ? [i] : []));
  if (found.length === 0) return { kind: 'clear' };
  if (base === undefined) return { kind: 'unwitnessed', hunks: found };
  let then: number[];
  try {
    then = applyAll(base, file, adapter).copies;
  } catch (e) {
    if (e instanceof SirError) return { kind: 'unwitnessed', hunks: found };
    throw e;
  }
  const taken = found.filter((i) => copies[i]! > then[i]!);
  return taken.length === 0 ? { kind: 'clear' } : { kind: 'taken', hunks: taken };
}

export function alreadyThereError(hunks: readonly number[], total: number, at: number): MatchError {
  const others = hunks.length > 1 ? ` (and ${hunks.length - 1} more)` : '';
  return new MatchError(
    `hunk ${hunks[0]! + 1} of ${total}${others}: already there — the file holds the text it inserts, ` +
      'more times than the base the patch was made on: upstream wrote it, and laying the patch would write it again',
    at,
    0,
    { reason: 'already-there', origPos: at },
  );
}
