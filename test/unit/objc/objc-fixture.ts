import { file, opt } from '../../matrix.ts';
import type { Fixture } from '../../matrix.ts';

export const fixture: Fixture = {
  language: 'objc',
  outerIsNoBlock: true,
  targetName: 'target',
  indent: '  ',
  stmt: (name, arg) => `${name}(${arg});`,
  decl: (name) => `- (void)${name} {\n  Log(@"${name}");\n}`,
  topLine: '#import <UIKit/UIKit.h>',
  tail: 'static int Tail(void) { return 0; }',
  comment: (text) => `// ${text}`,
  str: (text) => `Log(@"${text}");`,
  broken: 'BEGIN_METADATA(View, x',
  minified: (edited, drifted = false) =>
    '@implementation M ' +
    Array.from({ length: drifted ? 31 : 30 }, (_, i) => `- (int)f${i}:(int)x{if(x>${i}){return ${edited && i === 15 ? 'x+1' : 'x'};}return ${i};}`).join(' ') +
    ' @end\n',
  render: (s) => {
    const target = ['- (int)target:(int)x {', opt(s.inner), '  if (x > 0) {', '    Log(@"positive");', '  }', s.edit, '  return x;', '}'];
    return file(
      '// matrix fixture',
      '#import <Foundation/Foundation.h>',
      opt(s.top),
      '',
      `@implementation ${s.outer}`,
      '',
      '- (void)sibling {',
      '  Log(@"sibling");',
      '}',
      opt(s.above),
      '',
      ...(s.twice ? [...target, ''] : []),
      ...(s.target ? target : []),
      opt(s.below),
      '',
      '@end',
      opt(s.bottom),
    );
  },
};
