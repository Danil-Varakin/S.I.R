import { test } from 'node:test';
import assert from 'node:assert/strict';

import { asker } from '../../src/cli/confirm.ts';

function fake(opts: { yes?: boolean; interactive?: boolean; answer?: string | null }) {
  const notes: string[] = [];
  const prompts: string[] = [];
  const ask = asker({
    yes: opts.yes ?? false,
    interactive: opts.interactive ?? true,
    note: (m) => notes.push(m),
    prompt: (text) => {
      prompts.push(text);
      return Promise.resolve(opts.answer === undefined ? '' : opts.answer);
    },
  });
  return { ask, notes, prompts };
}

test('asker: the warning is always shown, whoever ends up answering', async () => {
  for (const setup of [{ yes: true }, { interactive: true, answer: 'y' }, { interactive: false }]) {
    const { ask, notes } = fake(setup);
    await ask('commit X is not on branch main');
    assert.equal(notes[0], 'warning: commit X is not on branch main', JSON.stringify(setup));
  }
});

test('asker: y and yes go ahead, in any case and with stray spaces', async () => {
  for (const answer of ['y', 'Y', 'yes', 'YES', ' y ', 'yes\t']) {
    assert.equal(await fake({ answer }).ask('q'), true, JSON.stringify(answer));
  }
});

test('asker: everything else is no — the default of a question that loses work', async () => {
  for (const answer of ['', 'n', 'no', 'nope', 'yy', 'yes please', 'да']) {
    assert.equal(await fake({ answer }).ask('q'), false, JSON.stringify(answer));
  }
});

test('asker: --yes answers in advance, and says so rather than prompting', async () => {
  const { ask, notes, prompts } = fake({ yes: true, interactive: true });
  assert.equal(await ask('q'), true);
  assert.deepEqual(prompts, []);
  assert.match(notes.join('\n'), /--yes: going ahead/);
});

test('asker: with nobody at a terminal the answer is no, and the way round is named', async () => {
  const { ask, notes, prompts } = fake({ interactive: false });
  assert.equal(await ask('q'), false);
  assert.deepEqual(prompts, [], 'a pipe is never prompted');
  assert.match(notes.join('\n'), /nobody can answer: stopping \(pass --yes to go ahead\)/);
});

test('asker: the prompt says what the default is', async () => {
  const { ask, prompts } = fake({ answer: '' });
  await ask('q');
  assert.equal(prompts[0], '  go ahead? [y/N] ');
});

test('asker: an input that closed before an answer is no — nothing is lost by default', async () => {
  const { ask, prompts } = fake({ interactive: true, answer: null });
  assert.equal(await ask('q'), false);
  assert.equal(prompts.length, 1);
});
