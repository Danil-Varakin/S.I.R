import { file, opt } from '../../matrix.ts';
import type { Fixture } from '../../matrix.ts';

// Blink IDL as text: an interface with a dictionary in it — blocks by their braces,
// extended attributes `[…]` pairs of brackets.
export const fixture: Fixture = {
  language: 'idl',
  targetName: 'target',
  indent: '        ',
  stmt: (name, arg) => `long ${name} = ${arg};`,
  decl: (name) => `    readonly attribute long ${name};`,
  topLine: 'typedef long Top;',
  tail: 'typedef long Tail;',
  comment: (text) => `// ${text}`,
  str: (text) => `DOMString label = "${text}";`,
  broken: '[RaisesException long broken;',
  minified: (edited, drifted = false) =>
    'dictionary M{' + Array.from({ length: drifted ? 31 : 30 }, (_, i) => `long f${i}=${edited && i === 15 ? 99 : i};`).join('') + '};\n',
  render: (s) => {
    const target = ['    dictionary target {', opt(s.inner), '        [Positive] {', '            long positive;', '        };', s.edit, '        long end;', '    };'];
    return file(
      '// matrix fixture',
      'typedef long Base;',
      opt(s.top),
      '[',
      '    Exposed=Window',
      `] interface ${s.outer} {`,
      '    readonly attribute long sibling;',
      opt(s.above),
      ...(s.twice ? target : []),
      ...(s.target ? target : []),
      opt(s.below),
      '};',
      opt(s.bottom),
    );
  },
};
