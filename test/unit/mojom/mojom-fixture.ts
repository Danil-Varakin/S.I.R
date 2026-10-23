import { file, opt } from '../../matrix.ts';
import type { Fixture } from '../../matrix.ts';

export const fixture: Fixture = {
  language: 'mojom',
  targetName: 'Target',
  indent: '    ',
  stmt: (name, arg) => `int32 ${name} = ${arg};`,
  decl: (name) => `  ${name}() => (bool ok);`,
  topLine: 'import "url/mojom/url.mojom";',
  tail: 'enum Tail { kA };',
  comment: (text) => `// ${text}`,
  str: (text) => `string label = "${text}";`,
  broken: '[Sync] Broken(int32 x =>',
  minified: (edited, drifted = false) =>
    'struct M{' + Array.from({ length: drifted ? 31 : 30 }, (_, i) => `int32 f${i}=${edited && i === 15 ? 99 : i};`).join('') + '};\n',
  render: (s) => {
    const target = ['  struct Target {', opt(s.inner), '    union Positive {', '      int32 positive;', '    };', s.edit, '    int32 end;', '  };'];
    return file(
      '// matrix fixture',
      'module matrix.mojom;',
      opt(s.top),
      '',
      `interface ${s.outer} {`,
      '  Sibling() => (bool ok);',
      opt(s.above),
      ...(s.twice ? target : []),
      ...(s.target ? target : []),
      opt(s.below),
      '};',
      opt(s.bottom),
    );
  },
};
