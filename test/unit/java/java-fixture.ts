import { file, opt } from '../../matrix.ts';
import type { Fixture } from '../../matrix.ts';

export const fixture: Fixture = {
  language: 'java',
  targetName: 'target',
  indent: '        ',
  stmt: (name, arg) => `${name}(${arg});`,
  decl: (name) => `    void ${name}() {\n        log("${name}");\n    }`,
  topLine: 'import java.util.Map;',
  tail: 'class Tail {}',
  comment: (text) => `// ${text}`,
  str: (text) => `log("${text}");`,
  multiline: (text) => ['        String t = """', `            ${text}`, '            """;'],
  broken: 'log(x +);',
  minified: (edited, drifted = false) =>
    'class M{' +
    Array.from({ length: drifted ? 31 : 30 }, (_, i) => `int f${i}(int x){if(x>${i}){return ${edited && i === 15 ? 'x+1' : 'x'};}return ${i};}`).join(' ') +
    '}\n',
  render: (s) => {
    const target = ['    int target(int x) {', opt(s.inner), '        if (x > 0) {', '            log("positive");', '        }', s.edit, '        return x;', '    }'];
    return file(
      '// matrix fixture',
      'package matrix;',
      '',
      'import java.util.List;',
      opt(s.top),
      '',
      `class ${s.outer} {`,
      '',
      '    void sibling() {',
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
