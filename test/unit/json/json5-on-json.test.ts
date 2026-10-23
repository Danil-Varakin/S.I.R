import { test } from 'node:test';
import assert from 'node:assert/strict';

import { jsonAdapter } from '../../../src/lang/json/index.ts';
import { loadGrammar, parse } from '../../../src/lang/treesitter.ts';
import type { Node } from '../../../src/lang/treesitter.ts';
import { resolveGrammar } from '../../../src/infra/grammar-store.ts';

function file(key: (s: string) => string, quote: string, trailing: string, comment: boolean): string {
  return [
    '{',
    ...(comment ? ['  // Features.'] : []),
    `  ${key('data')}: [`,
    '    {',
    `      ${key('name')}: ${quote}Accelerated2dCanvas${quote},`,
    `      ${key('status')}: ${quote}stable${quote}${trailing}`,
    '    },',
    '    {',
    `      ${key('name')}: ${quote}BraveShields${quote},`,
    `      ${key('status')}: ${quote}experimental${quote}${trailing}`,
    `    }${trailing}`,
    `  ]${trailing}`,
    '}',
    '',
  ].join('\n');
}

const quoted = (s: string): string => `"${s}"`;
const bare = (s: string): string => s;

test('JSON5 on the JSON grammar: ERROR nodes and the share of the file inside them, trait by trait', async () => {
  const grammar = await loadGrammar('json5-probe', await resolveGrammar(jsonAdapter.grammar));
  const cases: [string, string][] = [
    ['json', file(quoted, '"', '', false)],
    ['comments', file(quoted, '"', '', true)],
    ['trailing comma', file(quoted, '"', ',', false)],
    ['single quotes', file(quoted, "'", '', false)],
    ['bare keys', file(bare, '"', '', false)],
    ['all of it', file(bare, '"', ',', true)],
  ];
  const got: Record<string, string> = {};
  for (const [name, source] of cases) {
    const tree = parse(grammar, source);
    let err = 0;
    let bytes = 0;
    const walk = (n: Node, inside: boolean): void => {
      if (n.isError) {
        err++;
        if (!inside) bytes += n.endIndex - n.startIndex;
      }
      for (const c of n.children) if (c !== null) walk(c, inside || n.isError);
    };
    walk(tree.rootNode, false);
    tree.delete();
    got[name] = `ERR ${err} err% ${Math.round((100 * bytes) / source.length)}`;
  }
  assert.deepEqual(got, {
    json: 'ERR 0 err% 0',
    comments: 'ERR 0 err% 0',
    'trailing comma': 'ERR 3 err% 2',
    'single quotes': 'ERR 10 err% 96',
    'bare keys': 'ERR 13 err% 45',
    'all of it': 'ERR 12 err% 99',
  });
});
