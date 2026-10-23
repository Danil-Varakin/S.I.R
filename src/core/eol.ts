export type LineEnd = '\r\n' | '\n';

export function lineEndAt(source: string, at: number): LineEnd {
  let nl = source.indexOf('\n', at);
  if (nl === -1) nl = source.lastIndexOf('\n', at - 1);
  return nl > 0 && source[nl - 1] === '\r' ? '\r\n' : '\n';
}

export function toCrlf(text: string): string {
  return text.replace(/(?<!\r)\n/g, '\r\n');
}

export function withLineEnds(text: string, end: LineEnd): string {
  return end === '\r\n' ? toCrlf(text) : text.replace(/\r\n/g, '\n');
}

export function firstLineEnd(text: string): LineEnd | undefined {
  return text.includes('\n') ? lineEndAt(text, 0) : undefined;
}
