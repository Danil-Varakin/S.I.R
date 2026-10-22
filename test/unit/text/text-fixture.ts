import { file, opt } from '../../matrix.ts';
import type { Fixture } from '../../matrix.ts';

// Plain text: a list with a braced section, as a template may have — no comments, no
// strings; the indentation is kept.
export const fixture: Fixture = {
  language: 'text',
  targetName: 'target',
  indent: '    ',
  indentIsSyntax: true,
  outerIsNoBlock: true,
  noStrings: true,
  stmt: (name, arg) => `${name} ${arg}`,
  decl: (name) => `  ${name} {\n    a\n  }`,
  topLine: 'added line',
  tail: 'tail line',
  comment: (text) => `note: ${text}`,
  str: (text) => `label "${text}"`,
  broken: 'unclosed ( bracket',
  render: (s) => {
    const target = ['  target {', opt(s.inner), '    positive (', '      1, 2', '    )', s.edit, '    end', '  }'];
    return file(
      'matrix fixture',
      'base line',
      opt(s.top),
      `${s.outer}:`,
      '  sibling {',
      '    a',
      '  }',
      opt(s.above),
      ...(s.twice ? target : []),
      ...(s.target ? target : []),
      opt(s.below),
      opt(s.bottom),
    );
  },
};
