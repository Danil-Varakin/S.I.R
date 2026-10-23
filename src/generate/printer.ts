import { printPattern } from '../core/sir-printer.ts';
import { END_HEADING, GUTTER, PATCH_HEADING } from '../core/sir-parser.ts';
import type { Hunk, Note } from '../core/ast.ts';

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

function noteBlock(note: Note | undefined): string[] {
  if (note === undefined) return [];
  return ['# note', ...(note.text === '' ? [] : note.text.split('\n')), '# end'];
}

function gutter(text: string): string[] {
  if (text === '') return [];
  return text.split('\n').map((l) => (l === '' ? '' : GUTTER + l));
}

export interface HunkWarning {
  readonly hunk: number;
  readonly mdLine: number;
  readonly message: string;
}

export function trailingSpaceWarnings(hunks: readonly Hunk[]): string[] {
  return trailingSpaces(hunks).map((w) => w.message);
}

export function trailingSpaceWarningsAt(hunks: readonly Hunk[], patch: string): HunkWarning[] {
  const lines = patch.split('\n');
  const patchHeads: number[] = [];
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
