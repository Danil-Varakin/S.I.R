import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PROFILES, tuneOne } from '../../bench/run.ts';
import type { TuneCell } from '../../bench/run.ts';
import { TUNE_SYNTAX } from '../../bench/corpus.ts';
import type { TuneShape } from '../../bench/corpus.ts';
import { adapterForLanguage } from '../../src/lang/adapter.ts';

// What the README's "Settings by task" says, held against the code. The stand is the
// `tuning` case of `npm run bench` (bench/corpus.ts): one model of code in every
// language, a patch generated under a profile of settings, then applied after upstream
// moved on. The bench prints the whole grid; this test keeps the claims the README makes
// from it, on a few shapes, so a change to synthesis that moves one shows here.

const profile = (label: string): (typeof PROFILES)[number][1] => {
  const found = PROFILES.find(([l]) => l === label);
  assert.ok(found, `no profile '${label}'`);
  return found[1];
};

const ready = new Set<string>();
async function run(language: string, label: string, shape: Partial<TuneShape> = {}): Promise<TuneCell> {
  if (!ready.has(language)) {
    await adapterForLanguage(language).init();
    ready.add(language);
  }
  return tuneOne(language, { units: 8, depth: 2, regime: 'repeat', at: 'middle', ...shape }, profile(label), 20_000);
}

const CODE = ['cpp', 'java', 'javascript', 'typescript', 'go', 'rust', 'kotlin', 'python', 'idl'];
const MARKUP = ['html', 'xml', 'json'];

test('tuning: a patch lands on the file it was made from, in every language and shape', async () => {
  for (const language of Object.keys(TUNE_SYNTAX)) {
    for (const depth of [1, 2, 3].filter((d) => d <= TUNE_SYNTAX[language]!.maxDepth)) {
      for (const regime of ['distinct', 'repeat', 'clone'] as const) {
        for (const at of ['middle', 'end'] as const) {
          const c = await run(language, 'default', { depth, regime, at });
          assert.equal(c.gen, 'ok', `${language} d${depth} ${regime} ${at}`);
          assert.equal(c.drifts.get('none'), 'ok', `${language} d${depth} ${regime} ${at}`);
        }
      }
    }
  }
});

// The landings in the wrong place the stand finds today, here on the three profiles that
// differ most, depth 1–2, to keep the suite fast; the bench runs all of them. All in
// docs/BACKLOG.md (Г3, 2026-10-21): a block that changed its place among its neighbours,
// in Python, where the line under the change stands in for the closer; the same in YAML,
// read as text, plus an anchor that matches the start of a longer line (Н8); and a new
// block wrapping a function whose last line the patch appends after — the pattern says
// "before the function's closer", and that is where it lands. A kind appearing, or one
// going away, changes this list on purpose.
test('tuning: the only wrong landings are the two known kinds', async () => {
  const wrong = new Set<string>();
  for (const language of Object.keys(TUNE_SYNTAX)) {
    for (const label of ['default', 'parents 1', 'min-parents 9']) {
      for (const depth of [1, 2].filter((d) => d <= TUNE_SYNTAX[language]!.maxDepth)) {
        for (const regime of ['repeat', 'clone'] as const) {
          for (const at of ['middle', 'end'] as const) {
            const c = await run(language, label, { depth, regime, at });
            for (const [drift, outcome] of c.drifts) {
              const kind = language === 'python' ? 'python' : language === 'yaml' ? 'yaml' : 'braces';
              if (outcome === 'WRONG') wrong.add(`${kind} ${drift} ${kind === 'braces' ? at : '*'}`);
            }
          }
        }
      }
    }
  }
  assert.deepEqual([...wrong].sort(), [
    'braces wrap end',
    // Python: the line that resumes the outer level stands for the closer — a block that
    // changes its place among its neighbours lands where that line now follows another
    'python move *',
    'python move-first *',
    'python next-new *',
    'python swap-next *',
    'python swap-prev *',
    // YAML, read as text: no block holds a pattern, and an anchor matches the start of a
    // longer line (07-findings Н8)
    'yaml move *',
    'yaml move-first *',
    'yaml near-args *',
    'yaml next-new *',
    'yaml swap-next *',
    'yaml swap-prev *',
  ]);
});

test('tuning: the README claims — what each setting buys and costs', async () => {
  for (const language of CODE) {
    // detail 0: a changed argument list keeps the patch; detail 1 spells it and refuses
    assert.equal((await run(language, 'default')).drifts.get('near-args'), 'ok', language);
    assert.equal((await run(language, 'sibling-detail 1')).drifts.get('near-args'), 'refused', language);
    assert.equal((await run(language, 'parent-detail 1')).drifts.get('header-args'), 'refused', language);
    // no siblings: a line added in the middle of a block cannot be placed
    assert.notEqual((await run(language, 'siblings 0')).gen, 'ok', language);
    // all parents: a copy of the function elsewhere is told apart; a rename of its
    // container is refused
    const all = await run(language, 'min-parents 9', { regime: 'clone' });
    assert.equal(all.drifts.get('dup-func'), 'ok', language);
    assert.equal(all.drifts.get('outer-rename'), 'refused', language);
  }
  for (const language of MARKUP) {
    // an attribute value, a key: spelled always, whatever the detail
    assert.equal((await run(language, 'default', { regime: 'distinct' })).drifts.get('near-rename'), 'refused', language);
  }
  for (const language of ['html', 'xml']) {
    assert.equal((await run(language, 'default')).drifts.get('near-args'), 'refused', language);
  }
  // one parent: enough while bodies differ, ambiguous once they repeat — except in
  // Python, where the line under the block makes it unique (and that is the defect)
  for (const language of ['cpp', 'java', 'go', 'rust', 'idl']) {
    assert.equal((await run(language, 'parents 1', { regime: 'distinct' })).gen, 'ok', language);
    assert.equal((await run(language, 'parents 1')).gen, 'ambiguous', language);
  }
  assert.equal((await run('python', 'parents 1')).gen, 'ok');
  // Python: every parent keeps a moved block from landing in its neighbour
  assert.equal((await run('python', 'default', { at: 'end' })).drifts.get('move'), 'WRONG');
  assert.equal((await run('python', 'min-parents 9', { at: 'end' })).drifts.get('move'), 'refused');
  // a condition without brackets is spelled: renaming it refuses in every profile
  for (const language of ['python', 'go', 'rust']) {
    assert.equal((await run(language, 'default', { depth: 3, regime: 'distinct' })).drifts.get('cond-rename'), 'refused', language);
  }
});
