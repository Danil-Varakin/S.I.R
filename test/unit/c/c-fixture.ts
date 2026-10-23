import { file, opt } from '../../matrix.ts';
import type { Fixture } from '../../matrix.ts';

export const fixture: Fixture = {
  language: 'c',
  targetName: 'x > 0',
  indent: '    ',
  stmt: (name, arg) => `${name}(${arg});`,
  decl: (name) => `  int ${name} = 0;`,
  topLine: '#include <string.h>',
  tail: 'int tail(void) { return 0; }',
  comment: (text) => `/* ${text} */`,
  str: (text) => `log_msg("${text}");`,
  broken: 'DEFINE_TABLE(x,',
  minified: (edited, drifted = false) =>
    Array.from({ length: drifted ? 31 : 30 }, (_, i) => `int f${i}(int x){if(x>${i}){return ${edited && i === 15 ? 'x+1' : 'x'};}return ${i};}`).join(' ') +
    '\n',
  render: (s) => {
    const target = ['  if (x > 0) {', opt(s.inner), '    if (x > 9) {', '      log_msg("big");', '    }', s.edit, '    log_msg("tail");', '  }'];
    return file(
      '/* matrix fixture */',
      '#include <stdio.h>',
      opt(s.top),
      '',
      'static void sibling(void) {',
      '  log_msg("sibling");',
      '}',
      '',
      `int ${s.outer}(int x) {`,
      '  log_msg("start");',
      opt(s.above),
      ...(s.twice ? target : []),
      ...(s.target ? target : []),
      opt(s.below),
      '  return x;',
      '}',
      opt(s.bottom),
    );
  },
};
