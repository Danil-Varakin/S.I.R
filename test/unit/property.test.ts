import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { synthesize, sameIgnoringSpace } from '../../src/generate/synth.ts';
import { printSirFile } from '../../src/generate/printer.ts';
import { parseSirFile } from '../../src/core/sir-parser.ts';
import { applyAll } from '../../src/core/apply.ts';
import { resolveHunks } from '../../src/core/resolve.ts';
import { ParseError, SynthesisError } from '../../src/core/errors.ts';
import { adapterForLanguage } from '../../src/lang/adapter.ts';
import type { LanguageAdapter } from '../../src/lang/source-map.ts';
import type { SirFile } from '../../src/core/ast.ts';
import { strip, type FlatStep } from '../helpers.ts';

// Properties README promises for ANY input, checked on generated ones rather than on the
// cases somebody thought of:
//   - generate then apply round-trips: whatever synthesize returns, printed, read back
//     and applied to the old text, gives the new text (byte for byte with `exact`);
//     the only way out is a SynthesisError that says it could not anchor a change;
//   - the printer and the parser agree: print → parse gives the same hunks back;
//   - resolve tells the editor where each hunk is: `base` is what it replaced in the old
//     text, `final` what it wrote in the applied one — nothing of another hunk's;
//   - a .sirp that is not well formed is a ParseError — never a crash, never a hang;
//   - normalization is idempotent.
// The inputs are edits of the golden corpus — real code in every language — drawn from a
// seeded generator, so a failure names its seed and is reproduced by
// `SIR_PROP_SEED=<seed> node --test --experimental-strip-types test/unit/property.test.ts`.
// `SIR_PROP_RUNS` multiplies the number of cases for a longer hunt.

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), '..', 'golden');
const SEED = Number(process.env['SIR_PROP_SEED'] ?? 20261019);
const RUNS = Math.max(1, Number(process.env['SIR_PROP_RUNS'] ?? 1));

/** mulberry32: small, fast, and the same sequence on every platform. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const int = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const LANGUAGES = readdirSync(GOLDEN).filter((d) => isDir(join(GOLDEN, d))).sort();

/** Source files of a language's goldens: the old versions and the apply sources. */
function corpus(language: string): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  for (const kind of ['generate', 'apply']) {
    const dir = join(GOLDEN, language, kind);
    if (!isDir(dir)) continue;
    for (const f of readdirSync(dir).sort()) {
      if (f.endsWith('.sirp') || f.includes('.new.') || f.includes('.expected.')) continue;
      const text = readFileSync(join(dir, f), 'utf8');
      const lines = text.split('\n').length;
      // big enough to have structure, small enough that a hundred runs stay quick
      if (lines >= 6 && lines <= 90 && !text.includes('\r')) out.push({ name: `${language}/${kind}/${f}`, text });
    }
  }
  return out;
}

const adapters = new Map<string, LanguageAdapter>();
async function adapterFor(language: string): Promise<LanguageAdapter> {
  let a = adapters.get(language);
  if (a === undefined) {
    a = adapterForLanguage(language);
    await a.init();
    adapters.set(language, a);
  }
  return a;
}

/** A word of the line changed the way an edit changes it: renamed, or a literal bumped. */
function touch(r: () => number, line: string): string {
  const words = [...line.matchAll(/[A-Za-z_][A-Za-z0-9_]*|\d+/g)];
  if (words.length === 0) return `${line} x`;
  const w = pick(r, words);
  const replacement = /^\d/.test(w[0]) ? String(Number(w[0]) + 1) : `${w[0]}${pick(r, ['2', 'Next', '_v'])}`;
  return line.slice(0, w.index) + replacement + line.slice(w.index! + w[0].length);
}

/** One to three line edits of `text`, from lines of the same file: what a change looks like. */
function mutate(r: () => number, text: string): { text: string; ops: string[] } {
  const lines = text.split('\n');
  const ops: string[] = [];
  const count = int(r, 1, 3);
  for (let k = 0; k < count; k++) {
    const last = lines.length - 1; // the '' after a final newline stays last
    const i = int(r, 0, Math.max(0, last - 1));
    const kind = pick(r, ['replace', 'insert', 'insert-copy', 'delete'] as const);
    if (kind === 'replace' && lines[i]!.trim() !== '') {
      lines[i] = touch(r, lines[i]!);
      ops.push(`replace ${i + 1}`);
    } else if (kind === 'insert') {
      const indent = /^\s*/.exec(lines[i] ?? '')![0];
      lines.splice(i, 0, `${indent}${pick(r, ['Call();', 'x = 1;', 'return y;', '// note', 'value = value + 1;'])}`);
      ops.push(`insert at ${i + 1}`);
    } else if (kind === 'insert-copy') {
      const j = int(r, 0, Math.max(0, last - 1));
      lines.splice(i, 0, touch(r, lines[j]!));
      ops.push(`copy ${j + 1} to ${i + 1}`);
    } else if (lines.length > 3) {
      lines.splice(i, 1);
      ops.push(`delete ${i + 1}`);
    }
  }
  return { text: lines.join('\n'), ops };
}

/** print → parse gives the hunks back: the patch body and the note byte for byte, each
 *  literal as the matcher sees it — through `canon`. A literal is not kept byte for byte:
 *  a blank line inside a match block is not payload of a literal, so `#endif⏎⏎#if` reads
 *  back as `#endif⏎#if`, which no language tells apart once normalized. */
function samePrinted(
  file: SirFile,
  again: SirFile,
  canon: (raw: string) => string,
  where: string,
  body: (text: string) => string = (text) => text,
): void {
  const seen = (f: SirFile, k: number): FlatStep[] =>
    strip(f.hunks[k]!.match).map((s) => (s.anchor.raw === undefined ? s : { ...s, anchor: { ...s.anchor, raw: canon(s.anchor.raw) } }));
  assert.equal(again.hunks.length, file.hunks.length, `${where}: print → parse keeps the number of hunks`);
  file.hunks.forEach((h, k) => {
    assert.deepEqual(seen(again, k), seen(file, k), `${where}, hunk ${k + 1}: the pattern reads back the same`);
    assert.equal(body(again.hunks[k]!.patch), body(h.patch), `${where}, hunk ${k + 1}: the patch body reads back the same`);
    assert.equal(again.hunks[k]!.note?.text, h.note?.text, `${where}, hunk ${k + 1}: the note reads back the same`);
  });
}

/** A CR before a line end is a line ending, not payload ("Line endings are not payload"):
 *  a payload line that ends in a CR of its own (`x\r\r\n`) is not one the printer can
 *  write back, and need not be. */
const dropLineEndCr = (text: string): string => text.replace(/\r+(?=\n|$)/g, '');

/** For a file of no known language: the reading rules themselves — blank lines are not
 *  literal, and a CR before a line end is not payload. */
const dropBlankLines = (raw: string): string => dropLineEndCr(raw).replace(/\n(?:[ \t]*\n)+/g, '\n');

// ── generate → print → parse → apply == new, for every language ───────────────────

for (const language of LANGUAGES) {
  test(`property ${language}: generate → print → parse → apply reproduces the new text, or says it cannot anchor`, async () => {
    const adapter = await adapterFor(language);
    const files = corpus(language);
    assert.ok(files.length > 0, `the ${language} corpus has files to edit`);

    const cases = 12 * RUNS;
    let anchored = 0;
    for (let c = 0; c < cases; c++) {
      const seed = (SEED ^ (c * 2654435761) ^ language.length * 97) >>> 0;
      const r = rng(seed);
      const source = pick(r, files);
      const { text: next, ops } = mutate(r, source.text);
      if (next === source.text) continue;
      const exact = c % 2 === 0;
      const where = `seed ${SEED}, case ${c} (${source.name}: ${ops.join(', ')}; ${exact ? 'exact' : 'loose'})`;

      let hunks;
      try {
        hunks = synthesize(source.text, next, adapter, { exact });
      } catch (e) {
        assert.ok(e instanceof SynthesisError, `${where}: synthesize threw ${(e as Error).name}: ${(e as Error).message}`);
        assert.notEqual(e.reason, 'unreproduced', `${where}: synthesis kept hunks that do not give the new text`);
        continue;
      }
      anchored++;
      const printed = printSirFile(hunks, adapter.name);
      const file = parseSirFile(printed);
      samePrinted({ hunks }, file, (raw) => adapter.normalize(raw), where);
      const applied = applyAll(source.text, file, adapter).source;
      if (exact) assert.equal(applied, next, `${where}: the printed patch does not give the new text`);
      else assert.ok(sameIgnoringSpace(applied, next, adapter), `${where}: the printed patch does not give the new text`);
    }
    // a property nobody reaches checks nothing: most edits of real code must anchor
    assert.ok(anchored >= cases * 0.6, `${language}: only ${anchored} of ${cases} edits anchored`);
  });
}

// ── resolve: base is what a hunk replaced, final what it wrote ─────────────────────

/** Whether no edit reaches into text an earlier one wrote — a model of its own, not
 *  the projection `resolve` does: what each wrote, carried along as the text grows. */
function apart(edits: readonly { start: number; end: number; text: string }[]): boolean {
  let written: { start: number; end: number }[] = [];
  for (const e of edits) {
    const into = written.some((w) => (e.start < e.end ? e.start < w.end && w.start < e.end : w.start < e.start && e.start < w.end));
    if (into) return false;
    const shift = e.text.length - (e.end - e.start);
    written = written.map((w) => (w.end <= e.start ? w : { start: w.start + shift, end: w.end + shift }));
    written.push({ start: e.start, end: e.start + e.text.length });
  }
  return true;
}

for (const language of LANGUAGES) {
  test(`property ${language}: resolve puts each hunk where applying it replaced and wrote text`, async () => {
    const adapter = await adapterFor(language);
    const files = corpus(language);
    const cases = 12 * RUNS;
    let hunksSeen = 0;
    for (let c = 0; c < cases; c++) {
      const seed = (SEED ^ (c * 40503) ^ (language.length * 131)) >>> 0;
      const r = rng(seed);
      const source = pick(r, files);
      const { text: next, ops } = mutate(r, source.text);
      if (next === source.text) continue;
      const where = `seed ${SEED}, case ${c} (${source.name}: ${ops.join(', ')})`;
      let file: SirFile;
      try {
        file = parseSirFile(printSirFile(synthesize(source.text, next, adapter, { exact: true }), adapter.name));
      } catch (e) {
        if (e instanceof SynthesisError) continue;
        throw e;
      }
      const { links, applied } = resolveHunks(source.text, file, adapter);
      const { source: expected, edits } = applyAll(source.text, file, adapter);
      assert.equal(applied, expected, `${where}: resolve applies the hunks as apply does`);
      links.forEach((link, k) => {
        assert.equal(link.status, 'ok', `${where}, hunk ${k + 1}: a generated hunk resolves`);
        const { final } = link;
        assert.ok(0 <= final!.start && final!.start <= final!.end && final!.end <= applied.length, `${where}, hunk ${k + 1}: final lies in the applied text`);
        assert.equal(applied.slice(final!.start, final!.end), link.finalText, `${where}, hunk ${k + 1}: finalText is the text at final`);
      });

      // Hunks that each fit the old text on their own and keep off what the earlier ones
      // wrote — side by side is apart — are the case an editor shows most: there base is
      // exactly what a hunk replaced, final exactly what it wrote, and laid back over the
      // old text they give the applied one. A hunk may lean on what an earlier one wrote,
      // or rewrite it: then it has no place of its own in the old text, and these do not hold.
      if (!links.every((l) => !l.dependsOnEarlier) || !apart(edits.map((e) => e.edit))) continue;
      const order = links.map((l, k) => ({ l, k })).sort((a, b) => a.l.final!.start - b.l.final!.start || a.l.final!.end - b.l.final!.end);
      let rebuilt = '';
      let at = 0;
      for (const { l: link, k } of order) {
        hunksSeen++;
        const { base, final } = link;
        assert.equal(source.text.slice(base!.start, base!.end), edits[k]!.oldText, `${where}, hunk ${k + 1}: base is what it replaced`);
        assert.equal(link.finalText, edits[k]!.edit.text, `${where}, hunk ${k + 1}: final is what it wrote, nothing of another hunk's`);
        rebuilt += source.text.slice(at, base!.start);
        assert.equal(final!.start, rebuilt.length, `${where}, hunk ${k + 1}: final starts where its text stands in the applied text`);
        rebuilt += link.finalText;
        at = base!.end;
      }
      assert.equal(rebuilt + source.text.slice(at), applied, `${where}: the base spans with their final text give the applied text`);
    }
    assert.ok(hunksSeen >= cases * 0.6, `${language}: only ${hunksSeen} hunks in ${cases} cases`);
  });
}

// ── the parser: a .sirp that is not well formed is a ParseError, nothing else ──────

const TOKENS = [
  '# match', '# match cpp', '# match python', '# match nosuchlang', '# patch', '# end', '# note', '#  end', ' # end',
  '    ...', '    >>>', '    <<<', '    \\...', '    foo >>> bar <<< baz', '    int x;', '      body();', '',
  '    ', 'Sir: 2', 'Sir: 99', 'Sir: x', 'Target: ../x', 'Target: /abs', 'Target: a\\b', 'Base-Blob: z',
  'Sir-Version: 9', 'Grammar: g@1', 'X-Unknown: v', '```', '```cpp', 'prose', '\t# end', '    \u2028', '    é ☃ 😀',
];

function sirFiles(): string[] {
  const out: string[] = [];
  for (const language of LANGUAGES) {
    for (const kind of ['generate', 'apply']) {
      const dir = join(GOLDEN, language, kind);
      if (!isDir(dir)) continue;
      for (const f of readdirSync(dir).sort()) if (f.endsWith('.sirp')) out.push(readFileSync(join(dir, f), 'utf8'));
    }
  }
  return out;
}

function damage(r: () => number, text: string): string {
  let lines = text.split('\n');
  const count = int(r, 1, 3);
  for (let k = 0; k < count; k++) {
    const i = int(r, 0, Math.max(0, lines.length - 1));
    switch (int(r, 0, 7)) {
      case 0: lines.splice(i, 1); break;
      case 1: lines.splice(i, 0, lines[i] ?? ''); break;
      case 2: if (i + 1 < lines.length) [lines[i], lines[i + 1]] = [lines[i + 1]!, lines[i]!]; break;
      case 3: lines[i] = (lines[i] ?? '').slice(int(r, 1, 4)); break;
      case 4: lines.splice(i, 0, pick(r, TOKENS)); break;
      case 5: lines[i] = `${lines[i] ?? ''}${pick(r, [' ', '\r', '\t', ' >>>', ' ...', '\\'])}`; break;
      case 6: lines = lines.slice(0, i); break;
      default: lines[i] = pick(r, TOKENS);
    }
  }
  let out = lines.join('\n');
  // turned to CRLF the way git and editors do it: a line that already ends in CR keeps one
  if (r() < 0.2) out = out.replace(/\r?\n/g, '\r\n');
  return r() < 0.1 ? out.slice(0, int(r, 0, out.length)) : out;
}

function parsesOrRefuses(text: string, where: string): void {
  let file: SirFile;
  try {
    file = parseSirFile(text);
  } catch (e) {
    assert.ok(e instanceof ParseError, `${where}: ${(e as Error).name} instead of a ParseError: ${(e as Error).message}\n--- input ---\n${text}`);
    assert.ok(Number.isInteger(e.mdLine) && e.mdLine >= 0, `${where}: the ParseError names a line`);
    return;
  }
  // what reads must read again the same once printed
  samePrinted(file, parseSirFile(printSirFile(file.hunks, file.language)), dropBlankLines, where, dropLineEndCr);
}

test('fuzz: a damaged .sirp from the goldens is read or refused with a ParseError — never another error', () => {
  const sources = sirFiles();
  const started = Date.now();
  let refused = 0;
  const cases = 1500 * RUNS;
  for (let c = 0; c < cases; c++) {
    const r = rng((SEED + c * 7919) >>> 0);
    const text = damage(r, pick(r, sources));
    try {
      parsesOrRefuses(text, `seed ${SEED}, damage ${c}`);
    } catch (e) {
      throw e;
    }
    try {
      parseSirFile(text);
    } catch {
      refused++;
    }
  }
  assert.ok(refused > cases * 0.2 && refused < cases, `damage both breaks and spares files (${refused} of ${cases} refused)`);
  assert.ok(Date.now() - started < 20_000 * RUNS, 'no input makes the parser crawl');
});

test('fuzz: a .sirp made of format tokens at random is read or refused with a ParseError', () => {
  const cases = 1500 * RUNS;
  for (let c = 0; c < cases; c++) {
    const r = rng((SEED * 31 + c) >>> 0);
    const lines = Array.from({ length: int(r, 0, 30) }, () => pick(r, TOKENS));
    parsesOrRefuses(lines.join(r() < 0.2 ? '\r\n' : '\n'), `seed ${SEED}, random ${c}`);
  }
});

// ── normalization: canon of canon is canon, line by line ──────────────────────────
// Line by line, and only so: canon joins lines, so over several lines a `// comment` it
// joined would swallow the next line on a second pass (`// c⏎s = "a  b"` → `//c s="a  b"`,
// then the string is comment and collapses). Nothing normalizes canon text again — the
// source and an anchor are each normalized once, from what was written — so that is no
// fault; the per-line property is the one `sameIgnoringSpace` and the loose check lean on.

for (const language of LANGUAGES) {
  test(`property ${language}: normalize is idempotent on every line of real code`, async () => {
    const adapter = await adapterFor(language);
    for (const { name, text } of corpus(language)) {
      text.split('\n').forEach((line, i) => {
        const once = adapter.normalize(line);
        assert.equal(adapter.normalize(once), once, `${name}:${i + 1}: normalize(normalize(x)) ≠ normalize(x) for ${JSON.stringify(line)}`);
      });
    }
  });
}
