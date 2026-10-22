import { file, opt } from '../../matrix.ts';
import type { Fixture } from '../../matrix.ts';

export const fixture: Fixture = {
  language: 'tsx',
  targetName: 'target',
  indent: '    ',
  stmt: (name, arg) => `${name}(${arg});`,
  decl: (name) => `  ${name}(): JSX.Element {\n    log('${name}');\n  }`,
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
    const target = ['  target(x: number): number {', opt(s.inner), '    if (x > 0) {', "      log('positive');", '    }', s.edit, '    return x;', '  }'];
    return file(
      '// matrix fixture',
      "import { a } from './a';",
      opt(s.top),
      '',
      `export class ${s.outer} {`,
      '  sibling(): JSX.Element {',
      "    return <div>sibling</div>;",
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
