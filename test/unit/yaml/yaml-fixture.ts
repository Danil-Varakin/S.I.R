import { file, opt } from '../../matrix.ts';
import type { Fixture } from '../../matrix.ts';

export const fixture: Fixture = {
  language: 'yaml',
  targetName: 'target',
  indent: '    ',
  indentIsSyntax: true,
  outerIsNoBlock: true,
  c1ByNeighbour: true,
  stmt: (name, arg) => `${name}: "${arg}"`,
  decl: (name) => `  ${name}:\n    a: 1`,
  topLine: 'added: 1',
  tail: 'tail: 0',
  comment: (text) => `# ${text}`,
  str: (text) => `label: "${text}"`,
  broken: 'bad: [unclosed',
  render: (s) => {
    const target = ['  target:', opt(s.inner), '    positive:', '      - 1', '      - 2', s.edit, '    end: true'];
    return file(
      '# matrix fixture',
      'version: 1',
      opt(s.top),
      `${s.outer}:`,
      '  sibling:',
      '    a: 1',
      opt(s.above),
      ...(s.twice ? target : []),
      ...(s.target ? target : []),
      opt(s.below),
      opt(s.bottom),
    );
  },
};
