import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PROFILES, tuneOne } from '../../bench/run.ts';
import { TUNE_FLAT } from '../../bench/corpus.ts';
import { adapterForLanguage } from '../../src/lang/adapter.ts';

const ready = new Set<string>();

const BRACKETED = new Set(['cpp-case', 'go-case', 'cpp-ifdef', 'html-li', 'shell-case']);

test('tuning-flat: the wrong landings, by how the unit ends', async () => {
  const wrong = new Set<string>();
  for (const [form, syntax] of Object.entries(TUNE_FLAT)) {
    if (!ready.has(syntax.language)) {
      await adapterForLanguage(syntax.language).init();
      ready.add(syntax.language);
    }
    for (const label of ['default', 'parents 1', 'min-parents 9']) {
      const settings = PROFILES.find(([l]) => l === label)![1];
      for (const depth of [1, 2]) {
        for (const regime of ['repeat', 'clone'] as const) {
          for (const at of ['middle', 'end'] as const) {
            const c = await tuneOne(form, { units: 8, depth, regime, at }, settings, 20_000);
            for (const [drift, outcome] of c.drifts) {
              if (outcome === 'WRONG') wrong.add(`${BRACKETED.has(form) ? 'bracketed' : form} ${drift}`);
            }
          }
        }
      }
    }
  }
  assert.deepEqual([...wrong].sort(), EXPECTED);
});

const NEIGHBOUR_MOVES = ['move', 'move-first', 'next-new', 'swap-next', 'swap-prev'];

const EXPECTED: string[] = [
  'bracketed wrap',
  ...NEIGHBOUR_MOVES.map((d) => `html-script ${d}`),
  'html-script wrap',
  ...NEIGHBOUR_MOVES.map((d) => `shell-if ${d}`),
  'shell-if wrap',
  ...NEIGHBOUR_MOVES.map((d) => `text ${d}`),
  'text near-args',
  ...NEIGHBOUR_MOVES.map((d) => `toml ${d}`),
].sort();
