import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SirError,
  ParseError,
  MatchError,
  AmbiguityError,
  PathError,
  LanguageError,
  GitError,
  GrammarError,
  ConfigError,
} from '../../src/core/errors.ts';

test('ParseError → code 2, carries a string and (optional) a hint', () => {
  const e = new ParseError('pain', 7, 'advice');
  assert.ok(e instanceof SirError);
  assert.equal(e.exitCode, 2);
  assert.equal(e.mdLine, 7);
  assert.equal(e.hint, 'advice');
  assert.ok(e.message.includes('line 7'));
  assert.ok(e.message.includes('advice'));
});

test('ParseError does not set a hint without a hint', () => {
  const e = new ParseError('pain', 3);
  assert.equal(e.hint, undefined);
  assert.ok(!e.message.includes('hint'));
});

test('MatchError → code 3, carries deepestPos and step index', () => {
  const e = new MatchError('I didn\'t find it', 42, 1);
  assert.equal(e.exitCode, 3);
  assert.equal(e.deepestPos, 42);
  assert.equal(e.failedStepIndex, 1);
});

test('AmbiguityError → code 4, carries match positions', () => {
  const e = new AmbiguityError('ambiguous', [10, 99]);
  assert.equal(e.exitCode, 4);
  assert.deepStrictEqual(e.positions, [10, 99]);
});

test('class names are saved (instanceof via prototype chain)', () => {
  const e: SirError = new ParseError('x', 1);
  assert.equal(e.name, 'ParseError');
  assert.ok(e instanceof Error);
});

test('detail(): every error kind states exactly its protocol fields', () => {
  assert.deepEqual(new ParseError('bad', 3, 'fix it').detail(), { mdLine: 3, hint: 'fix it' });
  assert.deepEqual(new ParseError('bad', 3).detail(), { mdLine: 3 });
  assert.deepEqual(
    new MatchError('no', 10, 1, { totalSteps: 4, origPos: 7, anchorText: 'a()', matchedText: 'x', hint: 'h' }).detail(),
    { failedStepIndex: 1, totalSteps: 4, origPos: 7, anchorText: 'a()' },
  );
  assert.deepEqual(new MatchError('no', 0, 0).detail(), { failedStepIndex: 0 });
  assert.deepEqual(new AmbiguityError('two', [1, 5], [2, 6]).detail(), { positions: [1, 5] });
  assert.deepEqual(new PathError('p', '/a/b', '/a').detail(), { path: '/a/b', blocker: '/a' });
  assert.deepEqual(new LanguageError('l', { language: 'x', extension: '.y' }).detail(), { language: 'x', extension: '.y' });
  assert.deepEqual(new LanguageError('l').detail(), {});
  assert.deepEqual(new GitError('g', 'no-such-branch', { revision: 'main', flag: '--branch' }).detail(), {
    reason: 'no-such-branch',
    revision: 'main',
  });
  assert.deepEqual(new GitError('g', 'no-commits').detail(), { reason: 'no-commits' });
  assert.deepEqual(new GrammarError('m', 'tree-sitter-cpp@1').detail(), { grammar: 'tree-sitter-cpp@1' });
  assert.equal(new GrammarError('m').detail(), undefined);
  assert.deepEqual(new ConfigError('c', '/p/sir.config.json').detail(), { file: '/p/sir.config.json' });
  assert.equal(new ConfigError('c').detail(), undefined);
});
