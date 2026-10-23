import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSirFile } from '../../src/core/sir-parser.ts';
import { resolveHunks } from '../../src/core/resolve.ts';
import { cppAdapter } from '../../src/lang/cpp/index.ts';
import { sirMd } from '../helpers.ts';

const BASE = ['namespace f {', 'void a() {', '  one();', '}', '}', ''].join('\n');

async function resolve(md: string, baseline = BASE) {
  await cppAdapter.init();
  return resolveHunks(baseline, parseSirFile(md), cppAdapter);
}

test('resolve: an insertion is empty in the baseline and carries the text in the result', async () => {
  const md = sirMd([{ match: '... one(); >>> ...', patch: 'two();' }]);
  const { links, applied } = await resolve(md);

  const link = links[0]!;
  assert.equal(link.status, 'ok');
  assert.equal(link.base!.start, link.base!.end, 'an insertion replaces nothing');
  assert.equal(BASE.slice(0, link.base!.start).endsWith('one();'), true);
  assert.equal(link.finalText, 'two();');
  assert.equal(applied.slice(link.final!.start, link.final!.end), 'two();');
  assert.equal(link.dependsOnEarlier, false);
});

test('resolve: a replacement spans exactly the text it replaces in the baseline', async () => {
  const md = sirMd([{ match: '... >>> one(); <<< ...', patch: 'two();' }]);
  const { links } = await resolve(md);

  const link = links[0]!;
  assert.equal(link.status, 'ok');
  assert.equal(BASE.slice(link.base!.start, link.base!.end), 'one();');
  assert.equal(link.finalText, 'two();');
});

test('resolve: the mdSpan of a hunk points at its own lines in the .md', async () => {
  const md = sirMd([
    { match: '... one(); >>> ...', patch: 'two();' },
    { match: '... two(); >>> ...', patch: 'three();' },
  ]);
  const { links } = await resolve(md);
  const lines = md.split('\n');

  for (const link of links) {
    const [from, to] = link.mdSpan!;
    assert.equal(lines[from - 1], '# match cpp');
    assert.equal(lines[to - 1], '# end');
  }
  assert.ok(links[0]!.mdSpan![1] < links[1]!.mdSpan![0], 'the spans do not overlap');
});

test('resolve: a hunk leaning on an earlier insertion is marked dependsOnEarlier', async () => {
  const md = sirMd([
    { match: '... one(); >>> ...', patch: 'two();' },
    { match: '... two(); >>> ...', patch: 'three();' },
  ]);
  const { links, applied } = await resolve(md);

  assert.equal(links[0]!.dependsOnEarlier, false);
  assert.equal(links[1]!.status, 'ok', 'it resolves against the replayed text');
  assert.equal(links[1]!.dependsOnEarlier, true, 'its anchor is absent from the pristine baseline');
  assert.equal(links[1]!.finalText, 'three();');
  assert.ok(applied.indexOf('two();') < applied.indexOf('three();'), applied);
});

test('resolve: an earlier hunk shifts final, while base stays in baseline coordinates', async () => {
  const md = sirMd([
    { match: '... namespace f { >>> ...', patch: '\nint counter;' },
    { match: '... >>> one(); <<< ...', patch: 'two();' },
  ]);
  const { links, applied } = await resolve(md);

  const second = links[1]!;
  assert.equal(BASE.slice(second.base!.start, second.base!.end), 'one();', 'in baseline coordinates');
  assert.equal(applied.slice(second.final!.start, second.final!.end), 'two();', 'in the coordinates of the result');
  assert.equal(
    second.final!.start - second.base!.start,
    '\nint counter;'.length,
    'by exactly what the first hunk wrote',
  );
});

test('resolve: one hunk failing does not cancel the others', async () => {
  const md = sirMd([
    { match: '... one(); >>> ...', patch: 'two();' },
    { match: '... nosuchcall(); >>> ...', patch: 'three();' },
  ]);
  const { links, applied } = await resolve(md);

  assert.equal(links[0]!.status, 'ok');
  assert.equal(links[1]!.status, 'no-match');
  assert.equal(links[1]!.failure!.kind, 'MatchError');
  assert.equal(links[1]!.base, undefined, 'a hunk that did not fit has no coordinates');
  assert.ok(applied.includes('two();'), 'the first hunk is applied all the same');
  assert.ok(!applied.includes('three();'));
});

test('resolve: the mdLine of a failure points at the anchor that did not fit', async () => {
  const md = sirMd([{ match: ['...', 'one();', '...', 'nosuchcall();', '>>>', '...'].join('\n'), patch: 'X();' }]);
  const { links } = await resolve(md);

  const failure = links[0]!.failure!;
  assert.equal(failure.failedStepIndex, 1, 'the first anchor fitted, the second did not');
  const line = md.split('\n')[failure.mdLine! - 1]!;
  assert.equal(line.trim(), 'nosuchcall();');
});

test('resolve: an ambiguous pattern reports the status and every candidate place', async () => {
  const baseline = ['void a() { one(); }', 'void b() { one(); }', ''].join('\n');
  const md = sirMd([{ match: '... one(); >>> ...', patch: 'X();' }]);
  const { links } = await resolve(md, baseline);

  const link = links[0]!;
  assert.equal(link.status, 'ambiguous');
  assert.equal(link.failure!.kind, 'AmbiguityError');
  assert.ok(link.failure!.candidates!.length >= 2, 'there are at least two candidates');
  for (const pos of link.failure!.candidates!) {
    assert.ok(pos >= 0 && pos <= baseline.length, `candidate ${pos} falls outside the baseline`);
  }
});

const TWO = 'void a() { one(); }\nvoid b() { six(); }\n';

type Seen = [status: string, base: string | undefined, finalText: string | undefined, dependsOnEarlier: boolean];

async function seen(hunks: { match: string; patch: string }[], baseline = TWO): Promise<{ links: Seen[]; applied: string }> {
  const { links, applied } = await resolve(sirMd(hunks), baseline);
  for (const l of links) {
    if (l.final !== undefined) assert.equal(applied.slice(l.final.start, l.final.end), l.finalText, 'finalText is the text at final');
  }
  return {
    applied,
    links: links.map((l) => [l.status, l.base && baseline.slice(l.base.start, l.base.end), l.finalText, l.dependsOnEarlier]),
  };
}

test('resolve: a later hunk earlier in the file moves final of the first, not its base', async () => {
  const md = sirMd([
    { match: '... six(); >>> ...', patch: ' seven();' },
    { match: '... >>> one(); <<< ...', patch: 'zero(); one();' },
  ]);
  const { links, applied } = await resolve(md, TWO);
  assert.equal(applied, 'void a() { zero(); one(); }\nvoid b() { six(); seven(); }\n');
  assert.deepEqual(links[0]!.base, { start: 37, end: 37 }, 'right after six(); in the base');
  assert.deepEqual(links[0]!.final, { start: 45, end: 54 }, 'moved by the 8 characters the second hunk added');
  assert.equal(links[0]!.finalText, ' seven();');
  assert.deepEqual(links[1]!.base, { start: 11, end: 17 });
  assert.deepEqual(links[1]!.final, { start: 11, end: 25 });
});

test('resolve: a hunk after a failed one is placed as if the failed one were not there', async () => {
  const { links } = await seen([
    { match: '... nosuch(); >>> ...', patch: 'X();' },
    { match: '... >>> one(); <<< ...', patch: 'two();' },
  ]);
  assert.deepEqual(links, [
    ['no-match', undefined, undefined, false],
    ['ok', 'one();', 'two();', false],
  ]);
});

test('resolve: hunks on both sides of a failed one keep their own coordinates', async () => {
  const md = sirMd([
    { match: '... >>> one(); <<< ...', patch: 'uno();;' },
    { match: '... nosuch(); >>> ...', patch: 'X();' },
    { match: '... >>> six(); <<< ...', patch: 'seis();' },
  ]);
  const { links } = await resolve(md, TWO);
  assert.deepEqual(links[0]!.final, { start: 11, end: 18 });
  assert.deepEqual(links[2]!.base, { start: 31, end: 37 }, 'base of the third: back through the first only');
  assert.deepEqual(links[2]!.final, { start: 32, end: 39 }, 'the first wrote one character more than it replaced');
  assert.equal(links[1]!.dependsOnEarlier, false, 'a failed hunk depends on nothing');
});

test('resolve: a hunk right after what an earlier one replaced is based at the end of the replaced text', async () => {
  const md = sirMd([
    { match: '... >>> one(); <<< ...', patch: 'uno();;' },
    { match: '... uno();; >>> ...', patch: ' dos();' },
  ]);
  const { links } = await resolve(md, TWO);
  assert.equal(links[1]!.dependsOnEarlier, true);
  assert.deepEqual(links[1]!.base, { start: 17, end: 17 }, 'the end of one(); — where the first hunk wrote');
  assert.deepEqual(links[1]!.final, { start: 18, end: 25 });
});

test('resolve: a hunk inside what an earlier one wrote is based where the earlier one writes', async () => {
  const md = sirMd([
    { match: '... one(); >>> ...', patch: ' two();' },
    { match: '... two( >>> ); ...', patch: 'x' },
  ]);
  const { links, applied } = await resolve(md, TWO);
  assert.equal(applied, 'void a() { one(); two(x); }\nvoid b() { six(); }\n');
  assert.deepEqual(links[1]!.base, { start: 17, end: 17 }, 'the base has no place inside the text of the first');
  assert.equal(links[1]!.finalText, 'x');
  assert.equal(links[0]!.finalText, ' two(x);', 'what the first wrote still stands around it');
});

test('resolve: a later insertion at the start of what a hunk wrote stays out of its final', async () => {
  const { links, applied } = await seen([
    { match: '... one(); >>> ...', patch: ' two();' },
    { match: '... one(); >>> two(); ...', patch: ' Y();' },
  ]);
  assert.equal(applied, 'void a() { one(); Y(); two(); }\nvoid b() { six(); }\n');
  assert.deepEqual(links, [
    ['ok', '', ' two();', false],
    ['ok', '', ' Y();', true],
  ]);
});

test('resolve: a later insertion at the end of what a hunk wrote stays out of its final', async () => {
  const { links } = await seen([
    { match: '... one(); >>> ...', patch: ' two();' },
    { match: '... two(); >>> ...', patch: ' Y();' },
  ]);
  assert.deepEqual(links, [
    ['ok', '', ' two();', false],
    ['ok', '', ' Y();', true],
  ]);
});

test('resolve: a later replacement over the start of what a hunk wrote leaves it the rest', async () => {
  const { links, applied } = await seen([
    { match: '... one(); >>> ...', patch: ' two();' },
    { match: '... >>> one(); two( <<< ); ...', patch: 'zero(' },
  ]);
  assert.equal(applied, 'void a() { zero(); }\nvoid b() { six(); }\n');
  assert.deepEqual(links, [
    ['ok', '', ');', false],
    ['ok', 'one();', 'zero(', true],
  ]);
});

test('resolve: a later replacement over the end of what a hunk wrote leaves it the start', async () => {
  const { links, applied } = await seen([
    { match: '... one(); >>> ...', patch: ' two();' },
    { match: '... two >>> (); } <<< ...', patch: '!' },
  ]);
  assert.equal(applied, 'void a() { one(); two!\nvoid b() { six(); }\n');
  assert.deepEqual(links[0], ['ok', '', ' two', false]);
});

test('resolve: what a later hunk replaces whole leaves the earlier one an empty final where it stood', async () => {
  const { links, applied } = await resolve(
    sirMd([
      { match: '... one(); >>> ...', patch: ' two();' },
      { match: '... a() { >>> one(); two(); <<< } ...', patch: ' three();' },
    ]),
    TWO,
  );
  assert.equal(applied, 'void a() { three(); }\nvoid b() { six(); }\n');
  assert.deepEqual(links[0]!.final, { start: 10, end: 10 }, 'before the text that took its place');
  assert.equal(links[0]!.finalText, '');
  assert.equal(links[1]!.finalText, ' three();');
});

test('resolve: an error of another kind is status error with the class as kind, the rest go on', async () => {
  await cppAdapter.init();
  const boom = { ...cppAdapter, normalize: (raw: string) => (raw.includes('boom') ? raise() : cppAdapter.normalize(raw)) };
  function raise(): never {
    throw new RangeError('the normalizer gave up');
  }
  const md = sirMd([
    { match: '... boom(); >>> ...', patch: 'X();' },
    { match: '... one(); >>> ...', patch: ' two();' },
  ]);
  const { links } = resolveHunks(BASE, parseSirFile(md), boom);
  assert.equal(links[0]!.status, 'error');
  assert.deepEqual(links[0]!.failure, { kind: 'RangeError', message: 'the normalizer gave up' });
  assert.equal(links[0]!.dependsOnEarlier, false);
  assert.equal(links[0]!.base, undefined);
  assert.equal(links[1]!.status, 'ok');
});

test('resolve: a thrown value that is no Error is status error, kind Error, its text as the message', async () => {
  await cppAdapter.init();
  const odd = { ...cppAdapter, normalize: (raw: string) => { if (raw.includes('odd')) throw 'not an Error'; return cppAdapter.normalize(raw); } };
  const { links } = resolveHunks(BASE, parseSirFile(sirMd([{ match: '... odd(); >>> ...', patch: 'X();' }])), odd);
  assert.equal(links[0]!.status, 'error');
  assert.deepEqual(links[0]!.failure, { kind: 'Error', message: 'not an Error' });
});

test('resolve: a no-match carries the step, the steps, how far it got and the anchor', async () => {
  const md = sirMd([{ match: ['...', 'one();', '...', 'nosuchcall();', '>>>', '...'].join('\n'), patch: 'X();' }]);
  const { links } = await resolve(md);
  const { mdLine, ...rest } = links[0]!.failure!;
  assert.deepEqual(rest, {
    kind: 'MatchError',
    message: 'no match: the pattern did not fit the file',
    failedStepIndex: 1,
    totalSteps: 3,
    origPos: BASE.indexOf('one();') + 'one();\n'.length,
    anchorText: 'nosuchcall();',
  });
  assert.equal(md.split('\n')[mdLine! - 1]!.trim(), 'nosuchcall();');
});

test('resolve: a pattern that runs out before the file does has no anchor line to underline', async () => {
  const { links } = await resolve(sirMd([{ match: '... one(); >>>', patch: 'X();' }]));
  const failure = links[0]!.failure!;
  assert.equal(failure.kind, 'MatchError');
  assert.equal(failure.failedStepIndex, failure.totalSteps, 'it failed past its last step');
  assert.equal('mdLine' in failure, false);
  assert.equal('anchorText' in failure, false);
});

test('resolve: an ambiguity carries exactly the candidate places', async () => {
  const baseline = 'void a() { one(); }\nvoid b() { one(); }\n';
  const { links } = await resolve(sirMd([{ match: '... one(); >>> ...', patch: 'X();' }]), baseline);
  assert.deepEqual(links[0]!.failure, {
    kind: 'AmbiguityError',
    message: 'ambiguous match: the pattern fits in more than one place — add context',
    candidates: [17, 37],
  });
  assert.equal(links[0]!.dependsOnEarlier, false);
});

test('resolve: a hunk right after text an earlier one deleted is based on its own text only', async () => {
  const baseline = 'int x = f(one(),two());\n';
  const { links } = await seen(
    [
      { match: '... f( >>> one(), <<< ...', patch: '' },
      { match: '... >>> two() <<< ...', patch: 'three()' },
    ],
    baseline,
  );
  assert.deepEqual(links, [
    ['ok', 'one(),', '', false],
    ['ok', 'two()', 'three()', false],
  ]);
});

test('resolve: an insertion where an earlier hunk deleted is based where the deletion began', async () => {
  const baseline = 'int x = f(one(),two());\n';
  const { links } = await resolve(
    sirMd([
      { match: '... f( >>> one(), <<< ...', patch: '' },
      { match: '... f( >>> two() ...', patch: 'z,' },
    ]),
    baseline,
  );
  assert.equal(links[1]!.dependsOnEarlier, true);
  assert.deepEqual(links[1]!.base, { start: 10, end: 10 });
  assert.equal(links[1]!.finalText, 'z,');
});
