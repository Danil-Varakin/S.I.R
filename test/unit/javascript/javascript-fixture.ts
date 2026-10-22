import { file, opt } from '../../matrix.ts';
import type { Fixture } from '../../matrix.ts';

export const fixture: Fixture = {
  language: 'javascript',
  targetName: 'target',
  indent: '    ',
  stmt: (name, arg) => `${name}(${arg});`,
  decl: (name) => `  ${name}() {\n    log('${name}');\n  }`,
  topLine: "import { b } from './b';",
  tail: 'export const tail = 0;',
  comment: (text) => `// ${text}`,
  str: (text) => `log("${text}");`,
  multiline: (text) => ['    const t = `', `${text}`, '`;'],
  broken: 'log(x +);',
  minified: (edited, drifted = false) =>
    'class M{' +
    Array.from({ length: drifted ? 31 : 30 }, (_, i) => `f${i}(x){if(x>${i}){return ${edited && i === 15 ? 'x+1' : 'x'};}return ${i};}`).join(' ') +
    '}\n',
  render: (s) => {
    const target = ['  target(x) {', opt(s.inner), '    if (x > 0) {', "      log('positive');", '    }', s.edit, '    return x;', '  }'];
    return file(
      '// matrix fixture',
      "import { a } from './a';",
      opt(s.top),
      '',
      `export class ${s.outer} {`,
      '  sibling() {',
      "    log('sibling');",
      '  }',
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
