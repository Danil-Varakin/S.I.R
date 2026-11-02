export interface LineRules {
  readonly comments: readonly string[];
  readonly blockComments?: readonly (readonly [string, string])[];
  readonly closers: string;
  readonly continues: string;
  readonly resumes: string;
  readonly continuation?: string;
}

export interface LineEdgeFault {
  readonly side: 'before' | 'after';
  readonly text: string;
}

export function lineEdgeFault(
  source: string,
  rules: LineRules,
  start: number,
  end: number,
  raw: string,
  opens: boolean,
  closes: boolean,
): LineEdgeFault | null {
  if (opens && !rules.resumes.includes(raw[0]!)) {
    const lineStart = source.lastIndexOf('\n', start - 1) + 1;
    const before = source.slice(lineStart, start);
    if (before.trim() !== '') return { side: 'before', text: before.trimStart() };
  }
  if (closes && !rules.continues.includes(raw[raw.length - 1]!)) {
    let lineEnd = source.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = source.length;
    const rest = source.slice(end, lineEnd).replace(/\r$/, '');
    if (!tailOk(rest, rules)) return { side: 'after', text: rest.trim() };
  }
  return null;
}

function tailOk(rest: string, rules: LineRules): boolean {
  let i = 0;
  for (;;) {
    while (i < rest.length && (rest[i] === ' ' || rest[i] === '\t')) i++;
    if (i === rest.length) return true;
    const here = rest.slice(i);
    if (rules.comments.some((c) => here.startsWith(c))) return true;
    if (rules.blockComments?.some(([open]) => here.startsWith(open))) return true;
    if (rules.continuation !== undefined && here === rules.continuation) return false;
    if (!rules.closers.includes(rest[i]!)) return false;
    i++;
  }
}
