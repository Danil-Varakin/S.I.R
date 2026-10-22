import { printPattern } from '../core/sir-printer.ts';
import type { Hunk } from '../core/ast.ts';

/** A hunk as `generate -a` shows it before asking about it. */
export function describeHunk(h: Hunk, index: number, total: number): string {
  return `hunk ${index + 1}/${total}:\n--- match ---\n${printPattern(h.match)}\n--- patch ---\n${h.patch}`;
}
