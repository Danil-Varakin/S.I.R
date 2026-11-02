import { makeTextAdapter } from '../make-text-adapter.ts';
import { replaceWhitespaceOutsideStrings } from '../zones.ts';
import type { StringRule } from '../zones.ts';

const ZONES: readonly StringRule[] = [
  { open: /(?<![^\s])#/, close: '\n', opaque: false },
  { open: '"', close: '"', escape: '\\' },
  { open: "'", close: "'" },
];

const HEREDOC: StringRule = {
  open: /(?<!<)(?<!\(\([^\n]*)<<(?!<)(-?)[ \t]*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|\\?([A-Za-z_]\w*))/,
  close: (m) => new RegExp(`\\n${m[1] === '-' ? '[ \\t]*' : ''}${m[2] ?? m[3] ?? m[4]}[ \\t]*(?=\\n|$)`),
  multiline: true,
};

// The indentation of a line stays as it is: a here-document keeps it. A run of whitespace
// inside a line reads as one space, and a space is never dropped — in shell `a = 1` runs
// the command `a`, `a=1` sets a variable.
export function normalize(raw: string): string {
  return replaceWhitespaceOutsideStrings(raw, ZONES, (ws, off) => {
    if (off === 0) return ws.replace(/^\uFEFF/, '');
    const newline = ws.lastIndexOf('\n');
    if (newline !== -1) return ws.slice(0, newline + 1).replace(/[^\n]/g, '') + ws.slice(newline + 1);
    return off + ws.length === raw.length ? '' : ' ';
  });
}

export const shellAdapter = makeTextAdapter({
  name: 'shell',
  extensions: ['.sh', '.bash'],
  fileNames: ['postinst', 'postrm', 'preinst', 'prerm'],
  normalize,
  lines: {
    comments: ['#'],
    closers: ';,)]}',
    continues: '([{,',
    resumes: ')]}',
    continuation: '\\',
  },
  zones: ZONES,
  noBrackets: [HEREDOC],
});
