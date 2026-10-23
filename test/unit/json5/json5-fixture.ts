import { file, opt } from '../../matrix.ts';
import type { Fixture } from '../../matrix.ts';

export const fixture: Fixture = {
  language: 'json5',
  targetName: 'target',
  indent: '      ',
  stmt: (name, arg) => `${name}: "${arg}",`,
  decl: (name) => `    ${name}: {\n      a: 1,\n    },`,
  topLine: '  added: 1,',
  tail: '  tail: 0,',
  comment: (text) => `// ${text}`,
  str: (text) => `label: "${text}",`,
  broken: 'bad: ,,',
  minified: (edited, drifted = false) =>
    '{' + Array.from({ length: drifted ? 31 : 30 }, (_, i) => `f${i}:{v:${edited && i === 15 ? 99 : i}}`).join(',') + '}\n',
  render: (s) => {
    const target = ['    target: {', opt(s.inner), '      positive: [', '        1,', '        2,', '      ],', s.edit, '      end: true,', '    },'];
    return file(
      '{',
      '  // matrix fixture',
      '  version: 1,',
      opt(s.top),
      `  ${s.outer}: {`,
      '    sibling: {',
      '      a: 1,',
      '    },',
      opt(s.above),
      ...(s.twice ? target : []),
      ...(s.target ? target : []),
      opt(s.below),
      '  },',
      opt(s.bottom),
      '}',
    );
  },
};
