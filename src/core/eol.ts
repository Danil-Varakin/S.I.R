// ── line endings ─────────────────────────────────────────────────────────────────
//
// A patch body has no line ending of its own: the .sirp is text, and git (autocrlf,
// `text=auto`) or an editor may turn its line ends either way on the road — the parser
// reads `\r\n` and `\n` alike. So the ending is the TARGET's: a bare LF of the patch
// takes the ending of the line the edit starts on. Only a CRLF line changes anything —
// in an LF file the patch lands byte for byte as before.
//
// The line the edit starts on, not the file as a whole: a file with mixed endings
// (golden cpp/74 — an LF header over CRLF lines, converted to LF) keeps what each place
// already has. An edit never starts between `\r` and `\n`: marks sit next to a
// non-whitespace character, or at BOF/EOF.
//
// A base out of git with `eol: "worktree"` follows the same rule, one level up: the
// endings are the file's on disk, read off its first line.

export type LineEnd = '\r\n' | '\n';

export function lineEndAt(source: string, at: number): LineEnd {
  let nl = source.indexOf('\n', at);
  if (nl === -1) nl = source.lastIndexOf('\n', at - 1);
  return nl > 0 && source[nl - 1] === '\r' ? '\r\n' : '\n';
}

/** Every bare LF as CRLF; a CRLF already there stays one. */
export function toCrlf(text: string): string {
  return text.replace(/(?<!\r)\n/g, '\r\n');
}

/** `text` with every line ending `end`. */
export function withLineEnds(text: string, end: LineEnd): string {
  return end === '\r\n' ? toCrlf(text) : text.replace(/\r\n/g, '\n');
}

/** The ending of a text's first line, or undefined when it has no line break at all —
 *  then it says nothing about the file's endings. */
export function firstLineEnd(text: string): LineEnd | undefined {
  return text.includes('\n') ? lineEndAt(text, 0) : undefined;
}
