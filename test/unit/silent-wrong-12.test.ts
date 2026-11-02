import { test } from 'node:test';
import assert from 'node:assert/strict';

import { adapterForLanguage } from '../../src/lang/adapter.ts';
import { alreadyThere, applyAll } from '../../src/core/apply.ts';
import type { AlreadyThere, HunkNote } from '../../src/core/apply.ts';
import { parseSirFile } from '../../src/core/sir-parser.ts';
import { AmbiguityError, MatchError } from '../../src/core/errors.ts';
import type { SirFile } from '../../src/core/ast.ts';
import type { LanguageAdapter } from '../../src/lang/source-map.ts';
import { patchOf } from '../matrix.ts';
import { TUNE_DRIFTS, TUNE_SYNTAX, tuneModel, tuneRender } from '../../bench/corpus.ts';

const REFUSED = '(refused)';

type Patch = (a: LanguageAdapter) => SirFile;

const generated = (oldText: string, newText: string): Patch => (a) => patchOf(oldText, newText, a);

function hand(language: string, match: string, patch: string, format?: number): Patch {
  const indent = (s: string): string => s.split('\n').map((l) => (l === '' ? '' : `    ${l}`)).join('\n');
  const header = format === undefined ? '' : `Sir: ${format}\n\n`;
  const text = `${header}# match ${language}\n${indent(match)}\n# end\n# patch\n${indent(patch)}\n# end\n`;
  return () => parseSirFile(text);
}

async function laid(language: string, patch: Patch, base: string): Promise<string | Error> {
  const a = adapterForLanguage(language);
  await a.init();
  const file = patch(a);
  try {
    return applyAll(base, file, a).source;
  } catch (e) {
    return e as Error;
  }
}

function assertRefusedToMatch(got: string | Error): void {
  if (typeof got === 'string') assert.fail(`landed:\n${got}`);
  assert.ok(got instanceof MatchError || got instanceof AmbiguityError, `refused for another reason: ${got.constructor.name}: ${got.message}`);
}

async function landsAs(language: string, patch: Patch, base: string, want: string): Promise<void> {
  const got = await laid(language, patch, base);
  if (want === REFUSED) return assertRefusedToMatch(got);
  if (got instanceof Error) assert.fail(`refused: ${got.constructor.name}: ${got.message}`);
  assert.equal(got, want);
}

async function landsRightOrRefuses(language: string, patch: Patch, base: string, want: string): Promise<void> {
  const got = await laid(language, patch, base);
  if (got instanceof Error) return assertRefusedToMatch(got);
  assert.equal(got, want);
}

async function notesOf(language: string, patch: Patch, base: string): Promise<HunkNote[]> {
  const a = adapterForLanguage(language);
  await a.init();
  return applyAll(base, patch(a), a).notes;
}

async function saysLineEdge(language: string, patch: Patch, base: string): Promise<void> {
  const notes = await notesOf(language, patch, base);
  assert.ok(notes.some((n) => n.reason === 'line-edge'), `no line-edge note; notes: ${JSON.stringify(notes)}`);
}

async function saysNothing(language: string, patch: Patch, base: string): Promise<void> {
  const notes = await notesOf(language, patch, base);
  assert.deepEqual(notes.filter((n) => n.reason === 'line-edge'), []);
}

async function verdictOn(language: string, patch: Patch, file: string, base: string | undefined): Promise<AlreadyThere> {
  const a = adapterForLanguage(language);
  await a.init();
  const p = patch(a);
  return alreadyThere(applyAll(file, p, a).copies, p, a, base);
}

type Adopted = [string, string, string, string];

const ADOPTED_IMPORT: Adopted[] = [
  ['python', 'import os\nimport plistlib\n%%import sys\n\n\ndef main():\n    run()\n', 'import subprocess\n', '\n\ndef other():\n    pass\n'],
  ['cpp', '#include "base/a.h"\n#include "base/b.h"\n%%#include "base/d.h"\n\nvoid f() {\n  a();\n}\n', '#include "base/c.h"\n', '\nvoid g() {\n  b();\n}\n'],
  ['c', '#include <stdio.h>\n#include <stdlib.h>\n%%#include <unistd.h>\n\nint f(void) {\n  return 0;\n}\n', '#include <string.h>\n', '\nint g(void) {\n  return 1;\n}\n'],
  ['objc', '#import "a.h"\n#import "b.h"\n%%#import "d.h"\n\n@implementation K\n- (void)f {\n  a();\n}\n@end\n', '#import "c.h"\n', '\n@implementation L\n- (void)g {\n  b();\n}\n@end\n'],
  ['java', 'package p;\n\nimport java.util.List;\nimport java.util.Map;\n%%import java.util.Set;\n\nclass K {\n  void f() {\n    a();\n  }\n}\n', 'import java.util.Optional;\n', '\nclass L {\n}\n'],
  ['javascript', "import { a } from './a.js';\nimport { b } from './b.js';\n%%import { d } from './d.js';\n\nexport function f() {\n  a();\n}\n", "import { c } from './c.js';\n", '\nexport function g() {\n  b();\n}\n'],
  ['typescript', "import { a } from './a.js';\nimport type { B } from './b.js';\n%%import { d } from './d.js';\n\nexport function f(): void {\n  a();\n}\n", "import { c } from './c.js';\n", '\nexport function g(): void {\n  d();\n}\n'],
  ['go', 'package main\n\nimport (\n\t"fmt"\n\t"os"\n%%\t"strings"\n)\n\nfunc f() {\n\tfmt.Println(os.Args)\n}\n', '\t"os/exec"\n', '\nfunc g() {\n\tfmt.Println(strings.ToUpper(""))\n}\n'],
  ['kotlin', 'package p\n\nimport a.A\nimport a.B\n%%import a.D\n\nfun f() {\n    a()\n}\n', 'import a.C\n', '\nfun g() {\n    b()\n}\n'],
  ['rust', 'use std::fs;\nuse std::io;\n%%use std::path::Path;\n\nfn f() {\n    a();\n}\n', 'use std::process::Command;\n', '\nfn g() {\n    b();\n}\n'],
  ['proto', 'syntax = "proto3";\n\nimport "a.proto";\nimport "b.proto";\n%%import "d.proto";\n\nmessage M {\n  int32 a = 1;\n}\n', 'import "c.proto";\n', '\nmessage N {\n  int32 b = 1;\n}\n'],
  ['mojom', 'module m.mojom;\n\nimport "a.mojom";\nimport "b.mojom";\n%%import "d.mojom";\n\ninterface I {\n  F();\n};\n', 'import "c.mojom";\n', '\ninterface J {\n  G();\n};\n'],
  ['css', '@import url("a.css");\n@import url("b.css");\n%%@import url("d.css");\n\n.f {\n  a: 1;\n}\n', '@import url("c.css");\n', '\n.g {\n  b: 2;\n}\n'],
  ['shell', '#!/bin/sh\n. ./a.sh\n. ./b.sh\n%%. ./d.sh\n\nmain() {\n  run\n}\n', '. ./c.sh\n', '\nother() {\n  stop\n}\n'],
];

const ADOPTED_CASE: Adopted[] = [
  ['cpp', 'const char* Name(Type t) {\n  switch (t) {\n    case kA:\n      return "a";\n    case kB:\n      return "b";\n%%    case kD:\n      return "d";\n  }\n}\n', '    case kC:\n      return "c";\n', '\nint Other() {\n  return 0;\n}\n'],
  ['c', 'const char *name(int t) {\n  switch (t) {\n  case A:\n    return "a";\n  case B:\n    return "b";\n%%  case D:\n    return "d";\n  }\n  return 0;\n}\n', '  case C:\n    return "c";\n', '\nint other(void) {\n  return 0;\n}\n'],
  ['java', 'class K {\n  String name(int t) {\n    switch (t) {\n      case A:\n        return "a";\n      case B:\n        return "b";\n%%      case D:\n        return "d";\n    }\n    return null;\n  }\n}\n', '      case C:\n        return "c";\n', '\nclass L {\n}\n'],
  ['javascript', "function name(t) {\n  switch (t) {\n    case 'a':\n      return 1;\n    case 'b':\n      return 2;\n%%    case 'd':\n      return 4;\n  }\n}\n", "    case 'c':\n      return 3;\n", '\nfunction other() {\n  return 0;\n}\n'],
  ['typescript', "function name(t: string): number {\n  switch (t) {\n    case 'a':\n      return 1;\n    case 'b':\n      return 2;\n%%    case 'd':\n      return 4;\n  }\n  return 0;\n}\n", "    case 'c':\n      return 3;\n", '\nfunction other(): number {\n  return 0;\n}\n'],
  ['go', 'package p\n\nfunc name(t int) string {\n\tswitch t {\n\tcase A:\n\t\treturn "a"\n\tcase B:\n\t\treturn "b"\n%%\tcase D:\n\t\treturn "d"\n\t}\n\treturn ""\n}\n', '\tcase C:\n\t\treturn "c"\n', '\nfunc other() int {\n\treturn 0\n}\n'],
  ['kotlin', 'fun name(t: T): String = when (t) {\n    T.A -> "a"\n    T.B -> "b"\n%%    T.D -> "d"\n}\n', '    T.C -> "c"\n', '\nfun other() = 0\n'],
  ['rust', 'fn name(t: T) -> &\'static str {\n    match t {\n        T::A => "a",\n        T::B => "b",\n%%        T::D => "d",\n    }\n}\n', '        T::C => "c",\n', '\nfn other() -> u32 {\n    0\n}\n'],
  ['python', 'NAMES = {\n    "a": 1,\n    "b": 2,\n%%    "d": 4,\n}\n', '    "c": 3,\n', '\n\ndef other():\n    pass\n'],
  ['toml', '[names]\na = 1\nb = 2\n%%d = 4\n\n[other]\nx = 1\n', 'c = 3\n', '\n[more]\ny = 2\n'],
  ['xml', '<map>\n  <entry key="a"/>\n  <entry key="b"/>\n%%  <entry key="d"/>\n</map>\n', '  <entry key="c"/>\n', ''],
  ['idl', 'enum Kind {\n  "a",\n  "b",\n%%  "d"\n};\n', '  "c",\n', '\ninterface I {\n  void f();\n};\n'],
  ['proto', 'enum Kind {\n  A = 0;\n  B = 1;\n%%  D = 3;\n}\n', '  C = 2;\n', '\nmessage M {\n  int32 a = 1;\n}\n'],
  ['mojom', 'enum Kind {\n  kA,\n  kB,\n%%  kD,\n};\n', '  kC,\n', '\ninterface I {\n  F();\n};\n'],
];

const ADOPTED_CALL_AT_END: Adopted[] = [
  ['cpp', 'void Service::Unregister(Id id) {\n  observers_.Notify(id);\n  pending_.erase(id);\n%%}\n', '  std::erase(ready_, id);\n', '\nvoid Service::Other() {\n  a();\n}\n'],
  ['c', 'void unregister(int id) {\n  notify(id);\n  drop_pending(id);\n%%}\n', '  drop_ready(id);\n', '\nvoid other(void) {\n  a();\n}\n'],
  ['objc', '@implementation K\n- (void)unregister:(int)i {\n  [self notify:i];\n  [self dropPending:i];\n%%}\n@end\n', '  [self dropReady:i];\n', ''],
  ['java', 'class K {\n  void unregister(int id) {\n    notify(id);\n    pending.remove(id);\n%%  }\n}\n', '    ready.remove(id);\n', '\nclass L {\n}\n'],
  ['javascript', 'function unregister(id) {\n  notify(id);\n  pending.delete(id);\n%%}\n', '  ready.delete(id);\n', '\nfunction other() {\n  a();\n}\n'],
  ['typescript', 'function unregister(id: number): void {\n  notify(id);\n  pending.delete(id);\n%%}\n', '  ready.delete(id);\n', '\nfunction other(): void {\n  a();\n}\n'],
  ['go', 'package p\n\nfunc (s *S) Unregister(id int) {\n\ts.notify(id)\n\tdelete(s.pending, id)\n%%}\n', '\tdelete(s.ready, id)\n', '\nfunc (s *S) Other() {\n\ts.a()\n}\n'],
  ['rust', 'impl S {\n    fn unregister(&mut self, id: u32) {\n        self.notify(id);\n        self.pending.remove(&id);\n%%    }\n}\n', '        self.ready.remove(&id);\n', '\nfn other() {\n    a();\n}\n'],
  ['kotlin', 'fun unregister(id: Int) {\n    notify(id)\n    pending.remove(id)\n%%}\n', '    ready.remove(id)\n', '\nfun other() {\n    a()\n}\n'],
  ['python', 'class S:\n    def unregister(self, i):\n        self.notify(i)\n        self.pending.pop(i)\n%%\n    def other(self):\n        pass\n', '        self.ready.pop(i)\n', '\n\ndef more():\n    pass\n'],
  ['shell', 'cleanup() {\n  rm -f "$a"\n  rm -f "$b"\n%%}\n', '  rm -f "$c"\n', '\nother() {\n  stop\n}\n'],
  ['css', '.f {\n  a: 1;\n  b: 2;\n%%}\n', '  c: 3;\n', '\n.g {\n  x: 1;\n}\n'],
  ['yaml', 'steps:\n  - a\n  - b\n%%other: 1\n', '  - c\n', 'more: 2\n'],
];

const ADOPTED_METHOD: Adopted[] = [
  ['cpp', 'namespace {\n\nTEST_F(UpdaterTest, Starts) {\n  EXPECT_TRUE(Start());\n}\n\nTEST_F(UpdaterTest, Stops) {\n  EXPECT_TRUE(Stop());\n}\n%%\n}  // namespace\n', '\nTEST_F(UpdaterTest, Unregisters) {\n  EXPECT_TRUE(Unregister());\n}\n', '\nvoid Helper() {\n  a();\n}\n'],
  ['objc', '@implementation KTest\n- (void)testStarts {\n  XCTAssertTrue([self start]);\n}\n\n- (void)testStops {\n  XCTAssertTrue([self stop]);\n}\n%%@end\n', '\n- (void)testUnregisters {\n  XCTAssertTrue([self unregister]);\n}\n', '\n@implementation L\n- (void)g {\n  b();\n}\n@end\n'],
  ['java', 'class KTest {\n  @Test\n  public void starts() {\n    assertTrue(start());\n  }\n\n  @Test\n  public void stops() {\n    assertTrue(stop());\n  }\n%%}\n', '\n  @Test\n  public void unregisters() {\n    assertTrue(unregister());\n  }\n', '\nclass LTest {\n}\n'],
  ['javascript', "describe('k', () => {\n  it('starts', () => {\n    check(start());\n  });\n\n  it('stops', () => {\n    check(stop());\n  });\n%%});\n", "\n  it('unregisters', () => {\n    check(unregister());\n  });\n", "\ndescribe('l', () => {\n});\n"],
  ['typescript', 'class K {\n  starts(): void {\n    start();\n  }\n\n  stops(): void {\n    stop();\n  }\n%%}\n', '\n  unregisters(): void {\n    unregister();\n  }\n', '\nclass L {\n}\n'],
  ['go', 'package p\n\nfunc TestStarts(t *testing.T) {\n\tcheck(t, start())\n}\n\nfunc TestStops(t *testing.T) {\n\tcheck(t, stop())\n}\n%%', '\nfunc TestUnregisters(t *testing.T) {\n\tcheck(t, unregister())\n}\n', ''],
  ['kotlin', 'class KTest {\n    @Test\n    fun starts() {\n        check(start())\n    }\n\n    @Test\n    fun stops() {\n        check(stop())\n    }\n%%}\n', '\n    @Test\n    fun unregisters() {\n        check(unregister())\n    }\n', '\nclass LTest\n'],
  ['rust', 'mod tests {\n    #[test]\n    fn starts() {\n        assert!(start());\n    }\n\n    #[test]\n    fn stops() {\n        assert!(stop());\n    }\n%%}\n', '\n    #[test]\n    fn unregisters() {\n        assert!(unregister());\n    }\n', '\nfn other() {\n    a();\n}\n'],
];

const ADOPTED_SETS: [string, Adopted[]][] = [
  ['a second import', ADOPTED_IMPORT],
  ['a second case of a table', ADOPTED_CASE],
  ['a second call at the end of a block', ADOPTED_CALL_AT_END],
  ['a second test or method', ADOPTED_METHOD],
];

for (const [what, cases] of ADOPTED_SETS) {
  for (const [language, tpl, text, tail] of cases) {
    test(`Т5 ${language}: ${what} — upstream already holds the change, it is not laid twice`, async () => {
      const oldText = tpl.replace('%%', '');
      const upstream = tpl.replace('%%', text) + tail;
      const patch = generated(oldText, tpl.replace('%%', text));
      assert.deepEqual(await verdictOn(language, patch, upstream, oldText), { kind: 'taken', hunks: [0] });
      assert.deepEqual(await verdictOn(language, patch, upstream, undefined), { kind: 'unwitnessed', hunks: [0] }, 'no base: laid, warned of');
    });
  }
}

const ADOPTED_CHANGED: [string, string, string, string][] = [
  ['cpp', 'const char* Name(Type t) {\n  switch (t) {\n    case kA:\n      return "a";\n    case kB:\n      return "b";\n%%    case kD:\n      return "d";\n  }\n}\n', '    case kC:\n      return "c";\n', '    case kCee:\n      return "c";\n'],
  ['java', 'class K {\n  String name(int t) {\n    switch (t) {\n      case A:\n        return "a";\n      case B:\n        return "b";\n%%      case D:\n        return "d";\n    }\n    return null;\n  }\n}\n', '      case C:\n        return "c";\n', '      case CEE:\n        return "c";\n'],
  ['cpp', 'void Service::Unregister(Id id) {\n  observers_.Notify(id);\n  pending_.erase(id);\n%%}\n', '  std::erase(ready_, id);\n', '  ready_.Remove(id);\n'],
];

for (const [language, tpl, ours, theirs] of ADOPTED_CHANGED) {
  test(`Т5 ${language}: upstream took the change under another name — the patch does not lay the old one beside it`, { todo: '12 Л11' }, async () => {
    await landsAs(language, generated(tpl.replace('%%', ''), tpl.replace('%%', ours)), tpl.replace('%%', theirs), REFUSED);
  });
}

const TWICE: [string, string, string, string][] = [
  ['cpp', 'void f(int x) {\n  a(x);\n  b(x);\n%%  c(x);\n}\n', '  b(x);', '  NEW(x);\n'],
  ['java', 'class K {\n  void f(int x) {\n    a(x);\n    b(x);\n%%    c(x);\n  }\n}\n', '    b(x);', '    NEW(x);\n'],
  ['python', 'def f(x):\n    a(x)\n    b(x)\n%%    c(x)\n', '    b(x)', '    NEW(x)\n'],
  ['javascript', 'function f(x) {\n  a(x);\n  b(x);\n%%  c(x);\n}\n', '  b(x);', '  NEW(x);\n'],
  ['go', 'package p\n\nfunc f(x int) {\n\ta(x)\n\tb(x)\n%%\tc(x)\n}\n', '\tb(x)', '\tNEW(x)\n'],
  ['yaml', 'f:\n  a: 1\n  b: 2\n%%  c: 3\n', '  b: 2', '  n: 9\n'],
  ['json', '{\n  "f": {\n    "a": 1,\n    "b": 2,\n%%    "c": 3\n  }\n}\n', '    "b": 2,', '    "n": 9,\n'],
  ['css', '.f {\n  a: 1;\n  b: 2;\n%%  c: 3;\n}\n', '  b: 2;', '  n: 9;\n'],
];

for (const [language, tpl, before, line] of TWICE) {
  const patch = hand(language, `...\n${before}\n>>>\n...`, `\n${line.replace(/\n$/, '')}`);
  const base = tpl.replace('%%', '');
  test(`Т5 ${language}: a hunk pinned to the line before it, laid twice — the second time refused`, async () => {
    const once = await laid(language, patch, base);
    assert.equal(once, tpl.replace('%%', line), 'the first time it lands');
    assert.deepEqual(await verdictOn(language, patch, once as string, base), { kind: 'taken', hunks: [0] });
  });
  test(`guard: ${language}, by hand, a second copy of a line the base has — laid; refused once upstream took it too`, async () => {
    const one = tpl.replace('%%', line);
    assert.deepEqual(await verdictOn(language, patch, one, one), { kind: 'clear' });
    assert.equal(await laid(language, patch, one), tpl.replace('%%', line + line));
    assert.deepEqual(await verdictOn(language, patch, tpl.replace('%%', line + line), one), { kind: 'taken', hunks: [0] });
  });
}

const HEADS: [string, string, (body: string) => string][] = [
  ['cpp', '  if (frame->IsMain())', (b) => `void Frame::Init() {\n${b}  Done();\n}\n`],
  ['cpp', '  else if (frame->IsMain())', (b) => `void Frame::Init() {\n  if (other)\n    Skip();\n${b}  Done();\n}\n`],
  ['cpp', '  for (auto& child : children_)', (b) => `void Frame::Init() {\n${b}  Done();\n}\n`],
  ['cpp', '  while (HasMore())', (b) => `void Frame::Init() {\n${b}  Done();\n}\n`],
  ['c', '  if (is_main(frame))', (b) => `void init(struct frame *frame) {\n${b}  done();\n}\n`],
  ['objc', '  if ([self isMain])', (b) => `@implementation Frame\n- (void)init {\n${b}  [self done];\n}\n@end\n`],
];

for (const [language, head, unit] of HEADS) {
  test(`Т1 ${language}: \`${head.trim()} >>>\`, upstream appended \` {\` to the line — the hunk says it stands against the end of the line`, async () => {
    const before = unit(`${head}\n    Notify();\n`);
    const after = unit(`${head} MYFORK_GUARD\n    Notify();\n`);
    const upstream = unit(`${head} {\n    Notify();\n    Log();\n  }\n`);
    await saysLineEdge(language, generated(before, after), upstream);
  });
}

const fn = (b: string): string => `void f() {\n  a();\n${b}  c();\n}\n`;
const T1_PROBES: [string, string, string, string, string][] = [
  ['T1.1 css: an insertion after `color: red;`, upstream has `background-color: red;`', 'css',
    '.f {\n  a: 1;\n  color: red;\n  b: 2;\n}\n', '.f {\n  a: 1;\n  color: red;\n  n: 1;\n  b: 2;\n}\n', '.f {\n  a: 1;\n  background-color: red;\n  b: 2;\n}\n'],
  ['T1.2 css: `color: red;` replaced, upstream has `background-color: red;`', 'css',
    '.f {\n  a: 1;\n  color: red;\n  b: 2;\n}\n', '.f {\n  a: 1;\n  color: blue;\n  b: 2;\n}\n', '.f {\n  a: 1;\n  background-color: red;\n  b: 2;\n}\n'],
  ['T1.4 javascript: an insertion after `cancel();`, upstream has `$cancel();`', 'javascript',
    'function f() {\n  a();\n  cancel();\n  b();\n}\n', 'function f() {\n  a();\n  cancel();\n  n();\n  b();\n}\n', 'function f() {\n  a();\n  $cancel();\n  b();\n}\n'],
  ['T1.5 cpp: `cancel();` replaced, upstream has `other.cancel();`', 'cpp', fn('  cancel();\n'), fn('  stop();\n'), fn('  other.cancel();\n')],
  ['T1.6 cpp: an insertion after `b();`, upstream commented it out', 'cpp', fn('  b();\n'), fn('  b();\n  n();\n'), fn('  // b();\n')],
  ['T1.7 cpp: `b();` replaced, upstream commented it out', 'cpp', fn('  b();\n'), fn('  B();\n'), fn('  // b();\n')],
  ['T1.8 cpp: an insertion after `b();`, upstream has it inside a string', 'cpp', fn('  b();\n'), fn('  b();\n  n();\n'), fn('  Log("b();");\n')],
  ['T1.9 python: an insertion after `value = base`, upstream has `value = base + extra`', 'python',
    'def f(x):\n    a = 1\n    value = base\n    return a\n', 'def f(x):\n    a = 1\n    value = base\n    log(value)\n    return a\n', 'def f(x):\n    a = 1\n    value = base + extra\n    return a\n'],
  ['T1.10 go: an insertion after `value := base`, upstream has `value := base + extra`', 'go',
    'func f() {\n\ta := 1\n\tvalue := base\n\treturn\n}\n', 'func f() {\n\ta := 1\n\tvalue := base\n\tlog(value)\n\treturn\n}\n', 'func f() {\n\ta := 1\n\tvalue := base + extra\n\treturn\n}\n'],
  ['T1.11 cpp: an insertion after `b();`, upstream has `b(); d();` on one line', 'cpp', fn('  b();\n'), fn('  b();\n  n();\n'), fn('  b(); d();\n')],
  ['T1.12 yaml: an insertion after `step: ctx`, upstream has `step: ctx extra`', 'yaml',
    'f:\n  a: 1\n  step: ctx\n  b: 2\n', 'f:\n  a: 1\n  step: ctx\n  n: 9\n  b: 2\n', 'f:\n  a: 1\n  step: ctx extra\n  b: 2\n'],
  ['kotlin: an insertion after `val v = base`, upstream has `val v = base + extra`', 'kotlin',
    'fun f() {\n    a()\n    val v = base\n    b()\n}\n', 'fun f() {\n    a()\n    val v = base\n    log(v)\n    b()\n}\n', 'fun f() {\n    a()\n    val v = base + extra\n    b()\n}\n'],
  ['typescript: an insertion after `const v = base`, upstream has `const v = base ?? extra`', 'typescript',
    'function f(): void {\n  a();\n  const v = base\n  b();\n}\n', 'function f(): void {\n  a();\n  const v = base\n  log(v);\n  b();\n}\n', 'function f(): void {\n  a();\n  const v = base ?? extra\n  b();\n}\n'],
];

for (const [name, language, oldText, newText, base] of T1_PROBES) {
  test(`Т1 ${name} — laid, and said to stand in the middle of a line`, async () => {
    await saysLineEdge(language, generated(oldText, newText), base);
  });
}

test('Т1 C.1 cpp: an insertion after `b();`, upstream appended `// NOLINT` — laid, no word', async () => {
  await saysNothing('cpp', generated(fn('  b();\n'), fn('  b();\n  n();\n')), fn('  b();  // NOLINT\n'));
});

test('Т1 C.2 python: an insertion after `b()`, upstream appended `# noqa` — laid, no word', async () => {
  await saysNothing(
    'python',
    generated('def f():\n    a()\n    b()\n    c()\n', 'def f():\n    a()\n    b()\n    n()\n    c()\n'),
    'def f():\n    a()\n    b()  # noqa\n    c()\n',
  );
});

test('Т1 R.12 python: upstream joined a list to one line — refused: the indentation of the items is part of the pattern', async () => {
  await landsAs('python', generated('X = [\n    "a",\n    "b",\n]\n', 'X = [\n    "a",\n    "n",\n    "b",\n]\n'), 'X = ["a", "b"]\n', REFUSED);
});

test('Т1 H.1 css by hand: `color: red;` does not land in `background-color: red;`', async () => {
  await saysLineEdge('css', hand('css', '...\n.f {\n...\n  color: red;\n>>>\n...', '\n  n: 1;'), '.f {\n  a: 1;\n  background-color: red;\n  b: 2;\n}\n');
});

test('Т1 H.2 cpp by hand: `cancel();` is not replaced inside `other.cancel();`', async () => {
  await saysLineEdge('cpp', hand('cpp', '...\nvoid f() {\n...\n>>>\n  cancel();\n<<<\n...', '  stop();'), fn('  other.cancel();\n'));
});

test('Т1 H.3 cpp by hand: `b();` does not land in `// b();`', async () => {
  await saysLineEdge('cpp', hand('cpp', '...\nvoid f() {\n...\n  b();\n>>>\n...', '\n  n();'), fn('  // b();\n'));
});

test('Т1 H.4 python by hand: `value = base` does not land in `value = base + extra`', async () => {
  await saysLineEdge('python', hand('python', '...\ndef f(x):\n...\n    value = base\n>>>\n...', '\n    log(value)'), 'def f(x):\n    a = 1\n    value = base + extra\n    return a\n');
});

test('Т1 H.5 cpp by hand: upstream appended `// NOLINT` — the insertion lands after it', async () => {
  await saysNothing('cpp', hand('cpp', '...\nvoid f() {\n...\n  b();\n>>>\n...', '\n  n();'), fn('  b();  // NOLINT\n'));
});

test('Т1 H.9 css by hand, a rule on one line: `... color: red;` does not land in `background-color`', { todo: '12 Л3' }, async () => {
  await landsAs('css', hand('css', '...\n.f { ... color: red; >>> ... }\n...', ' n: 1;'), '.f { a: 1; background-color: red; b: 2; }\n', REFUSED);
});

test('Т1 javascript by hand: `... cancel();` does not land in `$cancel();`', { todo: '12 Л3' }, async () => {
  await landsAs('javascript', hand('javascript', '...\nfunction f() { ... cancel(); >>> ... }\n...', ' n();'), 'function f() { a(); $cancel(); b(); }\n', REFUSED);
});

function reindent(text: string, from: number, to: number): string {
  return text.replace(/^( +)/gm, (s) => ' '.repeat((s.length / from) * to));
}

const REINDENTED: [string, string, string, string][] = [
  ['a `return` appended inside an `if`', 'python',
    'def f(x):\n  if x:\n    a(x)\n  b(x)\n', 'def f(x):\n  if x:\n    a(x)\n    return x\n  b(x)\n'],
  ['a guard inserted in a function', 'python',
    'def load(path):\n  data = read(path)\n  check(data)\n  return data\n', 'def load(path):\n  data = read(path)\n  check(data)\n  if not data:\n    return None\n  return data\n'],
  ['a line inserted in a method', 'python',
    'class K:\n  def f(self):\n    self.a()\n    self.b()\n\n  def g(self):\n    pass\n', 'class K:\n  def f(self):\n    self.a()\n    self.n()\n    self.b()\n\n  def g(self):\n    pass\n'],
  ['a line inserted three blocks deep', 'python',
    'def f(xs):\n  for x in xs:\n    if x:\n      a(x)\n      b(x)\n', 'def f(xs):\n  for x in xs:\n    if x:\n      a(x)\n      n(x)\n      b(x)\n'],
  ['a key inserted in a nested mapping', 'yaml',
    'a:\n  b:\n    c: 1\n    d: 2\n  e: 3\n', 'a:\n  b:\n    c: 1\n    n: 9\n    d: 2\n  e: 3\n'],
];

const REINDENT_TODO = new Set(['a `return` appended inside an `if`', 'a guard inserted in a function']);

for (const [what, language, oldText, newText] of REINDENTED) {
  test(`Т4 ${language}: ${what}, upstream re-indented the file 2 → 4 — the payload follows`, { todo: REINDENT_TODO.has(what) ? '12 Л8: level of another line / nested lines' : false }, async () => {
    await landsAs(language, generated(oldText, newText), reindent(oldText, 2, 4), reindent(newText, 2, 4));
  });
}

test('Т4 python: a line inserted, upstream re-indented the file 4 → 2 — the payload follows', { todo: '12 Л8: the pattern line is wider than the file line' }, async () => {
  const oldText = 'def f(x):\n    if x:\n        a(x)\n        b(x)\n';
  const newText = 'def f(x):\n    if x:\n        a(x)\n        n(x)\n        b(x)\n';
  await landsAs('python', generated(oldText, newText), reindent(oldText, 4, 2), reindent(newText, 4, 2));
});

test('Т4 L8 python by hand: upstream wrapped the body in `if` — the payload goes in with it', async () => {
  await landsAs(
    'python',
    hand('python', '...\ndef f(x):\n...\n    a(x)\n>>>\n...', '\n    NEW(x)'),
    'def f(x):\n    if x:\n        a(x)\n        b(x)\n',
    'def f(x):\n    if x:\n        a(x)\n        NEW(x)\n        b(x)\n',
  );
});

test('Т4 L8 python by hand: an anchor written at 2 in a file at 4 — the payload is not moved off', async () => {
  await landsAs('python', hand('python', '...\ndef f(x):\n...\n  a(x)\n>>>\n...', '\n    NEW(x)'), 'def f(x):\n    a(x)\n    b(x)\n', 'def f(x):\n    a(x)\n    NEW(x)\n    b(x)\n');
});

test('Т4 L8 python by hand: an anchor written at column 0 — the payload is not moved off', async () => {
  await landsAs('python', hand('python', '...\ndef f(x):\n...\na(x)\n>>>\n...', '\n    NEW(x)'), 'def f(x):\n    a(x)\n    b(x)\n', 'def f(x):\n    a(x)\n    NEW(x)\n    b(x)\n');
});

test('Т4 L8 python: upstream wrapped the body in `if` — an insertion after a line follows it in', async () => {
  await landsAs(
    'python',
    generated('def f(x):\n    a(x)\n    b(x)\n', 'def f(x):\n    a(x)\n    NEW(x)\n    b(x)\n'),
    'def f(x):\n    if x:\n        a(x)\n        b(x)\n',
    'def f(x):\n    if x:\n        a(x)\n        NEW(x)\n        b(x)\n',
  );
});

test('Т4 L8 python: upstream wrapped the body in `if` — an insertion before a line follows it in, and the line keeps its own', async () => {
  const patch = hand('python', '...\ndef f(x):\n...\n>>>\nb(x)\n...', 'NEW(x)\n    ');
  await landsAs('python', patch, 'def f(x):\n    if x:\n        a(x)\n        b(x)\n', 'def f(x):\n    if x:\n        a(x)\n        NEW(x)\n        b(x)\n');
});

test('Т4 L8 python: upstream indented the file by 4, not 2 — the inserted line follows the file', async () => {
  await landsAs(
    'python',
    generated('def f(x):\n  a(x)\n  b(x)\n', 'def f(x):\n  a(x)\n  NEW(x)\n  b(x)\n'),
    'def f(x):\n    a(x)\n    b(x)\n',
    'def f(x):\n    a(x)\n    NEW(x)\n    b(x)\n',
  );
});

test('Т4 L8 python: upstream wrapped only the line above — a closer below keeps the insertion at the block\'s level', async () => {
  await landsAs(
    'python',
    generated('def f(x):\n    a(x)\n    b(x)\ndef g():\n    pass\n', 'def f(x):\n    a(x)\n    b(x)\n    NEW(x)\ndef g():\n    pass\n'),
    'def f(x):\n    if x:\n        a(x)\n    b(x)\ndef g():\n    pass\n',
    'def f(x):\n    if x:\n        a(x)\n    b(x)\n    NEW(x)\ndef g():\n    pass\n',
  );
});

test('Т4 L8 yaml: upstream nested the mapping one level deeper — an inserted key follows', async () => {
  await landsAs(
    'yaml',
    generated('a:\n  b: 1\n  c: 2\n', 'a:\n  b: 1\n  n: 9\n  c: 2\n'),
    'top:\n  a:\n    b: 1\n    c: 2\n',
    'top:\n  a:\n    b: 1\n    n: 9\n    c: 2\n',
  );
});

test('Т4 L8 cpp: the indentation of a brace language is no structure — the payload keeps its own', async () => {
  await landsAs(
    'cpp',
    generated('void f() {\n  a();\n  b();\n}\n', 'void f() {\n  a();\n  n();\n  b();\n}\n'),
    'void f() {\n      a();\n      b();\n}\n',
    'void f() {\n      a();\n  n();\n      b();\n}\n',
  );
});

test('Т4 L8 python: the patch laid on its own base is not moved', async () => {
  const oldText = 'def f(x):\n    if x:\n        a(x)\n        b(x)\n';
  const newText = 'def f(x):\n    if x:\n        a(x)\n        n(x)\n        b(x)\n';
  await landsAs('python', generated(oldText, newText), oldText, newText);
});

test('Т4 L8 python: a payload deeper than the line it stands by, nested lines — moved, and the hunk says its inner lines kept their depth', async () => {
  const oldText = 'def f(x):\n    a(x)\n    b(x)\n';
  const newText = 'def f(x):\n    a(x)\n    if x:\n        n(x)\n    b(x)\n';
  const notes = await notesOf('python', generated(oldText, newText), 'def f(x):\n    if x:\n        a(x)\n        b(x)\n');
  assert.deepEqual(notes.map((n) => n.reason), ['indent']);
});

const SEP = hand('python', '...\nX = [\n... ,\n>>>\n]\n...', '\n    "c",', 3);

test('Т4 L9 python by hand: the last item upstream wrote has no comma — refused, not glued', { todo: '12 Л9' }, async () => {
  await landsAs('python', SEP, 'X = [\n    "a",\n    "d"\n]\n', REFUSED);
});

test('Т4 L9 python by hand: the last item has its comma — lands after it', { todo: '12 Л9' }, async () => {
  await landsAs('python', SEP, 'X = [\n    "a",\n    "d",\n]\n', 'X = [\n    "a",\n    "d",\n    "c",\n]\n');
});

const PY_SHAPES: [string, (n: string, extra: string) => string][] = [
  ['class > def > if', (n, x) => `class ${n}:\n    def run(self, ctx):\n        if ctx.on:\n            step1()\n            step2()\n${x}\n\n`],
  ['class > def', (n, x) => `class ${n}:\n    def run(self, ctx):\n        step1()\n        step2()\n${x}\n\n`],
  ['def > for > if', (n, x) => `def ${n.toLowerCase()}(ctx):\n    for item in ctx:\n        if item.on:\n            step1(item)\n            step2(item)\n${x}\n\n`],
];
const PY_ADDED: Record<string, string> = { 'class > def > if': '            NEW()\n', 'class > def': '        NEW()\n', 'def > for > if': '            NEW(item)\n' };

for (const [shape, unit] of PY_SHAPES) {
  const add = PY_ADDED[shape]!;
  const patch = generated(unit('G1', '') + unit('G2', '') + unit('G3', ''), unit('G1', '') + unit('G2', add) + unit('G3', ''));
  for (const [drift, base, want] of [
    ['moved first', unit('G2', '') + unit('G1', '') + unit('G3', ''), unit('G2', add) + unit('G1', '') + unit('G3', '')],
    ['a new one after it', unit('G1', '') + unit('G2', '') + unit('G9', '') + unit('G3', ''), unit('G1', '') + unit('G2', add) + unit('G9', '') + unit('G3', '')],
    ['no drift', unit('G1', '') + unit('G2', '') + unit('G3', ''), unit('G1', '') + unit('G2', add) + unit('G3', '')],
  ] as const) {
    test(`Т2-1 python ${shape}, ${drift}: the unit the pattern names, or a refusal — never another`, async () => {
      if (drift === 'no drift') await landsAs('python', patch, base, want);
      else await landsRightOrRefuses('python', patch, base, want);
    });
  }
}

const PY = TUNE_SYNTAX['python']!;
const T2_DRIFTS = ['move', 'move-first', 'swap-prev', 'swap-next', 'next-new'] as const;

for (const depth of [1, 2]) {
  for (const regime of ['repeat', 'clone'] as const) {
    const model = tuneModel({ units: 8, depth, regime, at: 'end' });
    const patch = generated(tuneRender(PY, model, false), tuneRender(PY, model, true));
    test(`Т2-2 python d${depth} ${regime}, the change at the end of a unit: the pattern names its own class`, async () => {
      const a = adapterForLanguage('python');
      await a.init();
      const own = /^class \S+:$/m.exec(tuneRender(PY, model, true).split('newPath')[0]!.split('\n').reverse().join('\n'));
      const literals = patch(a).hunks.flatMap((h) => h.match.steps.flatMap((st) => (st.anchor.target === 'literal' ? [st.anchor.literal.raw.trim()] : [])));
      assert.ok(own !== null && literals.includes(own[0]), `${own?.[0]} in ${literals.join(' | ')}`);
    });
    for (const drift of T2_DRIFTS) {
      test(`Т2-2 python d${depth} ${regime}, ${drift}: its own class, or a refusal — never another`, async () => {
        const moved = TUNE_DRIFTS[drift]!(model, PY)!;
        await landsRightOrRefuses('python', patch, tuneRender(PY, moved, false), tuneRender(PY, moved, true));
      });
    }
  }
}

const pyUnit = (n: string, body: string): string => `class ${n}:\n    def run(self, ctx):\n        if ctx.on:\n            step1()\n            step2()\n${body}\n\n`;
const PY_ADD = '            NEW()\n';
const PY_DRIFTS: [string, string, string][] = [
  ['the class moved first', pyUnit('G2', '') + pyUnit('G1', '') + pyUnit('G3', ''), pyUnit('G2', PY_ADD) + pyUnit('G1', '') + pyUnit('G3', '')],
  ['the class swapped with the next', pyUnit('G1', '') + pyUnit('G3', '') + pyUnit('G2', ''), pyUnit('G1', '') + pyUnit('G3', '') + pyUnit('G2', PY_ADD)],
  ['a new class after it', pyUnit('G1', '') + pyUnit('G2', '') + pyUnit('G9', '') + pyUnit('G3', ''), pyUnit('G1', '') + pyUnit('G2', PY_ADD) + pyUnit('G9', '') + pyUnit('G3', '')],
  ['no drift', pyUnit('G1', '') + pyUnit('G2', '') + pyUnit('G3', ''), pyUnit('G1', '') + pyUnit('G2', PY_ADD) + pyUnit('G3', '')],
];

for (const [drift, base, want] of PY_DRIFTS) {
  test(`Т2 python by hand, \`$$$\` closes the block: ${drift} — lands in its class`, { todo: '12 Л5' }, async () => {
    await landsAs('python', hand('python', '...\nclass G2:\n...\n            step2()\n>>>\n...\n$$$\n...', '\n            NEW()', 3), base, want);
  });
}

test('Т2 cpp by hand: `$$$` in place of `}`', { todo: '12 Л5' }, async () => {
  const f = (n: string, body: string): string => `void ${n}() {\n  a();\n${body}}\n\n`;
  await landsAs('cpp', hand('cpp', '...\nvoid g() {\n...\n>>>\n$$$\n...', '  NEW();\n', 3), f('f', '') + f('g', '') + f('h', ''), f('f', '') + f('g', '  NEW();\n') + f('h', ''));
});

test('Т2 yaml by hand: `$$$` in place of the next key — the key moved first', { todo: '12 Л4, Л5' }, async () => {
  const y = (n: string, body: string): string => `${n}:\n  a: 1\n  b: 2\n${body}`;
  await landsAs('yaml', hand('yaml', '...\ng2:\n...\n  b: 2\n>>>\n...\n$$$\n...', '\n  n: 9', 3), y('g2', '') + y('g1', '') + y('g3', ''), y('g2', '  n: 9\n') + y('g1', '') + y('g3', ''));
});

for (const [drift, base, want] of PY_DRIFTS) {
  test(`guard: python by hand, the next class as the lower bound: ${drift} — right or refused`, async () => {
    await landsRightOrRefuses('python', hand('python', '...\nclass G2:\n...\n            step2()\n>>>\n...\nclass G3:\n...', '\n            NEW()'), base, want);
  });
}

const LEGIT_TWICE: [string, string, string, string][] = [
  ['cpp', 'void f() {\n  tick();\n%%  done();\n}\n', '  tick();\n', '\nvoid g() {\n  a();\n}\n'],
  ['java', 'class K {\n  void f() {\n    tick();\n%%    done();\n  }\n}\n', '    tick();\n', '\nclass L {\n}\n'],
  ['python', 'def f():\n    tick()\n%%    done()\n', '    tick()\n', '\n\ndef g():\n    a()\n'],
  ['javascript', 'function f() {\n  tick();\n%%  done();\n}\n', '  tick();\n', '\nfunction g() {\n  a();\n}\n'],
  ['go', 'package p\n\nfunc f() {\n\ttick()\n%%\tdone()\n}\n', '\ttick()\n', '\nfunc g() {\n\ta()\n}\n'],
  ['yaml', 'steps:\n  - tick\n%%  - done\n', '  - tick\n', 'other: 1\n'],
  ['shell', 'f() {\n  tick\n%%  done\n}\n', '  tick\n', '\ng() {\n  a\n}\n'],
];

for (const [language, tpl, line, tail] of LEGIT_TWICE) {
  test(`guard: ${language}, a second line like the one before it — laid, not taken for "already there"`, async () => {
    const patch = generated(tpl.replace('%%', ''), tpl.replace('%%', line));
    await landsAs(language, patch, tpl.replace('%%', '') + tail, tpl.replace('%%', line) + tail);
    assert.deepEqual(await verdictOn(language, patch, tpl.replace('%%', '') + tail, tpl.replace('%%', '')), { kind: 'clear' });
  });
}

test('guard: cpp by hand, a second `work();` at the end of the block (`cpp/generate/67`) — laid', async () => {
  const got = await laid('cpp', hand('cpp', '...\nif (\n...\n) {\n...\n>>>\n}\n...', '    work();\n'), 'void f() {\n  if (a) {\n    work();\n  }\n}\n');
  assert.ok(typeof got === 'string', `refused: ${String(got)}`);
  assert.equal(got.split('work();').length - 1, 2);
});

test('guard: the inserted line already stands in another function — laid in its own', async () => {
  const other = 'void g() {\n  a();\n  NEW();\n  b();\n}\n';
  const f = (body: string): string => `void f() {\n  a();\n${body}  b();\n}\n`;
  await landsAs('cpp', generated(f('') + other, f('  NEW();\n') + other), `${f('')}${other}\nvoid h() {\n}\n`, `${f('  NEW();\n')}${other}\nvoid h() {\n}\n`);
});

const ROBUST: [string, string, string, string, string, string][] = [
  ['R.1 a call split over two lines', 'cpp', fn('  Call(one, two);\n'), fn('  Call(one, two);\n  n();\n'), fn('  Call(one,\n       two);\n'), fn('  Call(one,\n       two);\n  n();\n')],
  ['R.2 two lines of a call joined', 'cpp', fn('  Call(one,\n       two);\n'), fn('  Call(one,\n       two);\n  n();\n'), fn('  Call(one, two);\n'), fn('  Call(one, two);\n  n();\n')],
  ['R.3 a replaced statement rewrapped', 'cpp', fn('  int v = Compute(one, two);\n'), fn('  int v = Compute(one, three);\n'), fn('  int v =\n      Compute(one, two);\n'), fn('  int v = Compute(one, three);\n')],
  ['R.4 `> >` became `>>`', 'cpp', fn('  std::vector<std::vector<int> > v;\n'), fn('  std::vector<std::vector<int> > v;\n  n();\n'), fn('  std::vector<std::vector<int>> v;\n'), fn('  std::vector<std::vector<int>> v;\n  n();\n')],
  ['R.5 `g(x,y)` became `g(x, y)`', 'cpp', fn('  g(x,y);\n'), fn('  g(x,y);\n  n();\n'), fn('  g(x, y);\n'), fn('  g(x, y);\n  n();\n')],
  ['R.6 the last key replaced, upstream appended one', 'json', '{\n  "a": 1,\n  "b": 2\n}\n', '{\n  "a": 1,\n  "b": 3\n}\n', '{\n  "a": 1,\n  "b": 2,\n  "d": 4\n}\n', '{\n  "a": 1,\n  "b": 3,\n  "d": 4\n}\n'],
  ['R.7 the closer of a class is `};`', 'cpp', 'class K {\n  void a();\n};\n', 'class K {\n  void a();\n  void n();\n};\n', 'class K {\n  void a();\n  void b();\n};\n', 'class K {\n  void a();\n  void b();\n  void n();\n};\n'],
  ['R.11 the arguments of a header rewrapped', 'cpp', 'void f(int a, int b) {\n  x();\n}\n', 'void f(int a, int b) {\n  x();\n  n();\n}\n', 'void f(int a,\n       int b) {\n  x();\n}\n', 'void f(int a,\n       int b) {\n  x();\n  n();\n}\n'],
  ['C.3 a replaced line, upstream appended `// NOLINT`', 'cpp', fn('  b();\n'), fn('  B();\n'), fn('  b();  // NOLINT\n'), fn('  B();  // NOLINT\n')],
];

for (const [name, language, oldText, newText, base, want] of ROBUST) {
  test(`guard: ${language} ${name} — lands right`, async () => {
    await landsAs(language, generated(oldText, newText), base, want);
  });
}

test('guard: cpp R.8 the body joined to one line — lands in f, g untouched', async () => {
  const got = await laid('cpp', generated('void f() {\n  a();\n}\nvoid g() {}\n', 'void f() {\n  a();\n  n();\n}\nvoid g() {}\n'), 'void f() { a(); }\nvoid g() {}\n');
  assert.ok(typeof got === 'string', `refused: ${String(got)}`);
  assert.match(got, /^void f\(\) \{ a\(\);\s+n\(\);\s*\}\nvoid g\(\) \{\}\n$/);
});

const T1_REFUSED: [string, string, string, string, string][] = [
  ['T1.3 css, a rule on one line: `color: red;` replaced, upstream has `background-color: red;`', 'css',
    '.f { a: 1; color: red; b: 2; }\n.g { x: 1; }\n', '.f { a: 1; color: blue; b: 2; }\n.g { x: 1; }\n', '.f { a: 1; background-color: red; b: 2; }\n.g { x: 1; }\n'],
  ['T1.14 shell: an insertion after `rm -rf "$dir"`, upstream has `"$tmp-dir"`', 'shell',
    'f() {\n  a\n  rm -rf "$dir"\n  b\n}\n', 'f() {\n  a\n  rm -rf "$dir"\n  n\n  b\n}\n', 'f() {\n  a\n  rm -rf "$tmp-dir"\n  b\n}\n'],
  ['toml: an insertion after `name = "x"`, upstream has `alt_name = "x"`', 'toml',
    '[a]\nk = 1\nname = "x"\nz = 2\n', '[a]\nk = 1\nname = "x"\nn = 9\nz = 2\n', '[a]\nk = 1\nalt_name = "x"\nz = 2\n'],
  ['text: an insertion after `limit 10`, upstream has `limit 100`', 'text',
    'section {\n  first\n  limit 10\n  last\n}\n', 'section {\n  first\n  limit 10\n  added\n  last\n}\n', 'section {\n  first\n  limit 100\n  last\n}\n'],
];

for (const [name, language, oldText, newText, base] of T1_REFUSED) {
  test(`guard: ${name} — refused`, async () => {
    await landsAs(language, generated(oldText, newText), base, REFUSED);
  });
}

test('guard: cpp T1.13 `b();` inside `/* */` in the middle of a line — refused', async () => {
  await landsAs(
    'cpp',
    generated('void f() {\n  run(); b(); done();\n}\n', 'void f() {\n  run(); b(); n(); done();\n}\n'),
    'void f() {\n  run(); /* b(); */ done();\n}\n',
    REFUSED,
  );
});

test("guard: cpp H.6 by hand, the header in the generator's form `void f(` / `...` / `) {` — lands", async () => {
  await landsAs('cpp', hand('cpp', '...\nvoid f(\n...\n) {\n...\n>>>\n}\n...', '  n();\n'), 'void f(int a) {\n  x();\n}\n', 'void f(int a) {\n  x();\n  n();\n}\n');
});

test('guard: typescript H.8 by hand, a fragment of a line after `...` — lands', async () => {
  await landsAs('typescript', hand('typescript', '... function g() {\n...\n>>>\n}\n...', '  n();\n'), 'export function g() {\n  x();\n}\n', 'export function g() {\n  x();\n  n();\n}\n');
});
