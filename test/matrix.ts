//   К — the patch, generated from `old` → `new`, applied to T(old) gives T(new);
//   С — it refuses loudly (MatchError, AmbiguityError), or lands where it must, never
//       elsewhere; a limitation is held as it stands, so a change of it is seen.

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
  outer: string;
  top: string;
  above: string;
  below: string;
  bottom: string;
  inner: string;
  edit: string;
  target: boolean;
  twice: boolean;
}

export interface Fixture {
  language: string;
  targetName: string;
  render(s: Slots): string;
  indent: string;
  stmt(name: string, arg: string): string;
  decl(name: string): string;
  topLine: string;
  tail: string;
  comment(text: string): string;
  str(text: string): string;
  multiline?: ((text: string) => string[]) | undefined;
  broken: string;
  indentIsSyntax?: boolean | undefined;
  minified?: ((edited: boolean, drifted?: boolean) => string) | undefined;
  todo?: { readonly К13?: string } | undefined;
  noStrings?: boolean | undefined;
  c1ByNeighbour?: boolean | undefined;
  outerIsNoBlock?: boolean | undefined;
}

export function file(...lines: (string | undefined)[]): string {
  return lines.filter((l): l is string => l !== undefined).join('\n') + '\n';
}

export const opt = (slot: string): string | undefined => (slot === '' ? undefined : slot);

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

export function patchText(oldText: string, newText: string, adapter: LanguageAdapter, exact = false): string {
  return printSirFile(synthesize(oldText, newText, adapter, { exact }), adapter.name);
}

export function patchOf(oldText: string, newText: string, adapter: LanguageAdapter, exact = false): SirFile {
  return parseSirFile(patchText(oldText, newText, adapter, exact));
}

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

function outcome(run: () => string): string {
  try {
    return run();
  } catch (e) {
    assert.ok(e instanceof MatchError || e instanceof AmbiguityError, `a crash is no refusal: ${String(e)}`);
    return e.constructor.name;
  }
}

function parentHeaders(a: LanguageAdapter, text: string, needle: string): string[] {
  const map = a.buildMap(text);
  const at = text.indexOf(needle.trimStart());
  assert.ok(at >= 0, `precondition: ${JSON.stringify(needle)} stands in the file`);
  return map
    .enclosing(map.toCanonPos(at))
    .filter((s) => s.headerStart !== undefined)
    .map((s) => text.slice(map.toOriginalPos(s.headerStart!, 'right'), map.toOriginalPos(s.open, 'left') + 1));
}

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
  add('К0 без дрейфа', r.insert, {});
  add('К1в вставка, дрейф далеко от правки', r.insert, { top: f.topLine, bottom: f.tail });
  add('К1 вставка, дрейф', r.insert, r.drift);
  add('К1 замена, дрейф', r.replace, r.drift);
  add('К2 замена, внешний блок переименован', r.replace, { outer: 'Renamed' });
  add('К2 вставка, внешний блок переименован', r.insert, { outer: 'Renamed' });
  add('К4 CRLF', r.insert, r.drift, (t) => t.replace(/\n/g, '\r\n'));
  add('К5 BOM', r.insert, r.drift, (t) => '\uFEFF' + t);
  add('К9 20 ханков, дрейф', r.twenty, r.drift);
  const note = r.line(f.comment('upstream note'));
  const [oldText, newText] = r.pair(r.insert);
  out.push({
    row: 'К3 комментарий над якорем',
    oldText,
    newText,
    base: r.render({ edit: `${note}\n${r.one}` }),
    expected: r.render({ edit: `${note}\n${r.one}\n${r.added}` }),
  });
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

  const drifted = async (edit: Edit, s: Partial<Slots>, map: (t: string) => string = (t) => t) => {
    const a = await adapterOf(L);
    const [oldText, newText] = pair(edit);
    const md = patchText(oldText, newText, a);
    assert.ok(!(pinnedToEnd(md) && s.bottom !== undefined && s.bottom !== ''), 'setup: the drift touches the end a hunk is pinned to');
    const [baseOld, baseNew] = pair(edit, s);
    return { a, md, patch: parseSirFile(md), base: map(baseOld), expected: map(baseNew) };
  };

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
      assert.ok(headers.some((h) => h.includes(DEFAULTS.outer)), `precondition: no parent header names ${DEFAULTS.outer}: ${JSON.stringify(headers)}`);
      const ins = await drifted(insert, {});
      assert.ok(ins.md.includes(DEFAULTS.outer), 'precondition: the pattern of an insertion names the outer block');
    }
    const r = await drifted(replace, { outer: 'Renamed' });
    assert.ok(!r.md.includes(DEFAULTS.outer), 'the pattern of a replacement names no outer block');
    assert.equal(apply(r.base, r.patch, a), r.expected);
  });

  test(`matrix ${L} К2 вставка после строки, внешний блок переименован`, { todo: f.outerIsNoBlock === true ? undefined : FINDING_N1 }, async () => {
    const { a, patch, base, expected } = await drifted(insert, { outer: 'Renamed' });
    assert.equal(apply(base, patch, a), expected);
  });

  test(`matrix ${L} К3 комментарий рядом с якорем — в файле и добавленный upstream`, async () => {
    const a = await adapterOf(L);
    const note = line(f.comment('note'));
    const withNote = { old: `${note}\n${one}`, new: `${note}\n${one}\n${added}` };
    const kept = await drifted(withNote, drift);
    assert.equal(apply(kept.base, kept.patch, a), kept.expected);

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
    const first = oldText.split('\n', 1)[0]!;
    const md = sirMd([{ match: `${first}\n...\n${one}\n>>>\n...`, patch: `\n${added}` }], a.name);
    assert.equal(matchLines(md).find((l) => l.trim() !== ''), first, 'precondition: the pattern opens with the first line');
    const file = parseSirFile(md);
    assert.equal(apply(oldText, file, a), newText);
    const bom = '\uFEFF';
    assert.equal(apply(bom + oldText, file, a), bom + newText);
    const d = await drifted(insert, drift, (t) => bom + t);
    assert.equal(apply(d.base, d.patch, a), d.expected);
  });

  test(`matrix ${L} К6 табы вместо пробелов, переиндентация`, async () => {
    const a = await adapterOf(L);
    const [oldText, newText] = pair(insert);
    const patch = patchOf(oldText, newText, a);
    const unit = /^( +)\S/m.exec(oldText)?.[1] ?? '    ';
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
    assert.equal(apply('', patchOf('', f.tail + '\n', a, true), a), f.tail + '\n');
    const license = f.comment('license header') + '\n';
    const [base] = pair(insert, drift);
    assert.equal(apply(base, patchOf(oldText, license + oldText, a, true), a), license + base);
    const tail = f.tail + '\n';
    const md = patchText(oldText, oldText + tail, a, true);
    assert.ok(pinnedToEnd(md), 'precondition: an append is pinned to the end of the file');
    const [above] = pair(insert, { ...drift, bottom: '' });
    assert.equal(apply(above, parseSirFile(md), a), above + tail);
  });

  test(`matrix ${L} К8 строка 5 КБ; минифицированный файл`, async () => {
    const a = await adapterOf(L);
    const long = line(f.str('x'.repeat(5000)));
    const [oldText, newText] = pair(insert, { inner: long });
    const [base, expected] = pair(insert, { ...drift, inner: long });
    assert.equal(apply(base, patchOf(oldText, newText, a), a), expected);

    if (f.minified !== undefined) {
      const o = f.minified(false);
      const n = f.minified(true);
      assert.ok(!o.trimEnd().includes('\n'), 'a minified file is one line');
      const drifted = f.minified(false, true);
      assert.notEqual(drifted, o, 'precondition: upstream changed the minified file');
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
      assert.equal(apply(at('a  b'), file, a), render({ inner: `${line(f.str('a  b'))}\n${added}`, edit: one }));
    } else {
      refuses(() => apply(at('a  b'), file, a), MatchError, 'spaces inside a string are data');
    }
  });

  test(`matrix ${L} К13 большой файл: цель и 50 её копий с другими именами`, { todo: f.todo?.К13 }, async () => {
    const a = await adapterOf(L);
    const one1 = render({ edit: one });
    const two = render({ edit: one, twice: true });
    let p = 0;
    while (one1[p] === two[p]) p++;
    p = one1.lastIndexOf('\n', p - 1) + 1;
    const copy = two.slice(p, p + two.length - one1.length).replace(/\n+$/, '');
    assert.ok(copy.includes(f.targetName), `precondition: a copy of the target holds ${JSON.stringify(f.targetName)}`);
    const below = Array.from({ length: 50 }, (_, k) => copy.replace(f.targetName, `${f.targetName}${k}`)).join('\n');
    const [oldText, newText] = pair(insert, { below });
    assert.equal(oldText.split(one).length - 1, 51, 'precondition: the anchor line stands 51 times');
    const md = patchText(oldText, newText, a);
    const [base, expected] = pair(insert, { ...drift, below, bottom: pinnedToEnd(md) ? '' : drift.bottom! });
    assert.equal(apply(base, parseSirFile(md), a), expected);
  });

  test(`matrix ${L} С1 два одинаковых блока, правка во втором — отказ синтеза, не первый молча`, async () => {
    const a = await adapterOf(L);
    const [oldText] = pair(insert, { twice: true });
    const k = oldText.lastIndexOf(one);
    assert.notEqual(oldText.indexOf(one), k, 'precondition: the anchor line stands twice');
    const newText = oldText.slice(0, k + one.length) + '\n' + added + oldText.slice(k + one.length);
    if (f.c1ByNeighbour === true) {
      const md = patchText(oldText, newText, a);
      const [baseOld] = pair(insert, { ...drift, twice: true });
      const kb = baseOld.lastIndexOf(one);
      const baseNew = baseOld.slice(0, kb + one.length) + '\n' + added + baseOld.slice(kb + one.length);
      assert.equal(apply(baseOld, parseSirFile(md), a), baseNew);
      return;
    }
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
    const [oldText, newText] = pair(insert, { inner });
    const md = patchText(oldText, newText, a);
    const [b, e] = pair(insert, { ...drift, inner });
    assert.equal(outcome(() => apply(b, parseSirFile(md), a)), e);
    void patch; void base; void expected;
  });
}
