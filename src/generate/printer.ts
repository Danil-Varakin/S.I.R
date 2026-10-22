import { printPattern } from '../core/sir-printer.ts';
import { END_HEADING, GUTTER, PATCH_HEADING } from '../core/sir-parser.ts';
import type { Hunk, Note } from '../core/ast.ts';

/** The hunks as a `.sirp` body, without the header: each one `# match` … `# end`,
 *  `# patch` … `# end`, its `# note` before it when it has one — what the parser reads
 *  back to the same hunks. */
export function printSirFile(hunks: readonly Hunk[], language?: string): string {
  const head = language !== undefined && language !== '' ? `# match ${language}` : '# match';
  return (
    hunks
      .map((h) =>
        [
          ...noteBlock(h.note),
          head,
          ...gutter(printPattern(h.match)),
          '# end',
          '# patch',
          ...gutter(h.patch),
          '# end',
        ].join('\n'),
      )
      .join('\n\n') + '\n'
  );
}

/** A note is prose: no gutter, any column — the parser refuses only a heading inside it. */
function noteBlock(note: Note | undefined): string[] {
  if (note === undefined) return [];
  return ['# note', ...(note.text === '' ? [] : note.text.split('\n')), '# end'];
}

function gutter(text: string): string[] {
  if (text === '') return [];
  return text.split('\n').map((l) => (l === '' ? '' : GUTTER + l));
}

export interface HunkWarning {
  /** the hunk, counted from 1 */
  readonly hunk: number;
  /** the line of the `.sirp` the warning is about, counted from 1 (the wire name keeps
   *  the `md` of the format it was first written for) */
  readonly mdLine: number;
  /** the same sentence `warnings` carries */
  readonly message: string;
}

export function trailingSpaceWarnings(hunks: readonly Hunk[]): string[] {
  return trailingSpaces(hunks).map((w) => w.message);
}

/** The same warnings, each placed in `patch` — the printed form of `hunks`, its header
 *  and any prose before the first hunk included: the first patch line of the hunk that
 *  ends in whitespace. */
export function trailingSpaceWarningsAt(hunks: readonly Hunk[], patch: string): HunkWarning[] {
  const lines = patch.split('\n');
  const patchHeads: number[] = [];
  // every heading the parser takes: a patch written by hand may spell it `## patch:`
  for (const [i, line] of lines.entries()) if (PATCH_HEADING.test(line)) patchHeads.push(i);
  return trailingSpaces(hunks).map(({ hunk, message }) => {
    const head = patchHeads[hunk - 1]!;
    let at = head + 1;
    while (at < lines.length && !END_HEADING.test(lines[at]!) && !/[ \t]$/.test(lines[at]!)) at++;
    return { hunk, mdLine: at + 1, message };
  });
}

function trailingSpaces(hunks: readonly Hunk[]): { hunk: number; message: string }[] {
  const out: { hunk: number; message: string }[] = [];
  for (const [i, h] of hunks.entries()) {
    const n = h.patch.split('\n').filter((l) => /[ \t]$/.test(l)).length;
    if (n > 0) {
      out.push({
        hunk: i + 1,
        message:
          `hunk ${i + 1}: patch body has ${n} line(s) ending in whitespace — significant, ` +
          'do not run a trailing-whitespace fixer on this patch',
      });
    }
  }
  return out;
}
