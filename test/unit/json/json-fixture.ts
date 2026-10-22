import { file, opt } from '../../matrix.ts';
import type { Fixture } from '../../matrix.ts';

// A pair is a statement and ends in a comma; the last pair of the target, `"end"`, has
// none — so every change stands before it, as in a real file. The outer block is the
// object under a key.
export const fixture: Fixture = {
  language: 'json',
  targetName: 'target',
  indent: '      ',
  stmt: (name, arg) => `"${name}": "${arg}",`,
  decl: (name) => `    "${name}": {\n      "a": 1\n    },`,
  topLine: '  "added": 1,',
  tail: '  "tail": 0,',
  comment: (text) => `// ${text}`,
  str: (text) => `"label": "${text}",`,
  broken: '"bad": ,',
  minified: (edited, drifted = false) =>
    '{' + Array.from({ length: drifted ? 31 : 30 }, (_, i) => `"f${i}":{"v":${edited && i === 15 ? 99 : i}}`).join(',') + '}\n',
  render: (s) => {
    const target = ['    "target": {', opt(s.inner), '      "positive": [', '        1,', '        2', '      ],', s.edit, '      "end": true', '    },'];
    return file(
      '{',
      '  "version": 1,',
      opt(s.top),
      `  "${s.outer}": {`,
      '    "sibling": {',
      '      "a": 1',
      '    },',
      opt(s.above),
      ...(s.twice ? target : []),
      ...(s.target ? target : []),
      opt(s.below),
      '    "last": 0',
      '  },',
      opt(s.bottom),
      '  "zzz": 0',
      '}',
    );
  },
};
