import { file, opt } from '../../matrix.ts';
import type { Fixture } from '../../matrix.ts';

export const fixture: Fixture = {
  language: 'proto',
  targetName: 'Target',
  indent: '    ',
  stmt: (name, arg) => `optional string ${name} = 1 [default = '${arg}'];`,
  decl: (name) => `  message ${name} {\n    optional int32 a = 1;\n  }`,
  topLine: 'import "base.proto";',
  tail: 'message Tail {}',
  comment: (text) => `// ${text}`,
  str: (text) => `optional string label = 2 [default = "${text}"];`,
  broken: 'optional int32 broken = [;',
  minified: (edited, drifted = false) =>
    'message M{' + Array.from({ length: drifted ? 31 : 30 }, (_, i) => `optional int32 f${i}=${edited && i === 15 ? 99 : i + 1};`).join('') + '}\n',
  render: (s) => {
    const target = ['  message Target {', opt(s.inner), '    enum Positive {', '      POSITIVE = 0;', '    }', s.edit, '    optional bool end = 9;', '  }'];
    return file(
      '// matrix fixture',
      'syntax = "proto2";',
      opt(s.top),
      '',
      `message ${s.outer} {`,
      '  optional int32 sibling = 1;',
      opt(s.above),
      ...(s.twice ? target : []),
      ...(s.target ? target : []),
      opt(s.below),
      '}',
      opt(s.bottom),
    );
  },
};
