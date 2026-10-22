import { file, opt } from '../../matrix.ts';
import type { Fixture } from '../../matrix.ts';

export const fixture: Fixture = {
  language: 'kotlin',
  targetName: 'target',
  indent: '        ',
  stmt: (name, arg) => `${name}(${arg})`,
  decl: (name) => `    fun ${name}() {\n        log("${name}")\n    }`,
  topLine: 'import kotlin.math.min',
  tail: 'fun tail() = 0',
  comment: (text) => `// ${text}`,
  str: (text) => `log("${text}")`,
  multiline: (text) => ['        val t = """', `            ${text}`, '        """'],
  broken: 'log(x +)',
  minified: (edited, drifted = false) =>
    'class M { ' +
    Array.from({ length: drifted ? 31 : 30 }, (_, i) => `fun f${i}(x: Int): Int { if (x > ${i}) { return ${edited && i === 15 ? 'x + 1' : 'x'} }; return ${i} }`).join('; ') +
    ' }\n',
  render: (s) => {
    const target = ['    fun target(x: Int): Int {', opt(s.inner), '        if (x > 0) {', '            log("positive")', '        }', s.edit, '        return x', '    }'];
    return file(
      '// matrix fixture',
      'package matrix',
      '',
      'import kotlin.math.max',
      opt(s.top),
      '',
      `class ${s.outer} {`,
      '',
      '    fun sibling() {',
      '        log("sibling")',
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
