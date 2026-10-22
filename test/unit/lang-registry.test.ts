import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { parseHatchFile } from '../../src/core/hatch-parser.ts';
import { applyAll } from '../../src/core/apply.ts';
import { synthesize } from '../../src/generate/synth.ts';
import { printHatchFile } from '../../src/generate/printer.ts';
import { adapterForLanguage, adapterForFile } from '../../src/lang/adapter.ts';
import { hatchMd } from '../helpers.ts';
import type { SourceMap } from '../../src/lang/source-map.ts';

// depthAt жил в SourceMap, но в src/ его не звал никто — только тесты. Выводится из
// enclosing(), который возвращает спаны от самого внутреннего.
const depthAt = (map: SourceMap, pos: number): number => map.enclosing(pos).length;


interface Case {
  lang: string;
  file: string;
  source: string;
  header: string;
  body: string;
}

const CASES: readonly Case[] = [
  {
    lang: 'cpp',
    file: 'a.cc',
    source: 'void first() {\n  a();\n}\n\nvoid second() {\n  b();\n}\n',
    header: 'void second() {',
    body: '  b();',
  },
  {
    lang: 'c',
    file: 'a.c',
    source: 'void first(void) {\n  a();\n}\n\nvoid second(void) {\n  b();\n}\n',
    header: 'void second(void) {',
    body: '  b();',
  },
  {
    lang: 'objc',
    file: 'a.m',
    source:
      '@implementation Foo\n- (void)first {\n  [self a];\n}\n\n- (void)second {\n  [self b];\n}\n@end\n',
    header: '- (void)second {',
    body: '  [self b];',
  },
  {
    lang: 'javascript',
    file: 'a.js',
    source: 'function first() {\n  a();\n}\n\nfunction second() {\n  b();\n}\n',
    header: 'function second() {',
    body: '  b();',
  },
  {
    lang: 'typescript',
    file: 'a.ts',
    source:
      'function first(): void {\n  a();\n}\n\nfunction second(): void {\n  b();\n}\n',
    header: 'function second(): void {',
    body: '  b();',
  },
  {
    lang: 'tsx',
    file: 'a.tsx',
    source:
      'const first = () => {\n  return <div>a</div>;\n};\n\nconst second = () => {\n  return <div>b</div>;\n};\n',
    header: 'const second = () => {',
    body: '  return <div>b</div>;',
  },
  {
    lang: 'rust',
    file: 'a.rs',
    source: 'fn first() {\n    a();\n}\n\nfn second() {\n    b();\n}\n',
    header: 'fn second() {',
    body: '    b();',
  },
  {
    lang: 'java',
    file: 'A.java',
    source:
      'class A {\n  void first() {\n    a();\n  }\n\n  void second() {\n    b();\n  }\n}\n',
    header: 'void second() {',
    body: '    b();',
  },
  {
    lang: 'kotlin',
    file: 'A.kt',
    source: 'fun first() {\n    a()\n}\n\nfun second() {\n    b()\n}\n',
    header: 'fun second() {',
    body: '    b()',
  },
  {
    lang: 'go',
    file: 'a.go',
    source: 'package main\n\nfunc first() {\n\ta()\n}\n\nfunc second() {\n\tb()\n}\n',
    header: 'func second() {',
    body: '\tb()',
  },
  {
    lang: 'html',
    file: 'a.html',
    source: '<div id="first">\n  <p>a</p>\n</div>\n<div id="second">\n  <p>b</p>\n</div>\n',
    header: '<div id="second">',
    body: '  <p>b</p>',
  },
  {
    lang: 'xml',
    file: 'Info.plist',
    source: '<dict>\n  <array id="first">\n    <string>a</string>\n  </array>\n  <array id="second">\n    <string>b</string>\n  </array>\n</dict>\n',
    header: '<array id="second">',
    body: '    <string>b</string>',
  },
  {
    lang: 'css',
    file: 'a.css',
    source: '.first {\n  color: red;\n}\n\n.second {\n  color: blue;\n}\n',
    header: '.second {',
    body: '  color: blue;',
  },
  {
    lang: 'json',
    file: 'manifest.json',
    source: '{\n  "first": {\n    "a": 1\n  },\n  "second": {\n    "b": 2\n  }\n}\n',
    header: '"second": {',
    body: '    "b": 2',
  },
  {
    lang: 'json5',
    file: 'runtime_enabled_features.json5',
    source: "{\n  // features\n  first: {\n    a: 1,\n  },\n  second: {\n    b: 'two',\n  },\n}\n",
    header: 'second: {',
    body: "    b: 'two',",
  },
  // read as text: blocks by the balance of brackets, no grammar
  {
    lang: 'idl',
    file: 'a.webidl',
    source: '[Exposed=Window] interface First {\n  long a;\n};\n\n[Exposed=Window] interface Second {\n  long b;\n};\n',
    header: 'interface Second {',
    body: '  long b;',
  },
  {
    lang: 'mojom',
    file: 'a.mojom',
    source: 'interface First {\n  A(int32 a);\n};\n\ninterface Second {\n  B(int32 b);\n};\n',
    header: 'interface Second {',
    body: '  B(int32 b);',
  },
  {
    lang: 'proto',
    file: 'a.proto',
    source: 'message First {\n  optional int32 a = 1;\n}\n\nmessage Second {\n  optional int32 b = 1;\n}\n',
    header: 'message Second {',
    body: '  optional int32 b = 1;',
  },
  {
    lang: 'shell',
    file: 'debian/postinst',
    source: 'first() {\n  echo a\n}\n\nsecond() {\n  echo b\n}\n',
    header: 'second() {',
    body: '  echo b',
  },
];

test('a file is its language by name before extension: DEPS and .star are Python', () => {
  const python = adapterForLanguage('python');
  for (const path of ['DEPS', 'src/DEPS', 'build/config/siso/main.star']) {
    assert.equal(adapterForFile(path), python, path);
  }
  // a name is matched whole, and only a name: DEPS.txt is no DEPS (it is text, by `.txt`),
  // a directory DEPS no file
  assert.equal(adapterForFile('DEPS.txt').name, 'text');
  assert.throws(() => adapterForFile('DEPS/README'));
});

test('one grammar file, one pin: adapters that share a .wasm pin it the same', () => {
  const byFile = new Map<string, string>();
  for (const name of ['cpp', 'c', 'objc', 'python', 'javascript', 'typescript', 'tsx', 'rust', 'java', 'kotlin', 'go', 'html', 'xml', 'css', 'json', 'json5']) {
    const g = adapterForLanguage(name).grammar!;
    const pin = `${g.package}@${g.version} ${g.sha256}`;
    const seen = byFile.get(g.file);
    if (seen !== undefined) assert.equal(pin, seen, `${name}: ${g.file} is pinned twice, differently`);
    byFile.set(g.file, pin);
  }
});

for (const c of CASES) {
  test(`${c.lang}: grammar + map + edit inside the wanted body`, async () => {
    const adapter = adapterForLanguage(c.lang);
    assert.equal(adapterForFile(c.file), adapter, 'file extension → the same adapter');

    await adapter.init();

    const map = adapter.buildMap(c.source);
    const canon = adapter.normalize(c.source);
    const inBody = canon.indexOf(adapter.normalize(c.body));
    assert.notEqual(inBody, -1);
    assert.ok(depthAt(map, inBody) >= 1, `depth ${depthAt(map, inBody)}`);
    const spans = map.enclosing(inBody);
    assert.ok(spans.length >= 1, 'the body of a function is a block');
    const withHeader = spans.filter((s) => s.headerStart !== undefined);
    assert.ok(withHeader.length >= 1, 'the block has a header');
    assert.ok(withHeader.every((s) => s.headerStart! < s.open), 'the header is not empty');

    const md = hatchMd(
      [{ match: `...\n${c.header}\n...\n${c.body}\n>>>\n...`, patch: '\n  c();' }],
      c.lang,
    );
    const { source, edits } = applyAll(c.source, parseHatchFile(md), adapter);
    assert.equal(edits.length, 1);
    const at = source.indexOf('c();');
    assert.ok(at > source.indexOf(c.body), 'the edit lands after the body anchor');
    assert.ok(at > source.indexOf('first'), 'the edit lands in the SECOND function');
  });

  test(`${c.lang}: generate round-trip (synth → .md → apply == new version)`, async () => {
    const adapter = adapterForLanguage(c.lang);
    await adapter.init();
    const changed = c.source.replace(c.body, c.body.replace('b', 'z'));
    assert.notEqual(changed, c.source);
    const md = printHatchFile(synthesize(c.source, changed, adapter), c.lang);
    assert.equal(applyAll(c.source, parseHatchFile(md), adapter).source, changed);
  });
}

test('the whole registry is initialized: no broken paths to the .wasm', async () => {
  for (const c of CASES) await adapterForLanguage(c.lang).init();
  await adapterForLanguage('python').init();
});

// One fact written twice: a language declares that it closes blocks by outdent
// (`closesByOutdent` in `lang/<language>/index.ts`), and its `blockOf` hands out blocks
// with no closing token. The two must agree, over every golden of the language: a language
// added with indented blocks and no declaration, or one declared and never closing so, is
// named here.
const GOLDEN = join(import.meta.dirname, '..', 'golden');
for (const language of readdirSync(GOLDEN, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
  test(`registry: ${language} declares closing by outdent exactly when its blocks have no closing token`, async () => {
    const adapter = adapterForLanguage(language);
    await adapter.init();
    let declared: boolean | undefined;
    let implicit = false;
    for (const kind of ['apply', 'generate']) {
      const dir = join(GOLDEN, language, kind);
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir).filter((f) => !f.endsWith('.hatch'))) {
        const map = adapter.buildMap(readFileSync(join(dir, file), 'utf8'));
        declared = map.closesByOutdent;
        const blocks = [...map.blocksWithin(0, map.eof), ...map.enclosing(map.eof)];
        if (blocks.some((b) => b.closeEnd === undefined)) implicit = true;
      }
    }
    assert.notEqual(declared, undefined, `no golden source for ${language}`);
    assert.equal(
      declared,
      implicit,
      implicit
        ? `${language} has blocks with no closing token: declare closesByOutdent: true in its lang/<language>/index.ts`
        : `${language} declares closesByOutdent, but none of its blocks closes by outdent`,
    );
  });
}
