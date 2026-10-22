import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  createLogger,
  createLoggerOrWarn,
  renderError,
  resolveLogPath,
  logHeader,
} from '../../src/infra/log.ts';
import { MatchError, AmbiguityError, ParseError } from '../../src/core/errors.ts';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'sir-log-'));

// ── where the file goes ──────────────────────────────────────────────────────────

test('a place that is a directory receives a generated name', () => {
  const dir = tmp();
  const path = resolveLogPath(dir, 'apply', new Date('2026-08-24T10:20:30Z'), 4242);
  assert.equal(path, join(dir, '2026-08-24T10-20-30-apply-4242.log'));
});

test('a place that is not a directory IS the file name', () => {
  const dir = tmp();
  const wanted = join(dir, 'run.log');
  assert.equal(resolveLogPath(wanted, 'apply'), wanted);
});

test('no place → the default directory, under the current one', () => {
  const path = resolveLogPath(undefined, 'generate', new Date('2026-08-24T10:20:30Z'), 7);
  // README: "omitted means ./sir-logs/"
  assert.equal(resolve(path), join(process.cwd(), 'sir-logs', '2026-08-24T10-20-30-generate-7.log'));
});

test('every run gets its own file: same second, different pid', () => {
  const when = new Date('2026-08-24T10:20:30Z');
  assert.notEqual(resolveLogPath('/x/', 'apply', when, 1), resolveLogPath('/x/', 'apply', when, 2));
});

// ── the file itself ──────────────────────────────────────────────────────────────

test('the log holds every channel, and the header says what was run', () => {
  const path = join(tmp(), 'run.log');
  const log = createLogger({ logPath: path, header: logHeader('apply', ['-i', 'a.cc']) });
  log.trace('a probe');
  log.close();

  const text = readFileSync(path, 'utf8');
  assert.ok(text.includes('# sir apply'), text);
  assert.ok(text.includes('# argv: -i a.cc'), text);
  assert.ok(text.includes('dbg a probe'), text);
});

test('a log is the user\'s source, so the file is theirs alone (0600)', { skip: process.platform === 'win32' }, () => {
  const path = join(tmp(), 'run.log');
  const log = createLogger({ logPath: path });
  log.close();
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('trace reaches the file even when the terminal is quiet', () => {
  const path = join(tmp(), 'run.log');
  const log = createLogger({ logPath: path, verbose: false });
  log.trace('still recorded');
  log.close();
  assert.ok(readFileSync(path, 'utf8').includes('still recorded'));
});

test('a log target that cannot be opened is loud, not silently skipped', () => {
  const blocker = join(tmp(), 'blocker');
  writeFileSync(blocker, 'x');
  assert.throws(() => createLogger({ logPath: join(blocker, 'deep', 'run.log') }), /cannot open log file/);
});

test('the same log name can be reused: the file is overwritten, not refused', () => {
  const path = join(tmp(), 'run.log');
  const first = createLogger({ logPath: path, header: ['# first'] });
  first.info('one');
  first.close();

  const second = createLogger({ logPath: path, header: ['# second'] });
  second.info('two');
  second.close();

  const text = readFileSync(path, 'utf8');
  assert.ok(text.includes('# second') && text.includes('two'), text);
  assert.ok(!text.includes('# first'), 'the earlier run must be overwritten, not appended to');
});

test('createLoggerOrWarn: a log that cannot be opened does not take the command down', () => {
  const blocker = join(tmp(), 'blocker');
  writeFileSync(blocker, 'x');
  const log = createLoggerOrWarn({ logPath: join(blocker, 'deep', 'run.log'), header: ['# head'] });
  assert.equal(log.logPath, undefined, 'no file, and logPath must say so');
  log.trace('the command carries on');
  log.close();
});

test('missing directories are created for the user', () => {
  const dir = join(tmp(), 'deep', 'deeper');
  const log = createLogger({ logPath: join(dir, 'run.log') });
  log.close();
  assert.deepEqual(readdirSync(dir), ['run.log']);
});

test('no log path → no file anywhere, and no complaint', () => {
  const dir = tmp();
  mkdirSync(join(dir, 'sub'));
  const log = createLogger({});
  assert.equal(log.logPath, undefined);
  log.trace('nothing to see');
  log.close();
  assert.deepEqual(readdirSync(dir), ['sub']);
});

// ── rendering ─────────────────────────────────────────────────────────────────

const SOURCE = 'void f() {\n  a();\n  b();\n}\n';

test('MatchError names the anchor, not a step number', () => {
  const e = new MatchError('no match: the pattern did not fit the file', 20, 2, {
    totalSteps: 5,
    origPos: 20,
    anchorText: '  c();',
    matchedText: '  a();',
    matchedPos: 13,
  });
  const out = renderError(e, { source: SOURCE, sourcePath: 'f.cc' });
  assert.ok(out.includes('looking for:  `  c();`'), out);
  assert.ok(out.includes('last anchor that DID match (line 2, col 3)'), out);
  assert.ok(out.includes('stopped at step 3 of 5'), out);
  assert.ok(out.includes('3 |   b();'), out);
});

test('running past the last step is reported as such, with the trailing-dots hint', () => {
  const e = new MatchError('no match: the pattern ran out of steps while the file went on', 20, 3, {
    totalSteps: 3,
    origPos: 20,
    hint: 'the pattern requires the file to END here. Add `...` at the end.',
  });
  const out = renderError(e, { source: SOURCE, sourcePath: 'f.cc' });
  assert.ok(out.includes('ended after its last step (3 of 3)'), out);
  assert.ok(!out.includes('step 4'), out);
  assert.ok(out.includes('hint:'), out);
});

test('AmbiguityError names BOTH places, in lines, with the text', () => {
  const e = new AmbiguityError('ambiguous match: the pattern fits in more than one place', [13, 20]);
  const out = renderError(e, { source: SOURCE, sourcePath: 'f.cc' });
  assert.ok(out.includes('it fits here: (line 2, col 3)'), out);
  assert.ok(out.includes('and here: (line 3, col 3)'), out);
  assert.ok(out.includes('2 |   a();'), out);
  assert.ok(out.includes('3 |   b();'), out);
  assert.ok(!/\b13\b/.test(out), `offsets must not be printed as bare numbers:\n${out}`);
});

test('without the source a report says less, and still says it', () => {
  const e = new AmbiguityError('ambiguous match', [13, 20]);
  const out = renderError(e, {});
  assert.ok(out.startsWith('AmbiguityError: ambiguous match'), out);
  assert.ok(!out.includes('(line '), out);
});

test('other errors keep their old one-line shape', () => {
  assert.equal(renderError(new ParseError('bad gutter', 7), {}), 'ParseError: line 7: bad gutter');
  assert.equal(renderError(new Error('boom'), {}), 'error: boom');
});

test('fail() returns the error\'s exit code and writes the report to the log', () => {
  const path = join(tmp(), 'run.log');
  const log = createLogger({ logPath: path });
  const code = log.fail(new AmbiguityError('ambiguous match', [13, 20]), { source: SOURCE });
  log.close();
  assert.equal(code, 4);
  assert.ok(readFileSync(path, 'utf8').includes('ERR AmbiguityError'));
});
