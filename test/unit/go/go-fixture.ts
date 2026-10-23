import { file, opt } from '../../matrix.ts';
import type { Fixture } from '../../matrix.ts';

export const fixture: Fixture = {
  language: 'go',
  todo: { К13: '07-findings Н7: имя присвоенного блока вне заголовка (`target := func`)' },
  targetName: 'target',
  indent: '\t\t',
  stmt: (name, arg) => `${name}(${arg})`,
  decl: (name) => `\t${name} := func() {\n\t\tlog("${name}")\n\t}`,
  topLine: 'import "os"',
  tail: 'func tail() int { return 0 }',
  comment: (text) => `// ${text}`,
  str: (text) => `log("${text}")`,
  multiline: (text) => ['\t\tt := `', `${text}`, '`'],
  broken: 'log(x +)',
  minified: (edited, drifted = false) =>
    'package m; ' +
    Array.from({ length: drifted ? 31 : 30 }, (_, i) => `func f${i}(x int) int { if x > ${i} { return ${edited && i === 15 ? 'x + 1' : 'x'} }; return ${i} }`).join('; ') +
    '\n',
  render: (s) => {
    const target = ['\ttarget := func(x int) int {', opt(s.inner), '\t\tif x > 0 {', '\t\t\tlog("positive")', '\t\t}', s.edit, '\t\treturn x', '\t}'];
    return file(
      '// matrix fixture',
      'package matrix',
      '',
      'import "fmt"',
      opt(s.top),
      '',
      'func sibling() {',
      '\tlog("sibling")',
      '}',
      '',
      `func ${s.outer}() {`,
      '\tlog("start")',
      opt(s.above),
      ...(s.twice ? target : []),
      ...(s.target ? target : []),
      opt(s.below),
      '\tfmt.Println(target(1))',
      '}',
      opt(s.bottom),
    );
  },
};
