import { test } from 'node:test';
import assert from 'node:assert/strict';

import { adapterForLanguage } from '../../src/lang/adapter.ts';
import { applyAll } from '../../src/core/apply.ts';
import { MatchError, AmbiguityError } from '../../src/core/errors.ts';
import { loadGrammar, parse } from '../../src/lang/treesitter.ts';
import { resolveGrammar } from '../../src/infra/grammar-store.ts';
import type { GrammarAdapter } from '../../src/lang/make-adapter.ts';
import type { SourceMap } from '../../src/lang/source-map.ts';
import { patchOf } from '../matrix.ts';

const method = (cls: string, head: string, start: string): string =>
  `void ${cls}::OnLoad(Frame* frame) {\n${head}\n    ${start}\n    Notify(frame);\n  }\n}\n`;
const IF = '  if (frame->IsMain()) {';
const IF_PP = '#if BUILDFLAG(IS_ANDROID)\n  if (frame->IsMain() && frame->IsVisible()) {\n#else\n  if (frame->IsMain()) {\n#endif';
const file = (foo: string, bar: string): string => `#include "ui/foo.h"\n\n${foo}\n${bar}`;
const BAR = method('Bar', IF, 'tracker_.Start();');

const CLEAN = file(method('Foo', IF, 'tracker_.Start();'), BAR);
const RENAMED = file(method('Foo', IF, 'tracker_.Begin();'), BAR);
const SPLIT = file(method('Foo', IF_PP, 'tracker_.Begin();'), BAR);

const lineOf = (src: string, at: number): number => src.slice(0, at).split('\n').length;

function braces(map: SourceMap, src: string): string[] {
  return map
    .blocksWithin(0, map.eof)
    .map((s) => ({ open: map.toOriginalPos(s.open, 'right'), close: map.toOriginalPos(s.close, 'right') }))
    .filter((s) => src[s.open] === '{')
    .map((s) => `{${lineOf(src, s.open)}…${lineOf(src, s.close)}}`);
}

const cpp = async (): Promise<GrammarAdapter> => {
  const a = adapterForLanguage('cpp') as GrammarAdapter;
  await a.init();
  return a;
};

test('Т3 cpp: written for two builds, the function holds three `{` and two `}`', () => {
  const foo = method('Foo', IF_PP, 'tracker_.Begin();');
  const count = (c: string): number => foo.split(c).length - 1;
  assert.equal(count('{'), 3);
  assert.equal(count('}'), 2, 'one `}` closes whichever `if` the build keeps');
  const plain = method('Foo', IF, 'tracker_.Begin();');
  assert.equal(plain.split('{').length, plain.split('}').length);
});

test('Т3 cpp: the grammar cannot read it — the function is an ERROR node, its head loose tokens', async () => {
  const a = await cpp();
  const lang = await loadGrammar('map-damage-cpp', await resolveGrammar(a.grammar, 'cpp'));
  const kinds = (src: string): string[] => {
    const tree = parse(lang, src);
    const out = [...Array(tree.rootNode.childCount).keys()].map((i) => tree.rootNode.child(i)!.type);
    tree.delete();
    return out;
  };
  assert.deepEqual(kinds(RENAMED), ['preproc_include', 'function_definition', 'function_definition']);
  assert.deepEqual(kinds(SPLIT), ['preproc_include', 'ERROR']);
  const tree = parse(lang, SPLIT);
  const error = tree.rootNode.child(1)!;
  const inside = [...Array(error.childCount).keys()].map((i) => error.child(i)!.type);
  assert.ok(inside.includes('function_declarator') && inside.includes('{') && inside.includes('if_statement'));
  assert.ok(!inside.includes('compound_statement'));
  tree.delete();
});

test('Т3 cpp: whole, the map holds the block of every function and of its `if`', async () => {
  const a = await cpp();
  assert.deepEqual(braces(a.buildMap(RENAMED), RENAMED), ['{3…8}', '{4…7}', '{10…15}', '{11…14}']);
});

test('Т3 cpp: the other function is whole in the same file — only the damaged unit is lost', async () => {
  const a = await cpp();
  const blocks = braces(a.buildMap(SPLIT), SPLIT);
  assert.ok(blocks.includes('{14…19}') && blocks.includes('{15…18}'));
});

test('Т3 cpp: with the two builds, the map holds the block of Foo, and the `if` ends at its own `}`', async () => {
  const a = await cpp();
  assert.deepEqual(braces(a.buildMap(SPLIT), SPLIT), ['{3…12}', '{5…11}', '{14…19}', '{15…18}']);
});

const tu = (n: string, e: string, b: string): string => `section ${n} {\n${e}  when on {\n${b}  }\n}\n`;
const SECTIONS = (extra: string): string => `${tu('f', extra, '    alpha2\n    beta\n')}\n${tu('g', '', '    alpha\n    beta\n')}`;

test('Т3 text: whole, the map holds the blocks of both sections and of their `when`', async () => {
  const a = adapterForLanguage('text');
  await a.init();
  const src = SECTIONS('');
  assert.deepEqual(braces(a.buildMap(src), src), ['{1…6}', '{2…5}', '{8…13}', '{9…12}']);
});

test('Т3 text: a `(` with no pair is dropped, and the closers after it reach their openers', async () => {
  const a = adapterForLanguage('text');
  await a.init();
  const src = SECTIONS('  see (note\n');
  assert.deepEqual(braces(a.buildMap(src), src), ['{1…7}', '{3…6}', '{9…14}', '{10…13}']);
});

async function hookOn(base: string): Promise<{ landedIn: string } | { refused: Error }> {
  const a = await cpp();
  const patch = patchOf(CLEAN, file(method('Foo', IF, 'tracker_.Start();').replace('    Notify', '    BRAVE_HOOK(frame);\n    Notify'), BAR), a);
  try {
    const out = applyAll(base, patch, a).source.split('\n');
    const at = out.findIndex((l) => l.includes('BRAVE_HOOK'));
    return { landedIn: [...out.slice(0, at)].reverse().find((l) => /^void /.test(l))! };
  } catch (e) {
    if (e instanceof MatchError || e instanceof AmbiguityError) return { refused: e };
    throw e;
  }
}

test('Т3 cpp: on the clean base the hook lands in Foo', async () => {
  assert.deepEqual(await hookOn(CLEAN), { landedIn: 'void Foo::OnLoad(Frame* frame) {' });
});

test('Т3 cpp: upstream renamed the call in Foo — refused: the target is not there', async () => {
  const got = await hookOn(RENAMED);
  assert.ok('refused' in got, `landed: ${JSON.stringify(got)}`);
});

test('Т3 cpp: the same rename, and `#if/#else` in Foo — the hook does not go to Bar::OnLoad', async () => {
  const got = await hookOn(SPLIT);
  assert.ok('refused' in got, `landed: ${JSON.stringify(got)}`);
});

test('Т3 cpp: the target kept, and `#if/#else` in Foo — it lands in Foo, not refused as ambiguous', async () => {
  const kept = file(method('Foo', IF_PP, 'tracker_.Start();'), BAR);
  assert.deepEqual(await hookOn(kept), { landedIn: 'void Foo::OnLoad(Frame* frame) {' });
});

test('Т3 text: a closer with no opener of its kind is passed by, as before (`1)`, `:)`)', async () => {
  const a = adapterForLanguage('text');
  await a.init();
  const src = 'section f {\n  smile :)\n  count 1)\n  when on {\n    alpha\n  }\n}\n';
  assert.deepEqual(braces(a.buildMap(src), src), ['{1…7}', '{4…6}']);
});

test('Т3 text: several strays in one section are all dropped', async () => {
  const a = adapterForLanguage('text');
  await a.init();
  const src = 'section f {\n  see (a [b\n  when on {\n    alpha\n  }\n}\nsection g {\n}\n';
  assert.deepEqual(braces(a.buildMap(src), src), ['{1…6}', '{3…5}', '{7…8}']);
});

test('Т3 text: a stray `(` closed at last by a `)` of its own — the pair is the one that was meant', async () => {
  const a = adapterForLanguage('text');
  await a.init();
  const src = 'section f {\n  see (note\n  when on {\n  }\n}\nsection g {\n  (x)\n}\n';
  const blocks = braces(a.buildMap(src), src);
  assert.deepEqual(blocks, ['{1…5}', '{3…4}', '{6…8}']);
});

const shellBlocks = async (src: string): Promise<string[]> => {
  const a = adapterForLanguage('shell');
  await a.init();
  return braces(a.buildMap(src), src);
};
const FG = (heredoc: string): string => `f() {\n${heredoc}  echo a\n}\ng() {\n  echo b\n}\n`;

test('Т3 shell: a `{` in a here-document is no block — the function holds, the next one is its own', async () => {
  const blocks = await shellBlocks(FG('  cat <<EOF\n  {\nEOF\n'));
  assert.deepEqual(blocks, ['{1…6}', '{7…9}']);
});

test('Т3 shell: `<<-WORD` ends at an indented WORD, `<<\'WORD\'` and `<<"WORD"` open as well', async () => {
  assert.deepEqual(await shellBlocks(FG('\tcat <<-EOF\n\t{\n\tEOF\n')), ['{1…6}', '{7…9}']);
  assert.deepEqual(await shellBlocks(FG("  cat <<'END'\n  (\nEND\n")), ['{1…6}', '{7…9}']);
  assert.deepEqual(await shellBlocks(FG('  cat <<"END"\n  {\nEND\n')), ['{1…6}', '{7…9}']);
});

test('Т3 shell: the shift in `$(( 1 << n ))` and the here-string `<<<` are no here-document', async () => {
  assert.deepEqual((await shellBlocks(FG('  x=$(( 1 << n ))\n'))).filter((b) => b.startsWith('{')), ['{1…4}', '{5…7}']);
  assert.deepEqual((await shellBlocks(FG('  cat <<< "x ("\n'))).filter((b) => b.startsWith('{')), ['{1…4}', '{5…7}']);
});

test('Т3 shell: the here-document changes nothing about how the file is matched — its whitespace reads as before', async () => {
  const a = adapterForLanguage('shell');
  await a.init();
  const plain = FG('  cat <<EOF\n  a   b\nEOF\n');
  assert.equal(a.buildMap(plain).source, plain);
  assert.equal(a.normalize('  a   b'), a.normalize('  a b'));
});
