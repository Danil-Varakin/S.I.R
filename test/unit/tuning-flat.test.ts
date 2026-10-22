import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PROFILES, tuneOne } from '../../bench/run.ts';
import { TUNE_FLAT } from '../../bench/corpus.ts';
import { adapterForLanguage } from '../../src/lang/adapter.ts';

// The `tuning-flat` case of `npm run bench` (bench/corpus.ts, TUNE_FLAT): the model of
// `tuning` with a unit that no block of its own ends — `case G3:`, `#if`, `<li>`, `[g3]`
// — so the line after the target unit is the first line of the next one. Python's
// defect (docs/BACKLOG.md §1, "сосед снизу вместо закрывашки") is a pattern leaning on
// that line; this holds where else it does. All in docs/BACKLOG.md (Г3, 2026-10-21,
// `tuning-flat`). The bench runs the whole grid; here three profiles, depth 1–2.

const ready = new Set<string>();

// a unit inside brackets: the label of the unit is never a parent nor a neighbour
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
  // bracketed: no move lands wrong; only the edit at the end of a block a new block now
  // wraps — "before the function's closer", as in `tuning` (BACKLOG §1, 🔬 `wrap`)
  'bracketed wrap',
  // read as text, no block at all: the neighbour below is the next unit's first line, and
  // a unit that changes its place among its neighbours lands where that line now follows
  // JavaScript inside `<script>`: the grammar of HTML reads it as raw text, no block in it
  ...NEIGHBOUR_MOVES.map((d) => `html-script ${d}`),
  'html-script wrap',
  ...NEIGHBOUR_MOVES.map((d) => `shell-if ${d}`),
  'shell-if wrap',
  ...NEIGHBOUR_MOVES.map((d) => `text ${d}`),
  // an anchor that matches the start of a longer line (07-findings Н8)
  'text near-args',
  ...NEIGHBOUR_MOVES.map((d) => `toml ${d}`),
].sort();
