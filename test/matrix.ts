// The test matrix of a language — docs/10-brave-languages.md, "Матрица тестов языка".
//
// One harness, a fixture per language (`test/unit/<language>/<language>-fixture.ts`, run
// by `<language>-matrix.test.ts`).
// A fixture renders a small file from slots: an outer named block, the target block the
// change is made in, what stands around it. A row of the matrix is a change of the slots
// — what upstream did to the file after the patch was written — and its oracle:
//
//   К — the patch, generated from `old` → `new`, applied to T(old) gives T(new);
//   С — it refuses loudly (MatchError, AmbiguityError), or lands where it must, never
//       elsewhere; a limitation is held as it stands, so a change of it is seen.
//
// Every row first checks that its case happened at all — a precondition (docs/10, 7.10):
// a rename the pattern never sees, a comment behind a `...`, a string the pattern does
// not hold would pass for nothing. A row whose case did not happen fails as such.
// And no row applies a patch to the file it was made from: `synthesize` checks that much
// itself (7.1).
//
// Nothing here knows a language: what a statement, a comment or a literal looks like is
// the fixture's.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { synthesize, sameIgnoringSpace } from '../src/generate/synth.ts';
import { printSirFile } from '../src/generate/printer.ts';
import { parseSirFile } from '../src/core/sir-parser.ts';
import { applyAll } from '../src/core/apply.ts';
import { AmbiguityError, MatchError, SynthesisError } from '../src/core/errors.ts';
import { adapterForLanguage } from '../src/lang/adapter.ts';
import type { LanguageAdapter } from '../src/lang/source-map.ts';
import type { SirFile } from '../src/core/ast.ts';
import { sirMd } from './helpers.ts';

export interface Slots {
  /** the name of the block around the target */
  outer: string;
  /** lines right after the first lines of the file (an include, an import) */
  top: string;
  /** declarations before the target, at its level */
  above: string;
  /** declarations after the target, at its level */
  below: string;
  /** the end of the file, after the outer block */
  bottom: string;
  /** lines opening the target's body, before `edit` */
  inner: string;
  /** the lines of the target's body the change is made in */
  edit: string;
  /** the target is there at all */
  target: boolean;
  /** the target stands twice, word for word */
  twice: boolean;
}

export interface Fixture {
  /** the name the adapter answers to */
  language: string;
  /** the word in the target's header that names it — a copy of the target with this word
   *  changed is another block of the same shape (`int Target(` → `int Target7(`) */
  targetName: string;
  /** the file, with every slot in its place; an empty slot leaves an empty line or none */
  render(s: Slots): string;
  /** the indentation of a statement in the target's body */
  indent: string;
  /** a statement calling `name` with `arg` — unindented, one line */
  stmt(name: string, arg: string): string;
  /** a declaration at the level of the target, named `name`, ending in a newline or not */
  decl(name: string): string;
  /** a line upstream may add at the top of a file */
  topLine: string;
  /** a declaration after the outer block */
  tail: string;
  /** a line comment saying `text` — unindented */
  comment(text: string): string;
  /** a statement holding the string literal `"<text>"` (the quotes are the fixture's) */
  str(text: string): string;
  /** the lines of a multi-line literal in a statement, the second holding `text`;
   *  undefined where the language has no literal over lines */
  multiline?: ((text: string) => string[]) | undefined;
  /** a line the grammar cannot read, as it may stand in a body (a macro, a half edit) */
  broken: string;
  /** the leading indentation of a line is part of an anchor (Python): a reindented file
   *  is refused, not met — README, "Пробелы между литералами" */
  indentIsSyntax?: boolean | undefined;
  /** a whole file on one line, `edited` or not; `drifted` — upstream added one more unit
   *  at its end. Undefined where a language has no such form (Python) */
  minified?: ((edited: boolean, drifted?: boolean) => string) | undefined;
  /** rows of the matrix that do not hold in this language yet, each with its finding in
   *  docs/07-findings.md — run as `todo` until the author decides */
  todo?: { readonly К13?: string } | undefined;
  /** the format knows no strings (plain text): quotes are letters, and spaces between
   *  them are as free as any — К10 holds that, instead of refusing */
  noStrings?: boolean | undefined;
  /** two copies of the target with no block to tell them apart: a flat format anchors the
   *  second by the line before it — the last line of the first — and С1 must land, where
   *  a language of blocks refuses to guess */
  c1ByNeighbour?: boolean | undefined;
  /** the outer block is no block of the language's map, so no pattern carries its name
   *  (Objective-C: `@implementation … @end` has no braces — Р4); К2 then holds that
   *  renaming it changes nothing */
  outerIsNoBlock?: boolean | undefined;
}

/** The lines of a file, a slot left empty taking no line at all. */
export function file(...lines: (string | undefined)[]): string {
  return lines.filter((l): l is string => l !== undefined).join('\n') + '\n';
}

/** A slot as a line of `file`: none when empty. */
export const opt = (slot: string): string | undefined => (slot === '' ? undefined : slot);

/** Open findings (docs/07-findings.md): a row that does not hold yet runs as `todo` —
 *  seen in every run, failing none, until the author decides. */
const FINDING_N1 = '07-findings Н1: вставка после строки берёт всех родителей, переименованный тоже';
const FINDING_N2 = '07-findings Н2: Python — патч на базе с более глубоким отступом ложится со старым отступом';

const DEFAULTS: Omit<Slots, 'edit'> = {
  outer: 'Outer',
  top: '',
  above: '',
  below: '',
  bottom: '',
  inner: '',
  target: true,
  twice: false,
};

const adapters = new Map<string, LanguageAdapter>();
export async function adapterOf(language: string): Promise<LanguageAdapter> {
  let a = adapters.get(language);
  if (a === undefined) {
    a = adapterForLanguage(language);
    await a.init();
    adapters.set(language, a);
  }
  return a;
}

/** The .sirp `generate` writes for `old` → `new`. */
export function patchText(oldText: string, newText: string, adapter: LanguageAdapter, exact = false): string {
  return printSirFile(synthesize(oldText, newText, adapter, { exact }), adapter.name);
}

/** The patch `generate` writes for `old` → `new`, read back as `apply` reads it. */
export function patchOf(oldText: string, newText: string, adapter: LanguageAdapter, exact = false): SirFile {
  return parseSirFile(patchText(oldText, newText, adapter, exact));
}

/** The lines of the match blocks of a printed patch, gutter off — what the pattern holds. */
export function matchLines(md: string): string[] {
  const out: string[] = [];
  let inMatch = false;
  for (const l of md.split('\n')) {
    if (l.startsWith('# match')) inMatch = true;
    else if (l === '# end') inMatch = false;
    else if (inMatch) out.push(l.replace(/^ {4}/, ''));
  }
  return out;
}

/** A hunk of the patch is pinned to the end of the file: its pattern ends in `>>>` with
 *  nothing after it. Upstream appending to that file moves where it lands — by design
 *  (7.9), so a row's drift must not touch that end. */
function pinnedToEnd(md: string): boolean {
  return md.split('# patch').slice(0, -1).some((m) => {
    const body = matchLines(`${m}# end`).map((l) => l.trim()).filter((l) => l !== '');
    return body[body.length - 1] === '>>>';
  });
}

const apply = (source: string, file: SirFile, adapter: LanguageAdapter): string =>
  applyAll(source, file, adapter).source;

const refuses = (run: () => unknown, kind: typeof MatchError | typeof AmbiguityError, why: string): void => {
  assert.throws(run, (e: unknown) => e instanceof kind, why);
};

/** What a run ended with: the text, or the kind of refusal. A crash is no refusal. */
function outcome(run: () => string): string {
  try {
    return run();
  } catch (e) {
    assert.ok(e instanceof MatchError || e instanceof AmbiguityError, `a crash is no refusal: ${String(e)}`);
    return e.constructor.name;
  }
}

/** The headers of the blocks around `needle` in `text`, as the language's map has them. */
function parentHeaders(a: LanguageAdapter, text: string, needle: string): string[] {
  const map = a.buildMap(text);
  const at = text.indexOf(needle.trimStart());
  assert.ok(at >= 0, `precondition: ${JSON.stringify(needle)} stands in the file`);
  return map
    .enclosing(map.toCanonPos(at))
    .filter((s) => s.headerStart !== undefined)
    .map((s) => text.slice(map.toOriginalPos(s.headerStart!, 'right'), map.toOriginalPos(s.open, 'left') + 1));
}

/** The cases a fixture yields, for the matrix and for a comparison with other tools
 *  (`vs-git-apply.test.ts`): a patch made on `old` → `new`, the file upstream made of
 *  `old`, and what the patch must make of it. */
export interface DriftCase {
  readonly row: string;
  readonly oldText: string;
  readonly newText: string;
  readonly base: string;
  readonly expected: string;
}

export function driftCases(f: Fixture): DriftCase[] {
  const r = rows(f);
  const out: DriftCase[] = [];
  const add = (row: string, edit: Edit, s: Partial<Slots>, map: (t: string) => string = (t) => t): void => {
    const [oldText, newText] = r.pair(edit);
    const [baseOld, baseNew] = r.pair(edit, s);
    out.push({ row, oldText, newText, base: map(baseOld), expected: map(baseNew) });
  };
  // the control: no drift — every tool must land here, or the comparison says nothing
  add('К0 без дрейфа', r.insert, {});
  // far from the change: an include on top, a declaration after the outer block
  add('К1в вставка, дрейф далеко от правки', r.insert, { top: f.topLine, bottom: f.tail });
  add('К1 вставка, дрейф', r.insert, r.drift);
  add('К1 замена, дрейф', r.replace, r.drift);
  add('К2 замена, внешний блок переименован', r.replace, { outer: 'Renamed' });
  add('К2 вставка, внешний блок переименован', r.insert, { outer: 'Renamed' });
  add('К4 CRLF', r.insert, r.drift, (t) => t.replace(/\n/g, '\r\n'));
  add('К5 BOM', r.insert, r.drift, (t) => '\uFEFF' + t);
  add('К9 20 ханков, дрейф', r.twenty, r.drift);
  // upstream put a comment right above the anchor line
  const note = r.line(f.comment('upstream note'));
  const [oldText, newText] = r.pair(r.insert);
  out.push({
    row: 'К3 комментарий над якорем',
    oldText,
    newText,
    base: r.render({ edit: `${note}\n${r.one}` }),
    expected: r.render({ edit: `${note}\n${r.one}\n${r.added}` }),
  });
  // upstream added a line right above the change, inside the target
  const extra = r.line(f.stmt('upstream', 'x'));
  out.push({
    row: 'К1б строка upstream прямо над правкой',
    oldText,
    newText,
    base: r.render({ edit: `${extra}\n${r.one}` }),
    expected: r.render({ edit: `${extra}\n${r.one}\n${r.added}` }),
  });
  return out;
}

type Edit = { old: string; new: string };

function rows(f: Fixture) {
  const line = (stmt: string): string => f.indent + stmt;
  const one = line(f.stmt('count', 'x'));
  const added = line(f.stmt('report', 'x'));
  const replaced = line(f.stmt('count', 'y'));
  const upstream = line(f.stmt('count', 'z'));
  const insert: Edit = { old: one, new: `${one}\n${added}` };
  const replace: Edit = { old: one, new: replaced };
  const forty = (changed: (i: number) => boolean): string =>
    Array.from({ length: 40 }, (_, i) => line(f.stmt('step', changed(i) ? `${i} + 1` : String(i)))).join('\n');
  const twenty: Edit = { old: forty(() => false), new: forty((i) => i % 2 === 1) };
  const render = (s: Partial<Slots> & Pick<Slots, 'edit'>): string => f.render({ ...DEFAULTS, ...s });
  const pair = (edit: Edit, s: Partial<Slots> = {}): [string, string] => [
    render({ ...s, edit: edit.old }),
    render({ ...s, edit: edit.new }),
  ];
  const drift: Partial<Slots> = {
    top: f.topLine,
    above: f.decl('addedAbove'),
    below: f.decl('addedBelow'),
    bottom: f.tail,
  };
  return { line, one, added, replaced, upstream, insert, replace, twenty, render, pair, drift };
}

export function runMatrix(f: Fixture): void {
  const L = f.language;
  const { line, one, added, upstream, insert, replace, twenty, render, pair, drift } = rows(f);

  /** generated on the default file, applied to the file `upstream` changed by `s` */
  const drifted = async (edit: Edit, s: Partial<Slots>, map: (t: string) => string = (t) => t) => {
    const a = await adapterOf(L);
    const [oldText, newText] = pair(edit);
    const md = patchText(oldText, newText, a);
    // 7.9: a drift at the end a hunk is pinned to moves the hunk with it, as it must
    assert.ok(!(pinnedToEnd(md) && s.bottom !== undefined && s.bottom !== ''), 'setup: the drift touches the end a hunk is pinned to');
    const [baseOld, baseNew] = pair(edit, s);
    return { a, md, patch: parseSirFile(md), base: map(baseOld), expected: map(baseNew) };
  };

  // ── К: must land ───────────────────────────────────────────────────────────────

  test(`matrix ${L} К1 дрейф: строки выше и ниже ханка`, async () => {
    for (const edit of [insert, replace]) {
      const { a, patch, base, expected } = await drifted(edit, drift);
      assert.notEqual(base, pair(edit)[0], 'precondition: upstream changed the file');
      assert.equal(apply(base, patch, a), expected);
    }
  });

  test(`matrix ${L} К2 внешний блок переименован — ханк держится за ближайшего родителя`, async () => {
    const a = await adapterOf(L);
    const [oldText] = pair(replace);
    const headers = parentHeaders(a, oldText, one);
    if (f.outerIsNoBlock === true) {
      assert.ok(!headers.some((h) => h.includes(DEFAULTS.outer)), 'precondition: the outer block is no block of the map');
    } else {
      // precondition: the outer block is a parent of the target, so a rename is a change a pattern could see
      assert.ok(headers.some((h) => h.includes(DEFAULTS.outer)), `precondition: no parent header names ${DEFAULTS.outer}: ${JSON.stringify(headers)}`);
      // ...and an insertion's pattern does carry it (Н1), so the todo row below is about something
      const ins = await drifted(insert, {});
      assert.ok(ins.md.includes(DEFAULTS.outer), 'precondition: the pattern of an insertion names the outer block');
    }
    // a replaced line holds by the nearest parent alone
    const r = await drifted(replace, { outer: 'Renamed' });
    assert.ok(!r.md.includes(DEFAULTS.outer), 'the pattern of a replacement names no outer block');
    assert.equal(apply(r.base, r.patch, a), r.expected);
  });

  // An insertion after a line takes every parent once it needs a neighbour, the renamed
  // one too, and is refused. Never lands elsewhere — that much holds now.
  test(`matrix ${L} К2 вставка после строки, внешний блок переименован`, { todo: f.outerIsNoBlock === true ? undefined : FINDING_N1 }, async () => {
    const { a, patch, base, expected } = await drifted(insert, { outer: 'Renamed' });
    assert.equal(apply(base, patch, a), expected);
  });

  test(`matrix ${L} К3 комментарий рядом с якорем — в файле и добавленный upstream`, async () => {
    const a = await adapterOf(L);
    const note = line(f.comment('note'));
    // a comment right above the anchor, there from the start: the patch is made with it
    const withNote = { old: `${note}\n${one}`, new: `${note}\n${one}\n${added}` };
    const kept = await drifted(withNote, drift);
    assert.equal(apply(kept.base, kept.patch, a), kept.expected);

    // upstream puts a comment right above the anchor: a pattern with `...` before the
    // anchor steps over it and must land; one that spells the line above refuses
    const [oldText, newText] = pair(insert);
    const md = patchText(oldText, newText, a);
    const body = matchLines(md).map((l) => l.trim());
    const anchor = body.findIndex((l) => l.includes('count'));
    assert.ok(anchor > 0, 'precondition: the pattern holds the anchor line');
    const base = render({ edit: `${note}\n${one}` });
    const got = outcome(() => apply(base, parseSirFile(md), a));
    if (body[anchor - 1] === '...') assert.equal(got, render({ edit: `${note}\n${one}\n${added}` }), 'a `...` before the anchor steps over the comment');
    else assert.equal(got, 'MatchError', 'the line above the anchor is spelled: the comment breaks it');
  });

  test(`matrix ${L} К4 CRLF-база; смешанные окончания — отказ с названной строкой`, async () => {
    const crlf = (t: string): string => t.replace(/\n/g, '\r\n');
    const { a, patch, base, expected } = await drifted(insert, drift, crlf);
    assert.ok(base.includes('\r\n'), 'precondition: the base is CRLF');
    assert.equal(apply(base, patch, a), expected);

    // a patch writes the endings of its base: a new version with one LF in a CRLF file
    // cannot be written byte for byte, and `exact` says which line
    const [oldText, newText] = pair(insert);
    const lines = crlf(newText).split('\r\n');
    const k = lines.indexOf(added);
    const mixed = lines.slice(0, k + 1).join('\r\n') + '\n' + lines.slice(k + 1).join('\r\n');
    assert.throws(
      () => synthesize(crlf(oldText), mixed, a, { exact: true }),
      (e: unknown) => e instanceof SynthesisError && e.message.includes(`line ${k + 1} ends with LF`),
    );
  });

  test(`matrix ${L} К5 BOM перед якорем первой строки`, async () => {
    const a = await adapterOf(L);
    const [oldText, newText] = pair(insert);
    // a pattern pinned to the first line: no `...` before it, so the BOM is in its way
    const first = oldText.split('\n', 1)[0]!;
    const md = sirMd([{ match: `${first}\n...\n${one}\n>>>\n...`, patch: `\n${added}` }], a.name);
    assert.equal(matchLines(md).find((l) => l.trim() !== ''), first, 'precondition: the pattern opens with the first line');
    const file = parseSirFile(md);
    assert.equal(apply(oldText, file, a), newText);
    const bom = '\uFEFF';
    assert.equal(apply(bom + oldText, file, a), bom + newText);
    // and a generated patch over a drifted file with a BOM
    const d = await drifted(insert, drift, (t) => bom + t);
    assert.equal(apply(d.base, d.patch, a), d.expected);
  });

  test(`matrix ${L} К6 табы вместо пробелов, переиндентация`, async () => {
    const a = await adapterOf(L);
    const [oldText, newText] = pair(insert);
    const patch = patchOf(oldText, newText, a);
    const unit = /^( +)\S/m.exec(oldText)?.[1] ?? '    ';
    // the other style of the file: spaces → tabs, tabs → spaces (Go)
    const other = (t: string): string =>
      /^\t/m.test(t)
        ? t.replace(/^(\t+)/gm, (tb) => '    '.repeat(tb.length))
        : t.replace(/^( +)/gm, (sp) => '\t'.repeat(Math.floor(sp.length / unit.length)) + ' '.repeat(sp.length % unit.length));
    const wide = (t: string): string => t.replace(/^([ \t]+)/gm, (sp) => sp + sp);
    for (const reindent of [other, wide]) {
      assert.notEqual(reindent(oldText), oldText, `precondition: ${reindent.name} changes the file`);
      if (f.indentIsSyntax === true) {
        if (reindent === other) {
          refuses(() => apply(reindent(oldText), patch, a), MatchError, 'tabs for spaces: the indentation is the anchor\'s');
        }
        continue;
      }
      // the patch writes its own lines as it holds them; the place is what is checked
      const result = apply(reindent(oldText), patch, a);
      assert.ok(sameIgnoringSpace(result, reindent(newText), a), `${reindent.name}: landed elsewhere\n${result}`);
      assert.equal(result.split('\n').length, newText.split('\n').length);
    }
  });

  if (f.indentIsSyntax === true) {
    test(`matrix ${L} К6 код сдвинут глубже — отказ или верный отступ`, { todo: FINDING_N2 }, async () => {
      const a = await adapterOf(L);
      const [oldText, newText] = pair(insert);
      const wide = (t: string): string => t.replace(/^([ \t]+)/gm, (sp) => sp + sp);
      assert.notEqual(outcome(() => apply(wide(oldText), patchOf(oldText, newText, a), a)), wide(newText) + 'never');
      assert.equal(apply(wide(oldText), patchOf(oldText, newText, a), a), wide(newText));
    });
  }

  test(`matrix ${L} К7 пустой файл; вставка в начало и в конец файла`, async () => {
    const a = await adapterOf(L);
    const [oldText] = pair(insert);
    // the empty file is an edge of generation: there is nothing to drift
    assert.equal(apply('', patchOf('', f.tail + '\n', a, true), a), f.tail + '\n');
    // the start: upstream changed the file below it
    const license = f.comment('license header') + '\n';
    const [base] = pair(insert, drift);
    assert.equal(apply(base, patchOf(oldText, license + oldText, a, true), a), license + base);
    // the end: upstream changed the file above it — and not at the end the hunk is pinned to (7.9)
    const tail = f.tail + '\n';
    const md = patchText(oldText, oldText + tail, a, true);
    assert.ok(pinnedToEnd(md), 'precondition: an append is pinned to the end of the file');
    const [above] = pair(insert, { ...drift, bottom: '' });
    assert.equal(apply(above, parseSirFile(md), a), above + tail);
  });

  test(`matrix ${L} К8 строка 5 КБ; минифицированный файл`, async () => {
    const a = await adapterOf(L);
    const long = line(f.str('x'.repeat(5000)));
    // the long line stands above the change, so the anchors may stand on it
    const [oldText, newText] = pair(insert, { inner: long });
    const [base, expected] = pair(insert, { ...drift, inner: long });
    assert.equal(apply(base, patchOf(oldText, newText, a), a), expected);

    if (f.minified !== undefined) {
      const o = f.minified(false);
      const n = f.minified(true);
      assert.ok(!o.trimEnd().includes('\n'), 'a minified file is one line');
      const drifted = f.minified(false, true);
      assert.notEqual(drifted, o, 'precondition: upstream changed the minified file');
      // the change is a line, and the line is the file: the patch spells it, so upstream's
      // addition is kept or the patch refuses — it never writes over it (07-findings Н5)
      const got = outcome(() => apply(drifted, patchOf(o, n, a, true), a));
      if (got !== 'MatchError') assert.equal(got, f.minified(true, true), 'the patch wrote over what upstream added');
    }
  });

  test(`matrix ${L} К9 20 ханков в одном файле`, async () => {
    const { a, patch, base, expected } = await drifted(twenty, drift);
    assert.equal(patch.hunks.length, 20);
    assert.equal(apply(base, patch, a), expected);
  });

  test(`matrix ${L} К10 опаковая строка: "a  b" в файле не совпадает с "a b" в шаблоне`, async () => {
    const a = await adapterOf(L);
    const md = sirMd([{ match: `...\n${f.indent}${f.str('a b')}\n>>>\n...`, patch: `\n${added}` }], a.name);
    assert.ok(matchLines(md).some((l) => l.includes('a b')), 'precondition: the pattern holds the string');
    const file = parseSirFile(md);
    const at = (text: string): string => render({ inner: line(f.str(text)), edit: one });
    assert.equal(apply(at('a b'), file, a), render({ inner: `${line(f.str('a b'))}\n${added}`, edit: one }));
    if (f.noStrings === true) {
      // no strings in the format: the quotes are letters, the spaces between them free
      assert.equal(apply(at('a  b'), file, a), render({ inner: `${line(f.str('a  b'))}\n${added}`, edit: one }));
    } else {
      refuses(() => apply(at('a  b'), file, a), MatchError, 'spaces inside a string are data');
    }
  });

  test(`matrix ${L} К13 большой файл: цель и 50 её копий с другими именами`, { todo: f.todo?.К13 }, async () => {
    const a = await adapterOf(L);
    // one copy of the target, as `twice` writes it: the text a second render adds
    const one1 = render({ edit: one });
    const two = render({ edit: one, twice: true });
    let p = 0;
    while (one1[p] === two[p]) p++;
    p = one1.lastIndexOf('\n', p - 1) + 1; // a copy is whole lines
    const copy = two.slice(p, p + two.length - one1.length).replace(/\n+$/, '');
    assert.ok(copy.includes(f.targetName), `precondition: a copy of the target holds ${JSON.stringify(f.targetName)}`);
    // the copies stand right after the target, in its `below` slot — where upstream adds no line
    const below = Array.from({ length: 50 }, (_, k) => copy.replace(f.targetName, `${f.targetName}${k}`)).join('\n');
    const [oldText, newText] = pair(insert, { below });
    assert.equal(oldText.split(one).length - 1, 51, 'precondition: the anchor line stands 51 times');
    const md = patchText(oldText, newText, a);
    const [base, expected] = pair(insert, { ...drift, below, bottom: pinnedToEnd(md) ? '' : drift.bottom! });
    assert.equal(apply(base, parseSirFile(md), a), expected);
  });

  // К11 (скобки языка) and К12 (round-trip) are held by the goldens of the language and
  // by property.test.ts — see the audit table in docs/10-brave-languages.md

  // ── С: refuse loudly, or a limitation held as it stands ─────────────────────────

  test(`matrix ${L} С1 два одинаковых блока, правка во втором — отказ синтеза, не первый молча`, async () => {
    const a = await adapterOf(L);
    // the second copy is the target as `render` writes it; the first stands above
    const [oldText] = pair(insert, { twice: true });
    const k = oldText.lastIndexOf(one);
    assert.notEqual(oldText.indexOf(one), k, 'precondition: the anchor line stands twice');
    const newText = oldText.slice(0, k + one.length) + '\n' + added + oldText.slice(k + one.length);
    if (f.c1ByNeighbour === true) {
      // the line before the second copy tells it: the pattern must stand on it, and hold
      // when upstream adds lines elsewhere
      const md = patchText(oldText, newText, a);
      const [baseOld] = pair(insert, { ...drift, twice: true });
      const kb = baseOld.lastIndexOf(one);
      const baseNew = baseOld.slice(0, kb + one.length) + '\n' + added + baseOld.slice(kb + one.length);
      assert.equal(apply(baseOld, parseSirFile(md), a), baseNew);
      return;
    }
    // held as it stands in every language of blocks (cpp/57 is KNOWN-GAP): a change here is seen
    assert.throws(() => patchOf(oldText, newText, a), (e: unknown) => e instanceof SynthesisError);
  });

  test(`matrix ${L} С2 } внутри строкового литерала`, async () => {
    const inner = line(f.str('} {'));
    const a = await adapterOf(L);
    const [oldText, newText] = pair(insert, { inner });
    const patch = patchOf(oldText, newText, a);
    const [baseOld, baseNew] = pair(insert, { ...drift, inner });
    assert.equal(apply(baseOld, patch, a), baseNew);
  });

  if (f.multiline !== undefined) {
    const lit = f.multiline;
    test(`matrix ${L} С3 пробелы внутри многострочного литерала не значимы (ограничение)`, async () => {
      const a = await adapterOf(L);
      const lines = lit('a b');
      const md = sirMd([{ match: `...\n${lines.join('\n')}\n>>>\n...`, patch: `\n${added}` }], a.name);
      assert.ok(matchLines(md).some((l) => l.includes('a b')), 'precondition: the pattern holds the literal');
      const base = render({ inner: lit('a  b').join('\n'), edit: one });
      // held as it stands: README says so; a change here is a change of the format
      assert.equal(apply(base, parseSirFile(md), a), render({ inner: [...lit('a  b'), added].join('\n'), edit: one }));
    });
  }

  test(`matrix ${L} С4 повторный apply вставляет снова (ограничение)`, async () => {
    const a = await adapterOf(L);
    const [oldText, newText] = pair(insert);
    const patch = patchOf(oldText, newText, a);
    const twice = apply(apply(oldText, patch, a), patch, a);
    assert.equal(twice, render({ edit: `${one}\n${added}\n${added}` }));
  });

  test(`matrix ${L} С5 многострочный якорь, вторая строка с другим отступом`, async () => {
    const a = await adapterOf(L);
    if (f.indentIsSyntax === true) {
      // the second line of a call over two lines: inside the parentheses the grammar
      // reads any indentation the same, so only the anchor can tell the shift
      const call = (pad: string): string => `${line('first(')}\n${pad}${line('    x)')}`;
      const md = sirMd([{ match: `...\n${call('')}\n>>>\n...`, patch: `\n${added}` }], a.name);
      const file = parseSirFile(md);
      const at = (pad: string): string => render({ edit: `${call(pad)}\n${one}` });
      assert.equal(apply(at(''), file, a), render({ edit: `${call('')}\n${added}\n${one}` }));
      const map = (t: string): number => a.buildMap(t).blocksWithin(0, a.buildMap(t).eof).length;
      assert.equal(map(at('  ')), map(at('')), 'precondition: the shift leaves the blocks of the file as they are');
      refuses(() => apply(at('  '), file, a), MatchError, 'the second line of an anchor is verbatim');
      return;
    }
    const first = f.stmt('first', 'x');
    const second = f.stmt('second', 'x');
    const md = sirMd([{ match: `...\n${f.indent}${first}\n${f.indent}${second}\n>>>\n...`, patch: `\n${added}` }], a.name);
    const file = parseSirFile(md);
    const at = (pad: string): string => render({ edit: `${line(first)}\n${pad}${line(second)}\n${one}` });
    assert.equal(apply(at(''), file, a), render({ edit: `${line(first)}\n${line(second)}\n${added}\n${one}` }));
    // spaces between literals are free in a language of brackets — README
    assert.equal(apply(at('  '), file, a), render({ edit: `${line(first)}\n  ${line(second)}\n${added}\n${one}` }));
  });

  test(`matrix ${L} С6 родителя нет; upstream поменял строку; upstream повторил код`, async () => {
    const gone = await drifted(insert, { target: false });
    refuses(() => apply(gone.base, gone.patch, gone.a), MatchError, 'no target, no place');

    const conflict = await drifted(replace, {});
    refuses(() => apply(render({ edit: upstream }), conflict.patch, conflict.a), MatchError, 'the replaced line is gone');

    const repeated = await drifted(insert, { twice: true });
    refuses(() => apply(repeated.base, repeated.patch, repeated.a), AmbiguityError, 'two places');
  });

  test(`matrix ${L} С7 ханк рядом с ERROR-областью дерева`, async () => {
    const inner = line(f.broken);
    const { a, patch, base, expected } = await drifted(insert, { inner });
    // made on the file with the broken line, applied to the drifted one
    const [oldText, newText] = pair(insert, { inner });
    const md = patchText(oldText, newText, a);
    const [b, e] = pair(insert, { ...drift, inner });
    assert.equal(outcome(() => apply(b, parseSirFile(md), a)), e);
    void patch; void base; void expected;
  });
}
