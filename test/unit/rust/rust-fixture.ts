import { file, opt } from '../../matrix.ts';
import type { Fixture } from '../../matrix.ts';

export const fixture: Fixture = {
  language: 'rust',
  targetName: 'target',
  indent: '        ',
  stmt: (name, arg) => `${name}(${arg});`,
  decl: (name) => `    fn ${name}(&self) {\n        log("${name}");\n    }`,
  topLine: 'use std::fmt;',
  tail: 'fn tail() -> i32 { 0 }',
  comment: (text) => `// ${text}`,
  str: (text) => `log("${text}");`,
  multiline: (text) => ['        let t = r#"', `${text}`, '"#;'],
  broken: 'log(x +);',
  minified: (edited, drifted = false) =>
    'impl M { ' +
    Array.from({ length: drifted ? 31 : 30 }, (_, i) => `fn f${i}(&self, x: i32) -> i32 { if x > ${i} { return ${edited && i === 15 ? 'x + 1' : 'x'}; } ${i} }`).join(' ') +
    ' }\n',
  render: (s) => {
    const target = ['    fn target(&self, x: i32) -> i32 {', opt(s.inner), '        if x > 0 {', '            log("positive");', '        }', s.edit, '        x', '    }'];
    return file(
      '// matrix fixture',
      'use std::collections::HashMap;',
      opt(s.top),
      '',
      `impl ${s.outer} {`,
      '    fn sibling(&self) {',
      '        log("sibling");',
      '    }',
      opt(s.above),
      '',
      ...(s.twice ? [...target, ''] : []),
      ...(s.target ? target : []),
      opt(s.below),
      '}',
      opt(s.bottom),
    );
  },
};
