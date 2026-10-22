import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSirFile } from '../../../src/core/sir-parser.ts';
import { pythonAdapter } from '../../../src/lang/python/index.ts';
import { adapterForLanguage } from '../../../src/lang/adapter.ts';
import { applyAll } from '../../../src/core/apply.ts';
import { sirMd } from '../../helpers.ts';

const SRC = `def first(x):
    if x:
        log("a")
    return x

def second(x):
    if x:
        log("b")
    return x
`;

test('a heading with a level anchor pins the edit INSIDE the wanted function', async () => {
  await pythonAdapter.init();
  const file = parseSirFile(
    sirMd(
      [{ match: '...\ndef second(x):\n...\n        log("b")\n>>>\n...', patch: '\n    log("c")' }],
      'python',
    ),
  );
  const { source, edits } = applyAll(SRC, file, pythonAdapter);
  assert.equal(edits.length, 1);
  assert.match(source, /def second\(x\):\n {4}if x:\n {8}log\("b"\)\n {4}log\("c"\)\n {4}return x/);
  assert.match(source, /def first\(x\):\n {4}if x:\n {8}log\("a"\)\n {4}return x/);
});

test('the level is held by the multiline literal: `\\n` + indentation is text of the canon', async () => {
  await pythonAdapter.init();
  const wrong = parseSirFile(
    sirMd(
      [{ match: '...\n        log("b")\n        return x\n>>>\n...', patch: '\nX' }],
      'python',
    ),
  );
  assert.throws(() => applyAll(SRC, wrong, pythonAdapter), /no match/);

  const right = parseSirFile(
    sirMd([{ match: '...\n        log("b")\n    return x\n>>>\n...', patch: '\nX' }], 'python'),
  );
  assert.equal(applyAll(SRC, right, pythonAdapter).edits.length, 1);
});

test('an edit inside a body without a level anchor is AMBIGUOUS (two identical functions)', async () => {
  await pythonAdapter.init();
  const file = parseSirFile(
    sirMd([{ match: '...\n    if x:\n>>>\n...', patch: '        log("c")' }], 'python'),
  );
  assert.throws(() => applyAll(SRC, file, pythonAdapter), /ambiguous/);
});

test('replacing a range: `>>> … <<<` throws away the old body of the branch', async () => {
  await pythonAdapter.init();
  const file = parseSirFile(
    sirMd(
      [{ match: '...\ndef first(x):\n...\n>>>\n        log("a")\n<<<\n...', patch: '        log("z")' }],
      'python',
    ),
  );
  const { source } = applyAll(SRC, file, pythonAdapter);
  assert.ok(source.includes('log("z")'), source);
  assert.ok(!source.includes('log("a")'), source);
  assert.ok(source.includes('log("b")'), source);
});

test('the language of the heading is enough: the adapter is chosen without a file name', () => {
  const file = parseSirFile(sirMd([{ match: '... x >>> ...', patch: 'y' }], 'python'));
  assert.equal(file.language, 'python');
  assert.equal(adapterForLanguage(file.language), pythonAdapter);
});
