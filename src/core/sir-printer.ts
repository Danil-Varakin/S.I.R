import type { Gap, GapMode, MatchPattern } from './ast.ts';

export function printPattern(p: MatchPattern): string {
  const out: string[] = [];
  for (const step of p.steps) {
    emitGap(step.gap, out);
    if (step.anchor.target === 'literal') {
      out.push(escapeLiteral(step.anchor.literal.raw));
    }
  }
  return out.join('\n');
}

const OP_LEXEME_RE = /(?<=^|\s)(\\*)(\.\.\.|>>>|<<<)(?=\s|$)/g;

function escapeLiteral(raw: string): string {
  return raw.replace(OP_LEXEME_RE, '\\$1$2');
}

function emitGap(g: Gap, out: string[]): void {
  if (g.insert?.side === 'left') out.push('>>>');
  if (g.replaceEnd?.side === 'left') out.push('<<<');
  const op = modeLexeme(g.mode);
  if (op !== null) out.push(op);
  if (g.insert?.side === 'right') out.push('>>>');
  if (g.replaceEnd?.side === 'right') out.push('<<<');
}

function modeLexeme(mode: GapMode): string | null {
  switch (mode.op) {
    case 'tight':
      return null;
    case 'skipAny':
      return '...';
    default:
      return assertNever(mode);
  }
}

function assertNever(x: never): never {
  throw new Error(`unhandled GapMode variant: ${JSON.stringify(x)}`);
}
