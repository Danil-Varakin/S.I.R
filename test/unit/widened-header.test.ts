import { test } from 'node:test';
import assert from 'node:assert/strict';

import { patchOf } from '../matrix.ts';
import { applyAll } from '../../src/core/apply.ts';
import { adapterForLanguage } from '../../src/lang/adapter.ts';

// 07-findings Н4: an insertion at the end of a block whose header is not unique widens
// the header with the block's body, from the top down to the change — every line of it.
// A line upstream adds anywhere in that body refuses the patch, where the one neighbour
// above the change would have told the places apart and let it land. Runs as `todo`
// until the author decides; never lands elsewhere — that much holds now.

const CASES: [string, string, string, string][] = [
  [
    'cpp',
    'void Box() {\n  A1();\n  A2();\n  A3();\n  MinHeight();\n}\n\nnamespace dark {\nvoid Box() {\n  Border();\n}\n}\n',
    '  MinHeight();\n',
    '  Padding();\n',
  ],
  [
    'css',
    '.box {\n  align-items: center;\n  display: flex;\n  min-height: 48px;\n}\n\n@media (dark) {\n  .box {\n    border: 0;\n  }\n}\n',
    '  min-height: 48px;\n',
    '  padding: 0;\n',
  ],
];

for (const [language, oldText, after, added] of CASES) {
  test(`Н4 ${language}: upstream adds a line to the body above the change — the patch still lands`, { todo: '07-findings Н4' }, async () => {
    const adapter = adapterForLanguage(language);
    await adapter.init();
    const insert = (t: string): string => t.replace(after, after + added);
    const patch = patchOf(oldText, insert(oldText), adapter);
    // upstream: one more line at the top of the same body
    const lines = oldText.split('\n');
    const drift = (t: string): string => {
      const l = t.split('\n');
      l.splice(1, 0, lines[1]!.replace(/\w+/, 'Upstream'));
      return l.join('\n');
    };
    assert.equal(applyAll(drift(oldText), patch, adapter).source, drift(insert(oldText)));
  });
}
