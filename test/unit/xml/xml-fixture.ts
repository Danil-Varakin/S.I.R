import { file, opt } from '../../matrix.ts';
import type { Fixture } from '../../matrix.ts';

export const fixture: Fixture = {
  language: 'xml',
  targetName: 'target',
  indent: '    ',
  stmt: (name, arg) => `<item name="${name}">${arg}</item>`,
  decl: (name) => `  <array name="${name}">\n    <item>${name}</item>\n  </array>`,
  topLine: '<integer name="added">1</integer>',
  tail: '<!-- tail -->',
  comment: (text) => `<!-- ${text} -->`,
  str: (text) => `<item value="${text}"/>`,
  multiline: (text) => ['    <item value="', `${text}`, '"/>'],
  broken: '<item name="x"',
  minified: (edited, drifted = false) =>
    '<resources>' +
    Array.from({ length: drifted ? 31 : 30 }, (_, i) => `<item name="f${i}">${edited && i === 15 ? 'changed' : `value ${i}`}</item>`).join('') +
    '</resources>\n',
  render: (s) => {
    const target = ['  <array name="target">', opt(s.inner), '    <group name="positive">', '      <item>positive</item>', '    </group>', s.edit, '    <item>end</item>', '  </array>'];
    return file(
      '<?xml version="1.0" encoding="utf-8"?>',
      '<!-- matrix fixture -->',
      '<resources>',
      opt(s.top),
      `<group name="${s.outer}">`,
      '  <item name="sibling">sibling</item>',
      opt(s.above),
      ...(s.twice ? target : []),
      ...(s.target ? target : []),
      opt(s.below),
      '</group>',
      '</resources>',
      opt(s.bottom),
    );
  },
};
