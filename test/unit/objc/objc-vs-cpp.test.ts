import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { adapterForLanguage } from '../../../src/lang/adapter.ts';
import { loadGrammar, parse } from '../../../src/lang/treesitter.ts';
import type { Node } from '../../../src/lang/treesitter.ts';
import { resolveGrammar } from '../../../src/infra/grammar-store.ts';
import { synthesize } from '../../../src/generate/synth.ts';
import { printSirFile } from '../../../src/generate/printer.ts';
import { parseSirFile } from '../../../src/core/sir-parser.ts';
import { applyAll } from '../../../src/core/apply.ts';

// The numbers of Р4 (docs/10-brave-languages.md, stage 4): every mixed .mm and every
// Objective-C header, read by the Objective-C grammar and by the C++ one. A change of a
// grammar, an adapter or synthesis that moves one of them is seen here — and the table
// in the plan is updated with it.
//
//   err%     bytes inside the outermost ERROR nodes, of the file
//   drift    the patch on a base upstream added a line to, at the top and at the end
//   repeat   ... upstream copied the anchor line into a block of its own at the end: a
//            pattern that holds by structure lands, one that does not refuses

const GOLDEN = join(import.meta.dirname, '..', '..', 'golden');

const SAMPLES = [
  'objc/generate/test11.mm', 'objc/generate/test15.mm', 'objc/generate/test16.mm', 'objc/generate/test17.mm',
  'objc/generate/test18.mm', 'objc/generate/test19.mm',
  'cpp/generate/test88.h', 'cpp/generate/test89.h', 'cpp/generate/test90.h', 'cpp/generate/test91.h',
];

const EXPECTED: Record<string, Record<string, string>> = {
  objc: {
    'objc/11': 'ERR 3 MISS 1 err% 20 | drift lands | repeat lands',
    'objc/15': 'ERR 20 MISS 3 err% 79 | drift lands | repeat AmbiguityError',
    'objc/16': 'ERR 3 MISS 1 err% 5 | drift lands | repeat lands',
    'objc/17': 'ERR 10 MISS 2 err% 14 | drift lands | repeat lands',
    'objc/18': 'ERR 6 MISS 1 err% 6 | drift lands | repeat lands',
    'objc/19': 'ERR 0 MISS 0 err% 0 | drift lands | repeat lands',
    'cpp/88': 'ERR 1 MISS 1 err% 6 | drift lands | repeat AmbiguityError',
    'cpp/89': 'ERR 0 MISS 0 err% 0 | drift lands | repeat AmbiguityError',
    'cpp/90': 'ERR 0 MISS 0 err% 0 | drift lands | repeat lands',
    'cpp/91': 'ERR 0 MISS 0 err% 0 | drift lands | repeat lands',
  },
  cpp: {
    'objc/11': 'ERR 5 MISS 1 err% 20 | drift lands | repeat lands',
    'objc/15': 'ERR 7 MISS 1 err% 9 | drift lands | repeat lands',
    'objc/16': 'ERR 6 MISS 4 err% 21 | drift lands | repeat lands',
    'objc/17': 'ERR 9 MISS 1 err% 14 | drift lands | repeat lands',
    'objc/18': 'ERR 14 MISS 0 err% 54 | drift lands | repeat lands',
    'objc/19': 'ERR 4 MISS 3 err% 2 | drift lands | repeat AmbiguityError',
    'cpp/88': 'ERR 11 MISS 1 err% 30 | drift lands | repeat AmbiguityError',
    'cpp/89': 'ERR 14 MISS 2 err% 41 | drift lands | repeat AmbiguityError',
    'cpp/90': 'ERR 4 MISS 0 err% 0 | drift lands | repeat lands',
    'cpp/91': 'ERR 8 MISS 3 err% 5 | drift lands | repeat lands',
  },
};

function errors(root: Node, size: number): string {
  let err = 0;
  let miss = 0;
  let bytes = 0;
  const walk = (n: Node, inside: boolean): void => {
    if (n.isError) {
      err++;
      if (!inside) bytes += n.endIndex - n.startIndex;
    }
    if (n.isMissing) miss++;
    for (const c of n.children) if (c !== null) walk(c, inside || n.isError);
  };
  walk(root, false);
  return `ERR ${err} MISS ${miss} err% ${Math.round((100 * bytes) / size)}`;
}

const outcome = (run: () => string, expected: string): string => {
  try {
    return run() === expected ? 'lands' : 'WRONG';
  } catch (e) {
    return (e as Error).constructor.name;
  }
};

for (const language of ['objc', 'cpp']) {
  test(`Р4: ${language} grammar over mixed .mm and Objective-C headers`, async () => {
    const adapter = adapterForLanguage(language);
    await adapter.init();
    const grammar = await loadGrammar(`r4-${language}`, await resolveGrammar(adapter.grammar!));
    const got: Record<string, string> = {};
    for (const sample of SAMPLES) {
      const ext = sample.slice(sample.lastIndexOf('.'));
      const stem = sample.slice(0, -ext.length);
      const oldText = readFileSync(join(GOLDEN, `${stem}.old${ext}`), 'utf8');
      const newText = readFileSync(join(GOLDEN, `${stem}.new${ext}`), 'utf8');

      const tree = parse(grammar, oldText);
      const err = errors(tree.rootNode, oldText.length);
      tree.delete();

      const patch = parseSirFile(printSirFile(synthesize(oldText, newText, adapter), adapter.name));
      const drift = (t: string): string => {
        const lines = t.split('\n');
        lines.splice(1, 0, '#include "upstream/added.h"');
        return `${lines.join('\n')}// upstream tail\n`;
      };
      const o = oldText.split('\n');
      const n = newText.split('\n');
      let k = 0;
      while (o[k] === n[k]) k++;
      const anchor = n.length > o.length ? o[k - 1]! : o[k]!;
      const copy = ext === '.mm' ? `void UpstreamCopy() {\n${anchor}\n}\n` : `@interface UpstreamCopy : NSObject\n${anchor}\n@end\n`;
      const repeat = (t: string): string => t + copy;

      got[stem.replace('/generate/test', '/')] = [
        err,
        `drift ${outcome(() => applyAll(drift(oldText), patch, adapter).source, drift(newText))}`,
        `repeat ${outcome(() => applyAll(repeat(oldText), patch, adapter).source, repeat(newText))}`,
      ].join(' | ');
    }
    assert.deepEqual(got, EXPECTED[language]);
  });
}
