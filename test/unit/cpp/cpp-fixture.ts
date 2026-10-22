import { file, opt } from '../../matrix.ts';
import type { Fixture } from '../../matrix.ts';

export const fixture: Fixture = {
  language: 'cpp',
  targetName: 'Target',
  indent: '  ',
  stmt: (name, arg) => `${name}(${arg});`,
  decl: (name) => `void ${name}() {\n  Log("${name}");\n}`,
  topLine: '#include <vector>',
  tail: 'int Tail() { return 0; }',
  comment: (text) => `// ${text}`,
  str: (text) => `Log("${text}");`,
  multiline: (text) => ['  const char* kText = R"(', `${text}`, ')";'],
  broken: 'BEGIN_METADATA(View, x',
  minified: (edited, drifted = false) =>
    Array.from({ length: drifted ? 31 : 30 }, (_, i) => `int F${i}(int x){if(x>${i}){return ${edited && i === 15 ? 'x+1' : 'x'};}return ${i};}`).join(' ') +
    '\n',
  render: (s) => {
    const target = ['int Target(int x) {', opt(s.inner), '  if (x > 0) {', '    Log("positive");', '  }', s.edit, '  return x;', '}'];
    return file(
      '// matrix fixture',
      '#include <string>',
      opt(s.top),
      '',
      `namespace ${s.outer} {`,
      '',
      'void Sibling() {',
      '  Log("sibling");',
      '}',
      opt(s.above),
      '',
      ...(s.twice ? [...target, ''] : []),
      ...(s.target ? target : []),
      opt(s.below),
      '',
      `}  // namespace ${s.outer}`,
      opt(s.bottom),
    );
  },
};
