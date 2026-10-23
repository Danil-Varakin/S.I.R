import type {
  GapMode,
  PlacedMark,
  Gap,
  Step,
  MatchPattern,
  Hunk,
  SirFile,
  Note,
  SirHeader,
} from './ast.ts';
import { ParseError } from './errors.ts';
import { headerFields, parseHeader } from './header.ts';

function freshGap(): Gap {
  return { mode: { op: 'tight' } };
}

class PatternBuilder {
  private steps: Step[] = [];
  private gap: Gap = freshGap();
  private skipSeen = false;
  private insertMark: PlacedMark | null = null;
  private replaceEndMark: PlacedMark | null = null;
  private readonly blockLine: number;

  constructor(blockLine: number) {
    this.blockLine = blockLine;
  }

  addLiteral(raw: string, mdLine: number): void {
    const prev = this.steps[this.steps.length - 1];
    const gapIsFresh =
      this.gap.mode.op === 'tight' &&
      this.gap.insert === undefined &&
      this.gap.replaceEnd === undefined;

    if (gapIsFresh && prev !== undefined && prev.anchor.target === 'literal') {
      const lit = prev.anchor.literal;
      lit.raw += '\n' + raw;
      lit.mdSpan[1] = mdLine;
      return;
    }

    this.steps.push({
      gap: this.gap,
      anchor: { target: 'literal', literal: { raw, mdSpan: [mdLine, mdLine] } },
    });
    this.gap = freshGap();
    this.skipSeen = false;
  }

  addGapMode(mode: GapMode, mdLine: number): void {
    if (this.skipSeen) {
      throw new ParseError(
        'two skip operators in one gap',
        mdLine,
        'the labels are transparent: "... >>> ..." — also two passes in a row; leave one',
      );
    }
    this.gap.mode = mode;
    this.skipSeen = true;
  }

  addInsert(mdLine: number): void {
    if (this.insertMark !== null) {
      throw new ParseError(
        `repeat insertion point >>> (the first one is on line ${this.insertMark.mdLine})`,
        mdLine,
        'you need two insertion points — make two match/patch hunks',
      );
    }
    const placed: PlacedMark = {
      side: this.skipSeen ? 'right' : 'left',
      mdLine,
    };
    this.gap.insert = placed;
    this.insertMark = placed;
  }

  addReplaceEnd(mdLine: number): void {
    if (this.insertMark === null) {
      throw new ParseError(
        'marker <<< without preceding >>>: end of range before start',
        mdLine,
        '<<< always after >>> is the end of the replacement range started by the insertion',
      );
    }
    if (this.replaceEndMark !== null) {
      throw new ParseError(
        `repeat end-of-range marker <<< (the first one is on line ${this.replaceEndMark.mdLine})`,
        mdLine,
        'a replacement range has exactly one end; remove the extra <<<',
      );
    }
    const placed: PlacedMark = {
      side: this.skipSeen ? 'right' : 'left',
      mdLine,
    };
    this.gap.replaceEnd = placed;
    this.replaceEndMark = placed;
  }

  finish(): MatchPattern {
    if (
      this.gap.insert !== undefined ||
      this.gap.replaceEnd !== undefined ||
      this.gap.mode.op !== 'tight'
    ) {
      this.steps.push({ gap: this.gap, anchor: { target: 'eof' } });
      this.gap = freshGap();
    }
    if (this.insertMark === null) {
      throw new ParseError(
        'there is no insertion point >>> in the match block',
        this.blockLine,
        'each patch body needs exactly one insertion position',
      );
    }
    return { steps: this.steps };
  }
}

const OP_RE = /(?<=^|\s)(\.\.\.|>>>|<<<)(?=\s|$)/g;

const ESCAPE_RE = /(?<=^|\s)\\(?=\\*(?:\.\.\.|>>>|<<<)(?:\s|$))/g;

function scanLineInto(line: string, mdLine: number, builder: PatternBuilder): void {
  let last = 0;
  let atLineStart = true;
  for (const m of line.matchAll(OP_RE)) {
    const idx = m.index ?? 0;
    const op = m[0] ?? '';
    feedFragment(line.slice(last, idx), atLineStart, mdLine, builder);
    feedOperator(op, mdLine, builder);
    last = idx + op.length;
    atLineStart = false;
  }
  feedFragment(line.slice(last), atLineStart, mdLine, builder);
}

function feedFragment(
  frag: string,
  atLineStart: boolean,
  mdLine: number,
  builder: PatternBuilder,
): void {
  const unescaped = frag.replace(ESCAPE_RE, '');
  const raw = atLineStart ? unescaped.trimEnd() : unescaped.trim();
  if (raw === '') return;
  builder.addLiteral(raw, mdLine);
}

/** A literal as the parser reads it back once `printPattern` has written it: line by
 *  line from the gutter, each line's trailing whitespace dropped, blank lines no part
 *  of it (`feedFragment`, `addLiteral`). What `generate` builds an anchor of has to be
 *  this text — an anchor verified as written but read as something else is a patch that
 *  does not apply (a blank line in Python, whose canon keeps it). */
export function literalAsRead(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .join('\n');
}

function feedOperator(op: string, mdLine: number, builder: PatternBuilder): void {
  switch (op) {
    case '...':
      builder.addGapMode({ op: 'skipAny' }, mdLine);
      break;
    case '>>>':
      builder.addInsert(mdLine);
      break;
    case '<<<':
      builder.addReplaceEnd(mdLine);
      break;
  }
}

export const MATCH_HEADING = /^#{1,6}[ \t]*match:?(?:[ \t]+(\S+))?[ \t]*$/i;
export const PATCH_HEADING = /^#{1,6}[ \t]*patch:?[ \t]*$/i;
export const END_HEADING = /^#{1,6}[ \t]*end[ \t]*$/i;
export const NOTE_HEADING = /^#{1,6}[ \t]*note:?[ \t]*$/i;
const HEADING_LIKE = /^#{1,6}[ \t]*(end|match|patch|note)\b/i;

function readNote(lines: string[], start: number): { note: Note; next: number } {
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (END_HEADING.test(line)) {
      while (body[0] === '') body.shift();
      while (body[body.length - 1] === '') body.pop();
      return { note: { text: body.join('\n'), mdSpan: [start + 1, i + 1] }, next: i + 1 };
    }
    if (MATCH_HEADING.test(line) || PATCH_HEADING.test(line) || NOTE_HEADING.test(line)) {
      throw new ParseError(
        `the note block is not closed: '${line.trim()}' found where '# end' was expected`,
        i + 1,
        "close the note with '# end' before the next heading",
      );
    }
    body.push(line.trimEnd());
  }
  throw new ParseError('the note block is not closed', start + 1, "every block ends with a '# end' line in column 0");
}

// Before the first `# match` is free prose, and was so in every release: a note is
// recognized there only as a closed `# note` … `# end` with nothing but blank lines
// after it, so no preamble an older sir read past starts failing now (F1).
function preambleNote(lines: string[], firstMatch: number): Note | undefined {
  let k = firstMatch - 1;
  while (k >= 0 && lines[k]!.trim() === '') k--;
  if (k < 0 || !END_HEADING.test(lines[k]!)) return undefined;
  for (let h = k - 1; h >= 0; h--) {
    const line = lines[h]!;
    if (NOTE_HEADING.test(line)) {
      try {
        const { note, next } = readNote(lines, h);
        return next === k + 1 ? note : undefined;
      } catch {
        return undefined;
      }
    }
    if (END_HEADING.test(line) || PATCH_HEADING.test(line)) return undefined;
  }
  return undefined;
}

export const GUTTER = '    ';

interface Block {
  body: string[];
  firstLine: number;
  endLine: number;
  next: number;
}

function readBlock(lines: string[], start: number, kind: 'match' | 'patch', headLine: number): Block {
  const body: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    if (END_HEADING.test(line)) {
      return { body, firstLine: start + 1, endLine: i + 1, next: i + 1 };
    }
    if (line.startsWith(GUTTER)) {
      body.push(line.slice(GUTTER.length));
    } else if (line.trim() === '') {
      body.push('');
    } else {
      throw bodyLineError(line, i + 1, kind);
    }
  }
  throw new ParseError(
    `the ${kind} block is not closed`,
    headLine,
    "every block ends with a '# end' line in column 0",
  );
}

function bodyLineError(line: string, mdLine: number, kind: 'match' | 'patch'): ParseError {
  if (line.startsWith('```')) {
    return new ParseError(
      'the fenced format is no longer supported',
      mdLine,
      "drop the ``` fences, indent every payload line with four spaces and close each " +
        "block with '# end'; the language goes into the heading: '# match cpp'",
    );
  }
  if (MATCH_HEADING.test(line) || PATCH_HEADING.test(line) || NOTE_HEADING.test(line)) {
    return new ParseError(
      `the ${kind} block is not closed: '${line.trim()}' found where '# end' was expected`,
      mdLine,
    );
  }
  const shown = line.trim();
  const heading = HEADING_LIKE.exec(line);
  if (heading !== null) {
    const word = heading[1]!.toLowerCase();
    const takes = word === 'match' ? 'takes a language name and nothing more' : 'takes nothing after it';
    return new ParseError(`'${shown}' is not a heading: '# ${word}' ${takes}`, mdLine);
  }
  return new ParseError(
    `a line of the ${kind} block must start with four spaces`,
    mdLine,
    `indent '${shown.length > 40 ? shown.slice(0, 40) + '…' : shown}', or close the block with '# end'`,
  );
}

export function parseSirFile(text: string): SirFile {
  const parsedHeader = parseHeader(text);
  const header: SirHeader = { format: parsedHeader.format, ...headerFields(parsedHeader) };
  const lines = text.split(/\r?\n/);
  const hunks: Hunk[] = [];
  let language: string | undefined;

  let i = 0;
  while (i < lines.length && !MATCH_HEADING.test(lines[i]!)) i++;
  let note = preambleNote(lines, i);

  while (i < lines.length) {
    if (NOTE_HEADING.test(lines[i]!)) {
      if (note !== undefined) {
        throw new ParseError(
          `a second note for one hunk (the first one is on line ${note.mdSpan[0]})`,
          i + 1,
          "a hunk has at most one '# note'; merge the two",
        );
      }
      const read = readNote(lines, i);
      note = read.note;
      i = read.next;
      continue;
    }
    const head = lines[i]!.match(MATCH_HEADING);
    if (head === null) {
      if (lines[i]!.trim() !== '') {
        throw new ParseError(
          'text between hunks must be in a note block',
          i + 1,
          "put the comment into '# note' … '# end' right before the '# match' it is about",
        );
      }
      i++;
      continue;
    }

    const hunkStart = i + 1;
    const lang = head[1];
    if (lang !== undefined) {
      if (language === undefined) language = lang;
      else if (language.toLowerCase() !== lang.toLowerCase()) {
        throw new ParseError(
          `match block declares language '${lang}', but the file already uses '${language}'`,
          hunkStart,
          'one patch — one language; split the hunks into separate files',
        );
      }
    }

    const matchBlock = readBlock(lines, i + 1, 'match', hunkStart);

    let j = matchBlock.next;
    while (j < lines.length && lines[j]!.trim() === '') j++;
    if (!PATCH_HEADING.test(lines[j]!)) {
      throw new ParseError(
        'the patch header is expected after the match block',
        j >= lines.length ? matchBlock.endLine : j + 1,
        "a match block without a patch doesn't make sense",
      );
    }
    const patchBlock = readBlock(lines, j + 1, 'patch', j + 1);

    const builder = new PatternBuilder(hunkStart);
    for (const [k, raw] of matchBlock.body.entries()) {
      scanLineInto(raw, matchBlock.firstLine + k, builder);
    }

    const hunk: Hunk = {
      match: builder.finish(),
      patch: patchBlock.body.join('\n'),
      mdSpan: [hunkStart, patchBlock.endLine],
    };
    if (note !== undefined) hunk.note = note;
    note = undefined;
    hunks.push(hunk);
    i = patchBlock.next;
  }

  if (note !== undefined) {
    throw new ParseError(
      "a note with no hunk after it: '# match' is expected",
      note.mdSpan[0],
      "a '# note' belongs to the '# match' that follows it",
    );
  }

  if (hunks.length === 0) {
    throw new ParseError('no match/patch pairs were found in the file', 1);
  }

  const file: SirFile = { header, hunks };
  if (language !== undefined) file.language = language;
  return file;
}
