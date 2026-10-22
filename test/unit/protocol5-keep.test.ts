import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handle } from '../../src/service/handler.ts';
import type { ResponseMessage, ServiceError, SynthesisErrorDetail } from '../../src/service/protocol.ts';
import { parseHatchFile } from '../../src/core/hatch-parser.ts';

// Protocol 5: a change synthesis cannot anchor is written by hand through the service, as
// the CLI does it in the editor (`generate/steer.ts`) — with no session. `SynthesisError`
// hands over the draft; the client finishes it and sends it back as `keep`; synthesis goes
// on from it.

const call = (params: object): Promise<ResponseMessage> => handle({ id: 1, method: 'generate', params });

function ok(response: ResponseMessage): Record<string, unknown> {
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.ok(response.ok);
  return response.result as Record<string, unknown>;
}

function failed(response: ResponseMessage): ServiceError {
  assert.equal(response.ok, false, JSON.stringify(response));
  assert.ok(!response.ok);
  return response.error;
}

/** the draft of a failed `generate`, its fields checked against each other */
function draftOf(response: ResponseMessage): Required<SynthesisErrorDetail> {
  const error = failed(response);
  assert.equal(error.kind, 'SynthesisError', JSON.stringify(error));
  const d = error.detail as Required<SynthesisErrorDetail>;
  assert.equal(typeof d.draft, 'string');
  const lines = d.draft.split('\n');
  assert.equal(lines[d.draftLine - 1], '# match cpp', 'draftLine is the # match of the starting hunk');
  assert.equal(parseHatchFile(d.draft).hunks.length, d.draftHunk, 'the starting hunk is the last');
  return d;
}

/** the draft with its starting hunk replaced — everything from `draftLine` on */
function finished(d: Required<SynthesisErrorDetail>, hunk: string): string {
  return d.draft.split('\n').slice(0, d.draftLine - 1).join('\n') + '\n' + hunk;
}

// Golden cpp/57's shape: two identical if-blocks, the change in the second.
const BODY = '  if (cond) {\n    a();\n    work();\n  }\n  if (cond) {\n    a();\n    work();\n  }\n';
const TWIN = `void f() {\n${BODY}}\n`;
const lastWork = (text: string, to: string): string => {
  const k = text.lastIndexOf('work();');
  return text.slice(0, k) + to + text.slice(k + 'work();'.length);
};

const handHunk = (lead: readonly string[], to: string, trail: readonly string[] = []): string =>
  [
    '# match cpp',
    ...lead,
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
    ...trail,
    '# end',
    '# patch',
    `    ${to}`,
    '# end',
    '',
  ].join('\n');

const HEAD_OLD = `void head() {\n  x();\n}\n\n${TWIN}`;
const HEAD_NEW = `void head() {\n  x2();\n}\n\n${lastWork(TWIN, 'work(2);')}`;
const BASE = { language: 'cpp', baseText: HEAD_OLD, newText: HEAD_NEW };

test('keep (a): a change synthesis cannot anchor answers draft, draftHunk, draftLine, change', async () => {
  const error = failed(await call(BASE));
  const d = draftOf(await call(BASE));
  assert.equal(error.exitCode, 8);
  assert.ok(d.draft.startsWith('Hatch: 1\n'), 'the header generate writes');
  assert.equal(d.draftHunk, 2, 'the hunk for head() so far, then the one to write');
  assert.match(d.draft, /^ {6}x\(\);$/m, 'the hunk so far is there');
  assert.ok(!/could not be anchored|edit the hunks/.test(d.draft), 'no prose in the draft');
  assert.deepEqual(d.change, { line: 12, removed: ['    work();'], added: ['    work(2);'] });
  assert.equal(d.newLine, 12, 'newLine stays as it was');
});

test('keep (a): unreproduced — no change to write by hand, no draft', async () => {
  // NoChanges and the rest are not SynthesisError; the one draftless SynthesisError is
  // `unreproduced`, which no input reaches by design — the field is simply absent then.
  const { SynthesisError } = await import('../../src/core/errors.ts');
  const e = new SynthesisError('x', 'unreproduced', 'x');
  assert.deepEqual(e.detail(), { reason: 'unreproduced' });
});

test('keep (b): the draft finished by hand, sent back — the full patch, reproducesNew, the hand hunk byte for byte', async () => {
  const d = draftOf(await call(BASE));
  const hunk = handHunk([], 'work(2);');
  const keep = finished(d, hunk);
  const r = ok(await call({ ...BASE, keep }));
  assert.equal(r['reproducesNew'], true);
  assert.ok((r['patch'] as string).includes(hunk.trimEnd()), 'the hand hunk, as written');
  assert.equal(parseHatchFile(r['patch'] as string).hunks.length, 2);
  assert.ok((r['hunks'] as { status: string }[]).every((h) => h.status === 'ok'));
});

test('keep: hunks after the kept ones are synthesized and printed below them', async () => {
  const old = `${TWIN}\nvoid tail() {\n  y();\n}\n`;
  const neu = `${lastWork(TWIN, 'work(2);')}\nvoid tail() {\n  y2();\n}\n`;
  const d = draftOf(await call({ language: 'cpp', baseText: old, newText: neu }));
  assert.equal(d.draftHunk, 1);
  const keep = finished(d, handHunk([], 'work(2);', ['    void tail() {', '    ...']));
  const r = ok(await call({ language: 'cpp', baseText: old, newText: neu, keep }));
  const patch = r['patch'] as string;
  assert.equal(r['reproducesNew'], true);
  assert.equal(parseHatchFile(patch).hunks.length, 2);
  assert.ok(patch.indexOf('work(2);') < patch.indexOf('y2();'), 'kept first, synthesized after');
});

test('keep (c): a hunk that does not land — its kind, its number and its line in keep', async () => {
  const d = draftOf(await call(BASE));
  // an anchor the base does not hold
  const keep = finished(d, handHunk([], 'work(2);').replace('    >>>\n    work();', '    >>>\n    nowhere();'));
  const error = failed(await call({ ...BASE, keep }));
  assert.equal(error.kind, 'MatchError');
  assert.equal(error.detail?.['hunk'], 2);
  const at = error.detail?.['mdLine'] as number;
  const lines = d.draft.split('\n').slice(0, d.draftLine - 1).length + handHunk([], '').split('\n').length;
  assert.ok(at >= d.draftLine && at <= lines, `the line is inside hunk 2 of keep: ${at}`);
  assert.match(error.message, new RegExp(`^hunk 2 \\(line ${at}\\) does not land`));
});

test('keep (d): a keep that does not parse — ParseError with its line in keep', async () => {
  const d = draftOf(await call(BASE));
  const keep = finished(d, handHunk([], 'work(2);').replace(/# end\n# patch/, '# patch'));
  const error = failed(await call({ ...BASE, keep }));
  assert.equal(error.kind, 'ParseError');
  assert.equal(typeof error.detail?.['mdLine'], 'number');
});

test('keep: a heading of another language — LanguageError', async () => {
  const d = draftOf(await call(BASE));
  const error = failed(await call({ ...BASE, keep: finished(d, handHunk([], 'work(2);')).replaceAll('# match cpp', '# match python') }));
  assert.equal(error.kind, 'LanguageError');
});

test('keep (e): two changes it cannot anchor — two rounds; the second draft holds the first hand hunk', async () => {
  const G = `void g() {\n${BODY}}\n`;
  const old = `${TWIN}\n${G}`;
  const neu = `${lastWork(TWIN, 'work(2);')}\n${lastWork(G, 'work(3);')}`;
  const params = { language: 'cpp', baseText: old, newText: neu };

  const first = draftOf(await call(params));
  assert.equal(first.draftHunk, 1);
  const hunk1 = handHunk([], 'work(2);', ['    void g() {', '    ...']);
  const second = draftOf(await call({ ...params, keep: finished(first, hunk1) }));
  assert.equal(second.draftHunk, 2);
  assert.ok(second.draft.includes(hunk1.trimEnd()), 'the first hand hunk, byte for byte, in the second draft');
  assert.deepEqual(second.change.added, ['    work(3);']);

  const r = ok(await call({ ...params, keep: finished(second, handHunk(['    ...', '    void g() {'], 'work(3);')) }));
  assert.equal(r['reproducesNew'], true);
  assert.equal(parseHatchFile(r['patch'] as string).hunks.length, 2);
});

test('keep (f): a # note in keep stays — in the patch and in the link table', async () => {
  const d = draftOf(await call(BASE));
  const noted = finished(d, `# note\nwhy: the second block, not the first\n# end\n${handHunk([], 'work(2);')}`);
  const r = ok(await call({ ...BASE, keep: noted }));
  assert.ok((r['patch'] as string).includes('# note\nwhy: the second block, not the first\n# end\n# match cpp'));
  const links = r['hunks'] as { note?: string }[];
  assert.equal(links[1]!.note, 'why: the second block, not the first');
});

test('keep: a body edited to differ from newText — kept as written, reproducesNew false, a warning', async () => {
  const d = draftOf(await call(BASE));
  const r = ok(await call({ ...BASE, keep: finished(d, handHunk([], 'work(7);')) }));
  assert.equal(r['reproducesNew'], false);
  assert.ok((r['patch'] as string).includes('    work(7);'));
  assert.ok((r['warnings'] as string[]).some((w) => /does not give the new version/.test(w)));
});

test('keep: not a string — BadRequest; and keep is no config setting', async () => {
  assert.equal(failed(await call({ ...BASE, keep: 1 })).kind, 'BadRequest');
  const d = draftOf(await call(BASE));
  const r = ok(await call({ ...BASE, keep: finished(d, handHunk([], 'work(2);')) }));
  const settings = (r['config'] as { settings: Record<string, unknown> }).settings;
  assert.ok(!('keep' in settings));
});

test('keep: cancel stops a run that goes on from keep', async () => {
  const { Session } = await import('../../src/service/handler.ts');
  const session = new Session();
  // many changes after the kept hunk: synthesis yields between them
  const many = Array.from({ length: 40 }, (_, i) => `void t${i}() {\n  y();\n}\n`).join('\n');
  const old = `${TWIN}\n${many}`;
  const neu = `${lastWork(TWIN, 'work(2);')}\n${many.replaceAll('y();', 'y2();')}`;
  const d = draftOf(await call({ language: 'cpp', baseText: old, newText: neu }));
  const keep = finished(d, handHunk([], 'work(2);', ['    void t0() {', '    ...']));
  const running = handle({ id: 7, method: 'generate', params: { language: 'cpp', baseText: old, newText: neu, keep } }, undefined, session);
  await handle({ id: 8, method: 'cancel', params: { id: 7 } }, undefined, session);
  assert.equal(failed(await running).kind, 'Cancelled');
});
