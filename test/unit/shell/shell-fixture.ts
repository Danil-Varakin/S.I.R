import { file, opt } from '../../matrix.ts';
import type { Fixture } from '../../matrix.ts';

export const fixture: Fixture = {
  language: 'shell',
  targetName: 'target',
  indent: '    ',
  indentIsSyntax: true,
  stmt: (name, arg) => `${name} "${arg}"`,
  decl: (name) => `  ${name}() {\n    log "${name}"\n  }`,
  topLine: 'set -u',
  tail: 'tail() { :; }',
  comment: (text) => `# ${text}`,
  str: (text) => `log "${text}"`,
  broken: 'case "$x" in a) ;;',
  minified: (edited, drifted = false) =>
    Array.from({ length: drifted ? 31 : 30 }, (_, i) => `f${i}() { echo ${edited && i === 15 ? 99 : i}; }`).join('; ') + '\n',
  render: (s) => {
    const target = ['  target() {', opt(s.inner), '    if [ "$x" -gt 0 ]; then', '      log "positive"', '    fi', s.edit, '    return 0', '  }'];
    return file(
      '#!/bin/sh',
      '# matrix fixture',
      opt(s.top),
      '',
      `${s.outer}() {`,
      '  sibling() {',
      '    log "sibling"',
      '  }',
      opt(s.above),
      ...(s.twice ? target : []),
      ...(s.target ? target : []),
      opt(s.below),
      '}',
      opt(s.bottom),
    );
  },
};
