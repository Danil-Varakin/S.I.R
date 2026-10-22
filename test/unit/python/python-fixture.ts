import { file, opt } from '../../matrix.ts';
import type { Fixture } from '../../matrix.ts';

export const fixture: Fixture = {
  language: 'python',
  targetName: 'target',
  indentIsSyntax: true,
  indent: '        ',
  stmt: (name, arg) => `${name}(${arg})`,
  decl: (name) => `    def ${name}(self):\n        log("${name}")\n`,
  topLine: 'import sys',
  tail: 'def tail():\n    return 0',
  comment: (text) => `# ${text}`,
  str: (text) => `log("${text}")`,
  multiline: (text) => ['        t = """', `        ${text}`, '        """'],
  broken: 'log(x +)',
  render: (s) => {
    const target = ['    def target(self, x):', opt(s.inner), '        if x > 0:', '            log("positive")', s.edit, '        return x', ''];
    return file(
      '# matrix fixture',
      'import os',
      opt(s.top),
      '',
      '',
      `class ${s.outer}:`,
      '',
      '    def sibling(self):',
      '        log("sibling")',
      '',
      opt(s.above),
      ...(s.twice ? target : []),
      ...(s.target ? target : []),
      opt(s.below),
      '',
      opt(s.bottom),
    );
  },
};
