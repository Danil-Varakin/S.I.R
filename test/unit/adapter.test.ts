import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  adapterForLanguage,
  adapterForFile,
  adaptersByName,
  checkHeading,
  extensionOf,
  pickAdapter,
  supportedLanguages,
} from '../../src/lang/adapter.ts';
import { LanguageError } from '../../src/core/errors.ts';
import { cppAdapter } from '../../src/lang/cpp/index.ts';
import { cAdapter } from '../../src/lang/c/index.ts';
import { objcAdapter } from '../../src/lang/objc/index.ts';
import { pythonAdapter } from '../../src/lang/python/index.ts';
import { javascriptAdapter } from '../../src/lang/javascript/index.ts';
import { typescriptAdapter } from '../../src/lang/typescript/index.ts';
import { tsxAdapter } from '../../src/lang/tsx/index.ts';
import { rustAdapter } from '../../src/lang/rust/index.ts';
import { javaAdapter } from '../../src/lang/java/index.ts';
import { kotlinAdapter } from '../../src/lang/kotlin/index.ts';
import { goAdapter } from '../../src/lang/go/index.ts';

test('language name resolves to its adapter (case-insensitive, aliases)', () => {
  assert.equal(adapterForLanguage('cpp'), cppAdapter);
  assert.equal(adapterForLanguage('C++'), cppAdapter);
  assert.equal(adapterForLanguage('  CC  '), cppAdapter);
});

test('every language of the Chromium set resolves to its own adapter', () => {
  assert.equal(adapterForLanguage('c'), cAdapter);
  assert.equal(adapterForLanguage('objective-c'), objcAdapter);
  assert.equal(adapterForLanguage('python'), pythonAdapter);
  assert.equal(adapterForLanguage('py'), pythonAdapter);
  assert.equal(adapterForLanguage('JS'), javascriptAdapter);
  assert.equal(adapterForLanguage('jsx'), javascriptAdapter);
  assert.equal(adapterForLanguage('ts'), typescriptAdapter);
  assert.equal(adapterForLanguage('tsx'), tsxAdapter);
  assert.equal(adapterForLanguage('rust'), rustAdapter);
  assert.equal(adapterForLanguage('java'), javaAdapter);
  assert.equal(adapterForLanguage('kt'), kotlinAdapter);
  assert.equal(adapterForLanguage('golang'), goAdapter);
});

test('missing language → clear error, not a silent default', () => {
  assert.throws(() => adapterForLanguage(undefined), /not specified/);
  assert.throws(() => adapterForLanguage(''), /not specified/);
});

test('unknown language → unsupported error (closed whitelist, no dynamic import)', () => {
  assert.throws(() => adapterForLanguage('cobol'), /unsupported language 'cobol'/);
  assert.throws(() => adapterForLanguage('../../etc/passwd'), /unsupported language/);
  assert.ok(supportedLanguages.includes('cpp'));
});

test('file extension resolves to its adapter', () => {
  assert.equal(adapterForFile('src/foo.cc'), cppAdapter);
  assert.equal(adapterForFile('C:/x/Bar.HPP'), cppAdapter);
});

test('extensions of the Chromium set do not overlap and hit the right adapter', () => {
  assert.equal(adapterForFile('base/foo.c'), cAdapter);
  assert.equal(adapterForFile('base/foo.h'), cppAdapter);
  assert.equal(adapterForFile('ui/cocoa/foo.mm'), objcAdapter);
  assert.equal(adapterForFile('build/gen.py'), pythonAdapter);
  assert.equal(adapterForFile('devtools/x.js'), javascriptAdapter);
  assert.equal(adapterForFile('devtools/x.ts'), typescriptAdapter);
  assert.equal(adapterForFile('devtools/X.TSX'), tsxAdapter);
  assert.equal(adapterForFile('components/lib.rs'), rustAdapter);
  assert.equal(adapterForFile('android/Foo.java'), javaAdapter);
  assert.equal(adapterForFile('android/Foo.kt'), kotlinAdapter);
  assert.equal(adapterForFile('infra/main.go'), goAdapter);
});

test('unknown extension → error', () => {
  assert.throws(() => adapterForFile('notes.xyz'), /no adapter for file extension/);
});

test('the extension is read from the file name, never from a directory', () => {
  assert.equal(extensionOf('/my.proj/Makefile'), '');
  assert.equal(extensionOf('C:/x/Bar.HPP'), '.hpp');
  assert.throws(() => adapterForFile('/my.proj/Makefile'), /file extension '\(none\)'/);
});

const ADAPTERS = [...new Set(adaptersByName().values())];

test('every extension a language claims is also a name that leads back to it', () => {
  for (const adapter of ADAPTERS) {
    for (const ext of adapter.extensions) {
      const word = ext.slice(1);
      assert.equal(adapterForFile(`f${ext}`), adapter, `${ext} by file`);
      assert.equal(adapterForLanguage(word), adapter, `'# match ${word}' by name`);
      assert.ok(supportedLanguages.includes(word), `${word} is listed`);
    }
  }
});

test('a name written by hand never contradicts the extension of the same spelling', () => {
  for (const [word, adapter] of adaptersByName()) {
    const owner = ADAPTERS.find((a) => a.extensions.includes(`.${word}`));
    if (owner !== undefined) assert.equal(adapter, owner, `'${word}' names ${adapter.name}, .${word} is ${owner.name}`);
  }
});

test('every adapter is found again by its own name', () => {
  for (const adapter of ADAPTERS) assert.equal(adapterForLanguage(adapter.name), adapter, adapter.name);
});

test('checkHeading: a heading apply reads back as the same language passes', () => {
  checkHeading('m', objcAdapter);
  checkHeading('PYI', pythonAdapter);
  checkHeading('C++', cppAdapter);
  checkHeading('', cppAdapter);
});

test('checkHeading: a heading apply would read as another language, or none, is refused', () => {
  assert.throws(() => checkHeading('c', cppAdapter), (e: unknown) => {
    assert.ok(e instanceof LanguageError);
    assert.match(e.message, /'# match c' would be read back by apply as language 'c', not as 'cpp'/);
    return true;
  });
  assert.throws(() => checkHeading('cobol', cppAdapter), /as no language at all/);
});

test('pickAdapter: named outright, else the heading, else the extension — one order for all', () => {
  assert.equal(pickAdapter({ language: 'c', heading: 'python', path: 'x.go' }), cAdapter);
  assert.equal(pickAdapter({ heading: 'python', path: 'x.go' }), pythonAdapter);
  assert.equal(pickAdapter({ path: 'x.go' }), goAdapter);
  assert.throws(() => pickAdapter({}), /language is not specified/);
});

test('pickAdapter: an empty name is no name, wherever it comes from', () => {
  assert.equal(pickAdapter({ language: '', heading: 'python', path: 'x.go' }), pythonAdapter);
  assert.equal(pickAdapter({ language: '  ', heading: '', path: 'x.go' }), goAdapter);
  assert.throws(() => pickAdapter({ language: '' }), /language is not specified/);
  assert.throws(() => pickAdapter({ language: 'cobol', path: 'x.go' }), /unsupported language 'cobol'/);
});
