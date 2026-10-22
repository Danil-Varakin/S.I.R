import { file, opt } from '../../matrix.ts';
import type { Fixture } from '../../matrix.ts';

// The outer block is a cascade layer named after `@layer`, the target a rule in it with a
// nested rule of its own (CSS nesting).
export const fixture: Fixture = {
  language: 'css',
  targetName: 'target',
  indent: '    ',
  stmt: (name, arg) => `${name}: ${arg};`,
  decl: (name) => `  .${name} {\n    color: red;\n  }`,
  topLine: '@import url(b.css);',
  tail: '.tail { color: red; }',
  comment: (text) => `/* ${text} */`,
  str: (text) => `content: "${text}";`,
  broken: '@@@ bad;',
  minified: (edited, drifted = false) =>
    Array.from({ length: drifted ? 31 : 30 }, (_, i) => `.f${i}{color:${edited && i === 15 ? 'blue' : 'red'};margin:${i}px}`).join('') + '\n',
  render: (s) => {
    const target = ['  .target {', opt(s.inner), '    & .positive {', '      color: green;', '    }', s.edit, '    margin: 0;', '  }'];
    return file(
      '/* matrix fixture */',
      '@import url(a.css);',
      opt(s.top),
      '',
      `@layer ${s.outer} {`,
      '  .sibling {',
      '    color: blue;',
      '  }',
      opt(s.above),
      ...(s.twice ? target : []),
      ...(s.target ? target : []),
      opt(s.below),
      '}',
      opt(s.bottom),
    );
  },
};
