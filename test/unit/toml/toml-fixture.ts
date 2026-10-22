import { file, opt } from '../../matrix.ts';
import type { Fixture } from '../../matrix.ts';

// TOML as text: tables are lines, so the outer table is no block of the map; arrays and
// inline tables are pairs of brackets.
export const fixture: Fixture = {
  language: 'toml',
  targetName: 'target',
  indent: '  ',
  outerIsNoBlock: true,
  c1ByNeighbour: true,
  stmt: (name, arg) => `${name} = "${arg}"`,
  decl: (name) => `[Outer.${name}]\na = 1`,
  topLine: 'added = 1',
  tail: '[tail]\nb = 0',
  comment: (text) => `# ${text}`,
  str: (text) => `label = "${text}"`,
  multiline: (text) => ['  doc = """', `${text}`, '"""'],
  broken: 'bad = [1, 2',
  minified: (edited, drifted = false) =>
    'm = { ' + Array.from({ length: drifted ? 31 : 30 }, (_, i) => `f${i} = ${edited && i === 15 ? 99 : i}`).join(', ') + ' }\n',
  render: (s) => {
    const target = [`[${s.outer}.target]`, opt(s.inner), '  positive = [', '    1,', '    2,', '  ]', s.edit, '  end = true'];
    return file(
      '# matrix fixture',
      'version = 1',
      opt(s.top),
      '',
      `[${s.outer}]`,
      'sibling = { a = 1 }',
      opt(s.above),
      ...(s.twice ? target : []),
      ...(s.target ? target : []),
      opt(s.below),
      opt(s.bottom),
    );
  },
};
