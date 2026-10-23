import { file, opt } from '../../matrix.ts';
import type { Fixture } from '../../matrix.ts';

export const fixture: Fixture = {
  language: 'html',
  targetName: 'target',
  indent: '    ',
  stmt: (name, arg) => `<span class="${name}">${arg}</span>`,
  decl: (name) => `  <section id="${name}">\n    <p>${name}</p>\n  </section>`,
  topLine: '<link rel="icon" href="icon.png">',
  tail: '<footer>tail</footer>',
  comment: (text) => `<!-- ${text} -->`,
  str: (text) => `<span title="${text}"></span>`,
  multiline: (text) => ['    <span title="', `${text}`, '"></span>'],
  broken: '<span class="a" <b>',
  minified: (edited, drifted = false) =>
    '<ul>' +
    Array.from({ length: drifted ? 31 : 30 }, (_, i) => `<li id="f${i}"><b>${edited && i === 15 ? 'changed' : `item ${i}`}</b></li>`).join('') +
    '</ul>\n',
  render: (s) => {
    const target = ['  <section id="target">', opt(s.inner), '    <ul class="positive">', '      <li>positive</li>', '    </ul>', s.edit, '    <p>end</p>', '  </section>'];
    return file(
      '<!-- matrix fixture -->',
      '<link rel="stylesheet" href="a.css">',
      opt(s.top),
      `<div id="${s.outer}">`,
      '  <section id="sibling">',
      '    <p>sibling</p>',
      '  </section>',
      opt(s.above),
      ...(s.twice ? target : []),
      ...(s.target ? target : []),
      opt(s.below),
      '</div>',
      opt(s.bottom),
    );
  },
};
