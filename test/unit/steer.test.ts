import { test } from 'node:test';
import assert from 'node:assert/strict';

import { steerSynthesis, unattended } from '../../src/generate/steer.ts';
import type { SteerRequest } from '../../src/generate/steer.ts';
import type { SynthEvent } from '../../src/generate/synth.ts';
import { InputClosed } from '../../src/infra/ask.ts';
import { MatchError } from '../../src/core/errors.ts';
import type { Steering, Verdict } from '../../src/generate/steer.ts';
import { synthesize } from '../../src/generate/synth.ts';
import { printSirFile } from '../../src/generate/printer.ts';
import { parseSirFile } from '../../src/core/sir-parser.ts';
import { resolveHunks } from '../../src/core/resolve.ts';
import { SynthesisError } from '../../src/core/errors.ts';
import { cppAdapter } from '../../src/lang/cpp/index.ts';

interface Script {
  readonly verdicts?: Verdict[];
  readonly offers?: boolean[];
  readonly edits?: ((shown: string) => string)[];
}

function person(script: Script): { steering: Steering; asked: string[]; shown: string[] } {
  const verdicts = [...(script.verdicts ?? [])];
  const offers = [...(script.offers ?? [])];
  const edits = [...(script.edits ?? [])];
  const asked: string[] = [];
  const shown: string[] = [];
  const steering: Steering = {
    ...(script.verdicts !== undefined ? { review: () => Promise.resolve(verdicts.shift() ?? 'keep') } : {}),
    offerEdit: (why) => (asked.push(why), Promise.resolve(offers.shift() ?? false)),
    edit: (text) => {
      shown.push(text);
      const next = edits.shift();
      return Promise.resolve(next === undefined ? text : next(text));
    },
  };
  return { steering, asked, shown };
}

async function steer(oldText: string, newText: string, script: Script) {
  await cppAdapter.init();
  const who = person(script);
  const run = steerSynthesis({ oldText, newText, adapter: cppAdapter, label: 'cpp', bridgeGap: 0, exact: false }, who.steering);
  return { run, ...who };
}

function applied(oldText: string, hunks: readonly unknown[]): string {
  const file = parseSirFile(printSirFile(hunks as never, 'cpp'));
  const { links, applied: text } = resolveHunks(oldText, file, cppAdapter);
  assert.ok(links.every((l) => l.status === 'ok'), JSON.stringify(links.map((l) => l.status)));
  return text;
}

const OLD = 'void f() {\n  a();\n}\n\nvoid g() {\n  b();\n}\n';
const NEW = 'void f() {\n  a2();\n}\n\nvoid g() {\n  b2();\n}\n';

test('steer: nobody objecting, the hunks give the new version, as synthesize does', async () => {
  const { run } = await steer(OLD, NEW, {});
  const result = await run;
  assert.equal(result.reproducesNew, true);
  assert.equal(applied(OLD, result.hunks), NEW);
  assert.equal(result.hunks.length, synthesize(OLD, NEW, cppAdapter).length);
});

test('steer: a change left out is not in the .md, and the next hunks are built without it', async () => {
  const old = 'void f() {\n  step();\n  step();\n  step();\n}\n';
  const neu = 'void f() {\n  step(5);\n  step();\n  step();\n  done();\n}\n';
  const { run } = await steer(old, neu, { verdicts: ['skip', 'keep'] });
  const result = await run;
  assert.equal(result.reproducesNew, false);
  const text = applied(old, result.hunks);
  assert.ok(!text.includes('step(5)'), 'the change left out is not there');
  assert.ok(text.includes('done();'), 'the change after it is');
});

test('steer: a declined hunk goes to the editor; what comes back — patch body too — is the new state', async () => {
  const { run, asked, shown } = await steer(OLD, NEW, {
    verdicts: ['decline', 'keep'],
    offers: [true],
    edits: [(text) => text.replace('    a2();', '    a3();')],
  });
  const result = await run;
  assert.match(asked[0]!, /hunk 1: declined/);
  assert.match(shown[0]!, /hunk 1: declined/);
  assert.match(shown[0]!, /^  - {3}a\(\);$/m, 'the change is quoted above the hunks');
  assert.equal(applied(OLD, result.hunks), NEW.replace('a2();', 'a3();'), 'the edited body stays; g() still gets its hunk');
  assert.equal(result.reproducesNew, false);
});

test('steer: a # note written in the editor stays with its hunk — in the hunks and in the printed patch', async () => {
  const { run } = await steer(OLD, NEW, {
    verdicts: ['decline', 'keep'],
    offers: [true],
    edits: [(text) => text.replace(/^# match cpp$/m, '# note\nwhy a2: the old name is gone upstream\n# end\n# match cpp')],
  });
  const result = await run;
  assert.equal(result.hunks[0]!.note?.text, 'why a2: the old name is gone upstream');
  const printed = printSirFile(result.hunks, 'cpp');
  assert.match(printed, /^# note\nwhy a2: the old name is gone upstream\n# end\n# match cpp$/m);
  assert.equal(parseSirFile(printed).hunks[0]!.note?.text, 'why a2: the old name is gone upstream');
  assert.equal(applied(OLD, result.hunks), NEW);
});

test('steer: declined and no editor wanted — the run stops, nothing is written', async () => {
  const { run } = await steer(OLD, NEW, { verdicts: ['decline'], offers: [false] });
  await assert.rejects(run, /hunk 1: declined — nothing was written/);
});

test('steer: an edit that does not stand is shown with its reason, and edited again', async () => {
  const { run, asked, shown } = await steer(OLD, NEW, {
    verdicts: ['decline', 'keep'],
    offers: [true, true],
    edits: [
      (text) => text.replace('# end', 'end'),
      (text) => text.replace(/^end$/m, '# end').replace('    a2();', '    a3();'),
    ],
  });
  const result = await run;
  assert.match(asked[1]!, /the edited patch does not parse/);
  assert.match(shown[1]!, /the edited patch does not parse/, 'the reason is on top of the next edit');
  assert.ok(!shown[1]!.includes('hunk 1: declined'), 'the old reason is replaced');
  assert.equal(applied(OLD, result.hunks), NEW.replace('a2();', 'a3();'));
});

test('steer: an edit that does not land names the hunk and the line', async () => {
  const { run, asked } = await steer(OLD, NEW, {
    verdicts: ['decline'],
    offers: [true, false],
    edits: [(text) => text.replace('void f() {', 'void nope() {')],
  });
  await assert.rejects(run, /hunk 1 \(line \d+\) does not land/);
  assert.match(asked[1]!, /hunk 1 \(line \d+\) does not land/);
});

const TWIN_OLD =
  'void f() {\n  if (cond) {\n    a();\n    work();\n  }\n  if (cond) {\n    a();\n    work();\n  }\n}\n';
const TWIN_NEW = TWIN_OLD.replace(/work\(\);(?![\s\S]*work\(\);)/, 'work(2);');
const BY_HAND = [
  '# match cpp',
  '    ...',
  '    if (cond) {',
  '    ...',
  '    }',
  '    ...',
  '    if (cond) {',
  '    ...',
  '    >>>',
  '    work();',
  '    <<<',
  '    ...',
  '# end',
  '# patch',
  '    work(2);',
  '# end',
  '',
].join('\n');

test('steer: a change synthesis cannot anchor is offered to the editor, and a hand hunk takes its place', async () => {
  await cppAdapter.init();
  assert.throws(() => synthesize(TWIN_OLD, TWIN_NEW, cppAdapter), (e) => e instanceof SynthesisError);
  const { run, asked, shown } = await steer(TWIN_OLD, TWIN_NEW, { offers: [true], edits: [() => BY_HAND] });
  const result = await run;
  assert.match(asked[0]!, /hunk 1: the change at line \d+ could not be anchored/);
  assert.match(shown[0]!, /could not be anchored/);
  assert.match(shown[0]!, /^# match cpp$/m, 'a hunk to start from is there');
  assert.equal(result.reproducesNew, true);
  assert.equal(applied(TWIN_OLD, result.hunks), TWIN_NEW);
});

test('steer: the editor shows EVERY hunk so far, not only the one that failed', async () => {
  const old = `void head() {\n  x();\n}\n\n${TWIN_OLD}`;
  const neu = `void head() {\n  x2();\n}\n\n${TWIN_NEW}`;
  const { run, shown } = await steer(old, neu, { offers: [true], edits: [(t) => t.replace(/# match cpp[\s\S]*$/, (all) => all.slice(0, all.lastIndexOf('# match cpp')) + BY_HAND)] });
  const result = await run;
  assert.equal((shown[0]!.match(/^# match cpp$/gm) ?? []).length, 2, 'the hunk for head() and the one to write');
  assert.equal(applied(old, result.hunks), neu);
});

test('steer: a change that cannot be anchored, and no editor wanted — the synthesis error itself', async () => {
  const { run } = await steer(TWIN_OLD, TWIN_NEW, { offers: [false] });
  await assert.rejects(run, (e) => e instanceof SynthesisError);
});

async function steerWith(request: Partial<SteerRequest> & { oldText: string; newText: string }, steering: Steering) {
  await cppAdapter.init();
  return steerSynthesis({ adapter: cppAdapter, label: 'cpp', bridgeGap: 0, exact: false, ...request }, steering);
}

test('steer: review is asked about each hunk with its number and the count so far plus what is left', async () => {
  const asked: [number, number][] = [];
  const steering: Steering = {
    review: (_hunk, number, total) => (asked.push([number, total]), Promise.resolve('keep')),
    offerEdit: () => Promise.resolve(false),
    edit: (t) => Promise.resolve(t),
  };
  await steerWith({ oldText: OLD, newText: NEW }, steering);
  assert.deepEqual(asked, [[1, 2], [2, 2]]);
});

test('steer: a skipped change does not count — the next hunk is number 1 of 1', async () => {
  const asked: [number, number][] = [];
  const verdicts: Verdict[] = ['skip', 'keep'];
  const steering: Steering = {
    review: (_hunk, number, total) => (asked.push([number, total]), Promise.resolve(verdicts.shift()!)),
    offerEdit: () => Promise.resolve(false),
    edit: (t) => Promise.resolve(t),
  };
  await steerWith({ oldText: OLD, newText: NEW }, steering);
  assert.deepEqual(asked, [[1, 2], [1, 1]]);
});

test('steer: the tracer hears every change as a segment, numbered from the hunks so far', async () => {
  const events: SynthEvent[] = [];
  await steerWith({ oldText: OLD, newText: NEW, trace: (e) => events.push(e) }, unattended);
  const segments = events.flatMap((e) => (e.kind === 'segment' ? [[e.index, e.total]] : []));
  assert.deepEqual(segments, [[0, 2], [1, 2]]);
  assert.ok(events.some((e) => e.kind === 'hunk'), 'synthesis is traced through as well');
});

test('steer: the limits are passed on to synthesis', async () => {
  const plain = await steerWith({ oldText: OLD, newText: NEW }, unattended);
  const bare = await steerWith({ oldText: OLD, newText: NEW, limits: { maxParents: 0, minParents: 0 } }, unattended);
  assert.match(printSirFile(plain.hunks, 'cpp'), /void f\(\)/);
  assert.doesNotMatch(printSirFile(bare.hunks, 'cpp'), /void f\(\)/);
  assert.equal(
    printSirFile(bare.hunks, 'cpp'),
    printSirFile(synthesize(OLD, NEW, cppAdapter, { limits: { maxParents: 0, minParents: 0 } }), 'cpp'),
  );
});

test('steer: reproducesNew is held to the comparison asked for — byte for byte with exact', async () => {
  const oldText = 'void f() {\r\n  a();\r\n}\r\n';
  const newText = 'void f() {\r\n  a2();\n}\r\n';
  assert.equal((await steerWith({ oldText, newText }, unattended)).reproducesNew, true);
  assert.equal((await steerWith({ oldText, newText, exact: true }, unattended)).reproducesNew, false);
  assert.equal((await steerWith({ oldText: OLD, newText: NEW, exact: true }, unattended)).reproducesNew, true, 'and true when it is met');
});

test('steer: unattended has no editor to open', () => {
  assert.throws(() => unattended.edit('x'), /unattended synthesis has no editor/);
});

test('steer: the input closing before a hunk is answered stops the run and says how to answer', async () => {
  const steering: Steering = {
    review: () => Promise.reject(new InputClosed()),
    offerEdit: () => Promise.resolve(false),
    edit: (t) => Promise.resolve(t),
  };
  await assert.rejects(
    steerWith({ oldText: OLD, newText: NEW }, steering),
    (e) =>
      e instanceof Error &&
      e.message ===
        '-a: the input closed at hunk 1 of 2, before it was answered — nothing was written\n' +
          '  answer every hunk (one line each, Enter keeps it), or drop -a',
  );
});

test('steer: another error from review is passed through as it is', async () => {
  const boom = new Error('review broke');
  const steering: Steering = { review: () => Promise.reject(boom), offerEdit: () => Promise.resolve(false), edit: (t) => Promise.resolve(t) };
  await assert.rejects(steerWith({ oldText: OLD, newText: NEW }, steering), (e) => e === boom);
});

test('steer: the editor opens on a note — what to do, the reason, the change quoted — then a rule and the hunks', async () => {
  const { run, shown } = await steer(OLD, NEW, { verdicts: ['decline', 'keep'], offers: [true] });
  await run;
  const [note, hunks] = shown[0]!.split(`${'-'.repeat(80)}\n`);
  assert.equal(
    note,
    'Sir — edit the hunks below, then save and close the editor. The hunks are applied\n' +
      'in order to the OLD version, and everything above the first "# match" is ignored.\n' +
      '\n' +
      '  hunk 1: declined\n' +
      '\n' +
      'The change this is about (line 2 of the text so far):\n' +
      '  -   a();\n' +
      '  +   a2();\n' +
      '\n',
  );
  assert.ok(hunks!.startsWith('# match cpp\n'), hunks!);
});

const KEEP_A = '# match cpp\n    ...\n    void f() {\n    ...\n    >>>\n      a();\n    <<<\n    ...\n# end\n# patch\n    a2();\n# end\n';

test('steer: a keep whose hunk does not land throws its kind, with the hunk and its line on it', async () => {
  const keep = `${KEEP_A}\n${KEEP_A.replace('void f()', 'void nope()')}`;
  const line = keep.split('\n').indexOf('    void nope() {') + 1;
  await assert.rejects(steerWith({ oldText: OLD, newText: NEW, keep }, unattended), (e) => {
    assert.ok(e instanceof MatchError, String(e));
    assert.deepEqual(e.hunkAt, { hunk: 2, mdLine: line });
    assert.ok(e.message.startsWith(`hunk 2 (line ${line}) does not land: no match`), e.message);
    return true;
  });
});

test('steer: a keep hunk that lands only on the old version, not after the hunks before it, says so', async () => {
  const keep = `${KEEP_A}\n${KEEP_A.replace('a2();', 'a3();')}`;
  await assert.rejects(steerWith({ oldText: OLD, newText: NEW, keep }, unattended), (e) => {
    assert.ok(e instanceof MatchError, String(e));
    assert.equal(e.hunkAt?.hunk, 2);
    assert.match(e.message, /^hunk 2 \(line \d+\) does not land: it lands on the old version by itself, but hunk 1 rewrote the text it anchors on/);
    return true;
  });
});

test('steer: of the hunks before it, the one that rewrote the anchor is named — not the last', async () => {
  const keepG = KEEP_A.replace('void f()', 'void g()').replace('  a();', '  b();').replace('a2();', 'b2();');
  const keep = `${KEEP_A}\n${keepG}\n${KEEP_A.replace('a2();', 'a3();')}`;
  await assert.rejects(steerWith({ oldText: OLD, newText: NEW, keep }, unattended), (e) => {
    assert.ok(e instanceof MatchError, String(e));
    assert.equal(e.hunkAt?.hunk, 3);
    assert.match(e.message, /does not land: it lands on the old version by itself, but hunk 1 rewrote the text it anchors on/);
    return true;
  });
});

test('steer: what a kept hunk wrote stays settled when a hunk made later shifts it', async () => {
  const keepG = KEEP_A.replace('void f()', 'void g()').replace('  a();', '  b();').replace('a2();', 'b9();');
  const result = await steerWith({ oldText: OLD, newText: NEW, keep: keepG }, unattended);
  assert.equal(result.hunks.length, 2, 'the kept hunk and the one for f(); g() is not offered again');
  assert.equal(result.reproducesNew, false);
  assert.equal(applied(OLD, result.hunks), NEW.replace('b2();', 'b9();'));
});
