import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PROFILES, tuneOne } from '../../bench/run.ts';
import type { TuneCell } from '../../bench/run.ts';
import { TUNE_SYNTAX } from '../../bench/corpus.ts';
import type { TuneShape } from '../../bench/corpus.ts';
import { adapterForLanguage } from '../../src/lang/adapter.ts';

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
    'python move *',
    'python move-first *',
    'python next-new *',
    'python swap-next *',
    'python swap-prev *',
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
    assert.equal((await run(language, 'default')).drifts.get('near-args'), 'ok', language);
    assert.equal((await run(language, 'sibling-detail 1')).drifts.get('near-args'), 'refused', language);
    assert.equal((await run(language, 'parent-detail 1')).drifts.get('header-args'), 'refused', language);
    assert.notEqual((await run(language, 'siblings 0')).gen, 'ok', language);
    const all = await run(language, 'min-parents 9', { regime: 'clone' });
    assert.equal(all.drifts.get('dup-func'), 'ok', language);
    assert.equal(all.drifts.get('outer-rename'), 'refused', language);
  }
  for (const language of MARKUP) {
    assert.equal((await run(language, 'default', { regime: 'distinct' })).drifts.get('near-rename'), 'refused', language);
  }
  for (const language of ['html', 'xml']) {
    assert.equal((await run(language, 'default')).drifts.get('near-args'), 'refused', language);
  }
  for (const language of ['cpp', 'java', 'go', 'rust', 'idl']) {
    assert.equal((await run(language, 'parents 1', { regime: 'distinct' })).gen, 'ok', language);
    assert.equal((await run(language, 'parents 1')).gen, 'ambiguous', language);
  }
  assert.equal((await run('python', 'parents 1')).gen, 'ok');
  assert.equal((await run('python', 'default', { at: 'end' })).drifts.get('move'), 'WRONG');
  assert.equal((await run('python', 'min-parents 9', { at: 'end' })).drifts.get('move'), 'refused');
  for (const language of ['python', 'go', 'rust']) {
    assert.equal((await run(language, 'default', { depth: 3, regime: 'distinct' })).drifts.get('cond-rename'), 'refused', language);
  }
});
