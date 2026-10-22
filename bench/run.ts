// Speed and performance cases, repeatable. NOT part of `npm test`: the heavy ones take
// minutes, and a suite that takes minutes stops being run.
//
//   npm run bench                  every case at its default sizes
//   npm run bench -- --case apply  one case (parse | apply | generate | probes | depth |
//                                  python | python-depth | siblings | markup | tuning)
//   npm run bench -- --reps 9 --budget 60000 --big
//   npm run bench -- --case tuning --lang python --detail   one language, every shape
//
// Measured IN PROCESS, through the library API: process start (~0.1 s) and loading the
// grammar are outside the measurement, because what they cost is already known and does
// not move. Recorded numbers do not live here: they go into the backlog, under the one
// item that owns performance (Г3), with the stand each was taken on — a measurement is
// written down there before it is used in an argument.

import { applyAll } from '../src/core/apply.ts';
import { parseSirFile } from '../src/core/sir-parser.ts';
import { printPattern } from '../src/core/sir-printer.ts';
import { resolveHunks } from '../src/core/resolve.ts';
import { generatePatch } from '../src/generate/pipeline.ts';
import type { SynthEvent } from '../src/generate/synth.ts';
import { cppAdapter } from '../src/lang/cpp/index.ts';
import { pythonAdapter } from '../src/lang/python/index.ts';
import { htmlAdapter } from '../src/lang/html/index.ts';
import { xmlAdapter } from '../src/lang/xml/index.ts';
import { cssAdapter } from '../src/lang/css/index.ts';
import { jsonAdapter } from '../src/lang/json/index.ts';
import { json5Adapter } from '../src/lang/json5/index.ts';
import { idlAdapter } from '../src/lang/idl/index.ts';
import type { LanguageAdapter } from '../src/lang/source-map.ts';
import { adapterForLanguage } from '../src/lang/adapter.ts';
import type { PartialLimits } from '../src/generate/limits.ts';
import {
  cppFile, cssEdit, cssFile, editFirstCall, htmlEdit, htmlFile, nested, patchFor, pyEditCheck, pyEditInit, pyFile, pyNested,
  pyNestedEdit, pyPatchFor, pyPatchParentless,
  TUNE_DRIFTS, TUNE_FLAT, TUNE_SYNTAX, tuneModel, tuneRender,
  idlEdit, idlFile, json5Edit, json5File, jsonEdit, jsonFile, siblingsEdit, siblingsFile, withEdits, xmlEdit, xmlFile,
} from './corpus.ts';
import type { TuneSyntax } from './corpus.ts';

interface Options {
  readonly case: string | undefined;
  readonly reps: number;
  readonly budgetMs: number;
  readonly big: boolean;
  readonly lang: string | undefined;
  readonly detail: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const number = (name: string, fallback: number): number => {
    const raw = value(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} takes a positive number, not '${raw}'`);
    return n;
  };
  return {
    case: value('--case'),
    reps: number('--reps', 5),
    budgetMs: number('--budget', 20_000),
    big: argv.includes('--big'),
    lang: value('--lang'),
    detail: argv.includes('--detail'),
  };
}

const ms = (x: number): string => (x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${x.toFixed(1)}`);

/** Median of up to `reps` runs after one warm-up. A single run past the budget is
 *  reported alone: the point of the budget is that one case cannot eat the suite. */
async function measure(opts: Options, body: () => Promise<void> | void): Promise<{ median: number; capped: boolean }> {
  const started = performance.now();
  await body();
  const warm = performance.now() - started;
  if (warm > opts.budgetMs) return { median: warm, capped: true };
  const xs: number[] = [];
  for (let i = 0; i < opts.reps; i++) {
    const t = performance.now();
    await body();
    xs.push(performance.now() - t);
  }
  xs.sort((a, b) => a - b);
  return { median: xs[Math.floor(xs.length / 2)]!, capped: false };
}

function row(cells: readonly string[], widths: readonly number[]): string {
  return cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  ');
}

async function cell(opts: Options, body: () => Promise<void> | void): Promise<string> {
  const { median, capped } = await measure(opts, body);
  return capped ? `${ms(median)}*` : ms(median);
}

// ── parse: what one tree-sitter parse costs, the floor under apply ────────────────────
async function caseParse(opts: Options): Promise<void> {
  const W = [16, 9, 11] as const;
  console.log(row(['lines', 'KB', 'buildMap'], W));
  for (const funcs of sizes(opts)) {
    const source = cppFile(funcs);
    console.log(row([
      String(source.split('\n').length),
      (source.length / 1024).toFixed(0),
      await cell(opts, () => { cppAdapter.buildMap(source); }),
    ], W));
  }
}

// ── apply: a patch that FITS — the build's case, and sync's ───────────────────────────
async function caseApply(opts: Options): Promise<void> {
  const W = [16, 9, 11, 11, 13, 12] as const;
  console.log(row(['lines', 'KB', 'buildMap', 'apply 1', 'resolve 1', 'apply 10'], W));
  for (const funcs of sizes(opts)) {
    const source = cppFile(funcs);
    const one = parseSirFile(patchFor(0));
    const stride = Math.max(1, Math.floor(funcs / 10));
    const ten = parseSirFile(
      `Sir: 2\n\n${Array.from({ length: 10 }, (_, i) => patchFor(i * stride).split('\n\n').slice(1).join('\n\n')).join('\n')}`,
    );
    console.log(row([
      String(source.split('\n').length),
      (source.length / 1024).toFixed(0),
      await cell(opts, () => { cppAdapter.buildMap(source); }),
      await cell(opts, () => { applyAll(source, one, cppAdapter); }),
      await cell(opts, () => { resolveHunks(source, one, cppAdapter); }),
      await cell(opts, () => { applyAll(source, ten, cppAdapter); }),
    ], W));
  }
}

// ── generate: synthesis, the one that does not scale ──────────────────────────────────
async function caseGenerate(opts: Options): Promise<void> {
  const W = [16, 9, 8, 11, 12] as const;
  console.log(row(['lines', 'KB', 'edits', 'generate', 'per edit'], W));
  for (const regime of ['distinct', 'repeat'] as const) {
    console.log(`\n  regime: ${regime}`);
    for (const funcs of sizes(opts)) {
      const oldText = cppFile(funcs, { regime });
      const { text: newText, edits } = withEdits(oldText, 3);
      const { median, capped } = await measure(opts, async () => {
        await generatePatch({ oldText, newText, language: 'cpp' });
      });
      console.log(row([
        String(oldText.split('\n').length),
        (oldText.length / 1024).toFixed(0),
        String(edits),
        capped ? `${ms(median)}*` : ms(median),
        ms(median / edits),
      ], W));
      if (median > opts.budgetMs * 2) { console.log('  (stopping this regime: past twice the budget)'); break; }
    }
  }
}

// ── probes: WHERE synthesis spends it — how many probes, and the worst one ────────────
async function caseProbes(opts: Options): Promise<void> {
  const W = [16, 8, 11, 13, 11] as const;
  console.log(row(['lines', 'probes', 'total', 'worst probe', 'its result'], W));
  let worstPattern = '';
  for (const funcs of sizes(opts)) {
    const oldText = cppFile(funcs);
    const { text: newText } = withEdits(oldText, 3);
    let probes = 0;
    let worst = 0;
    let worstResult = '';
    let last = performance.now();
    const trace = (event: SynthEvent): void => {
      const now = performance.now();
      if (event.kind === 'attempt') {
        probes++;
        if (now - last > worst) {
          worst = now - last;
          worstResult = `${event.result}/${event.matches}`;
          worstPattern = printPattern(event.pattern).split('\n').join(' / ');
        }
      }
      last = now;
    };
    const started = performance.now();
    await generatePatch({ oldText, newText, language: 'cpp', trace });
    const total = performance.now() - started;
    console.log(row([String(oldText.split('\n').length), String(probes), ms(total), ms(worst), worstResult], W));
    if (total > opts.budgetMs * 2) break;
  }
  if (worstPattern !== '') console.log(`\n  worst pattern: ${worstPattern.slice(0, 200)}`);
}

// ── depth: one edit, nesting 1..4 — the control that says size alone is innocent ──────
async function caseDepth(opts: Options): Promise<void> {
  const counts = opts.big ? [25, 50, 100, 200, 400] : [25, 50, 100, 200];
  const W = [16, ...counts.map(() => 9)] as const;
  console.log(row(['depth \\ classes', ...counts.map(String)], W));
  for (const depth of [1, 2, 3, 4]) {
    const cells: string[] = [];
    for (const funcs of counts) {
      const oldText = nested(funcs, depth);
      const newText = editFirstCall(oldText);
      cells.push(await cell(opts, async () => { await generatePatch({ oldText, newText, language: 'cpp' }); }));
    }
    console.log(row([String(depth), ...cells], W));
  }
  console.log(`\n  (lines at the widest: ${nested(counts[counts.length - 1]!, 4).split('\n').length})`);
}

// ── python: a parent with no closing token — the change opens a block (07-findings, С1) ─
/** What a run ended with, for the table: `ok`, or the reason/kind it failed with. */
async function outcome(body: () => Promise<unknown>): Promise<string> {
  try {
    await body();
    return 'ok';
  } catch (e) {
    const reason = (e as { reason?: unknown }).reason;
    return typeof reason === 'string' ? reason : (e as Error).name;
  }
}

async function casePython(opts: Options): Promise<void> {
  const W = [16, 9, 13, 13, 13, 13] as const;
  console.log(row(['lines', 'KB', 'gen init', '→', 'gen check', '→'], W));
  for (const classes of sizes(opts)) {
    const oldText = pyFile(classes);
    const cells: string[] = [];
    for (const edit of [pyEditInit, pyEditCheck]) {
      const newText = edit(oldText, classes);
      const run = () => generatePatch({ oldText, newText, language: 'python' });
      const result = await outcome(run);
      cells.push(await cell(opts, async () => { await run().catch(() => undefined); }), result);
    }
    console.log(row([String(oldText.split('\n').length), (oldText.length / 1024).toFixed(0), ...cells], W));
  }
  console.log('');
  const A = [16, 11, 13, 13, 13, 13] as const;
  console.log(row(['lines', 'buildMap', 'parent+closer', '→', 'parentless', '→'], A));
  for (const classes of sizes(opts)) {
    const source = pyFile(classes);
    const mid = Math.floor(classes / 2);
    const cells: string[] = [];
    for (const text of [pyPatchFor(mid), pyPatchParentless(mid)]) {
      const file = parseSirFile(text);
      const status = resolveHunks(source, file, pythonAdapter).links[0]?.status ?? '?';
      cells.push(await cell(opts, () => { resolveHunks(source, file, pythonAdapter); }), status);
    }
    console.log(row([
      String(source.split('\n').length),
      await cell(opts, () => { pythonAdapter.buildMap(source); }),
      ...cells,
    ], A));
  }
}

// ── python-depth: nesting 1..6, the same headers in every class (С1) ─────────────────
async function casePythonDepth(opts: Options): Promise<void> {
  const counts = opts.big ? [25, 50, 100, 200, 400] : [25, 50, 100, 200];
  const W = [16, ...counts.map(() => 16)] as const;
  console.log(row(['depth \\ classes', ...counts.map(String)], W));
  for (const depth of [1, 2, 3, 4, 5, 6]) {
    const cells: string[] = [];
    let past = false;
    for (const classes of counts) {
      // past the budget once, the bigger cells of the row are skipped: one of them ran
      // 14 minutes (Г3, 2026-10-20), and a row is told by where it crosses the budget
      if (past) { cells.push('—'); continue; }
      const oldText = pyNested(classes, depth);
      const newText = pyNestedEdit(oldText, classes, depth);
      const run = () => generatePatch({ oldText, newText, language: 'python' });
      const started = performance.now();
      const result = await outcome(run);
      if (performance.now() - started > opts.budgetMs) {
        past = true;
        cells.push(`${ms(performance.now() - started)}* ${result === 'ok' ? 'ok' : result.slice(0, 5)}`);
        continue;
      }
      const time = await cell(opts, async () => { await run().catch(() => undefined); });
      cells.push(`${time} ${result === 'ok' ? 'ok' : result.slice(0, 5)}`);
      if (time.endsWith('*')) past = true;
    }
    console.log(row([String(depth), ...cells], W));
  }
  console.log(`\n  (lines at the widest: ${pyNested(counts[counts.length - 1]!, 6).split('\n').length}; — = skipped, the row went past the budget)`);
}

// ── siblings: a change told apart only by BOTH neighbours right next to it (С2) ───────
async function caseSiblings(opts: Options): Promise<void> {
  const W = [16, 22, 13, 13] as const;
  console.log(row(['lines', 'limits', 'generate', '→'], W));
  for (const funcs of sizes(opts)) {
    const oldText = siblingsFile(funcs);
    const newText = siblingsEdit(oldText);
    for (const [label, limits] of [['maxSiblings 1', { maxSiblings: 1 }], ['default', undefined]] as const) {
      const run = () => generatePatch({ oldText, newText, language: 'cpp', limits });
      const result = await outcome(run);
      console.log(row([
        String(oldText.split('\n').length),
        label,
        await cell(opts, async () => { await run().catch(() => undefined); }),
        result,
      ], W));
    }
  }
}

// ── markup: HTML, XML, CSS, JSON, JSON5, IDL — blocks told apart only by their header ─
async function caseMarkup(opts: Options): Promise<void> {
  const W = [16, 9, 11, 11, 11, 11] as const;
  const kinds: [string, LanguageAdapter, (n: number) => string, (t: string, n: number) => string][] = [
    ['html', htmlAdapter, htmlFile, htmlEdit],
    ['xml', xmlAdapter, xmlFile, xmlEdit],
    ['css', cssAdapter, cssFile, cssEdit],
    ['json', jsonAdapter, jsonFile, jsonEdit],
    ['json5', json5Adapter, json5File, json5Edit],
    ['idl', idlAdapter, idlFile, idlEdit],
  ];
  for (const [language, adapter, make, edit] of kinds) {
    console.log(`\n  ${language}`);
    console.log(row(['lines', 'KB', 'buildMap', 'generate', 'apply 1', 'hunks'], W));
    for (const n of sizes(opts).map((k) => k * 10)) {
      const oldText = make(n);
      const newText = edit(oldText, n);
      const { md, hunkCount } = await generatePatch({ oldText, newText, language });
      const patch = parseSirFile(md);
      console.log(row([
        String(oldText.split('\n').length),
        (oldText.length / 1024).toFixed(0),
        await cell(opts, () => { adapter.buildMap(oldText); }),
        await cell(opts, async () => { await generatePatch({ oldText, newText, language }); }),
        await cell(opts, () => { applyAll(oldText, patch, adapter); }),
        String(hunkCount),
      ], W));
    }
  }
}

// ── tuning: which settings keep a patch landing in the RIGHT place after upstream moves ─
//
// For every language, shape (depth × regime) and profile of settings: `generate` once,
// then the patch is applied to the old file after each drift of TUNE_DRIFTS. A drift
// ends one of three ways:
//   ok      — landed, and the result is the drifted file with the edit where it belongs
//   refused — did not land (no fit, or ambiguous): a person looks, nothing is broken
//   WRONG   — landed somewhere else: the one outcome a setting must never buy
// Lines are compared trimmed, blank lines dropped: a patch that keeps its own indent on
// a reindented file is not wrong.

export const PROFILES: readonly (readonly [string, PartialLimits & { exact?: boolean }])[] = [
  ['default', {}],
  ['parents 1', { maxParents: 1 }],
  ['parents 2', { maxParents: 2 }],
  ['min-parents 0', { minParents: 0 }],
  ['min-parents 9', { minParents: 9 }],
  ['siblings 0', { maxSiblings: 0 }],
  ['siblings 2', { maxSiblings: 2 }],
  ['min-siblings 2', { minSiblings: 2 }],
  ['parent-detail 1', { parentDetailBase: 1 }],
  ['parent-detail 9', { parentDetailBase: 9 }],
  ['sibling-detail 1', { siblingDetailBase: 1 }],
  ['structural', { minParents: 9, maxSiblings: 0, parentsRequired: true }],
  ['exact', { exact: true }],
];

const TUNE_LANGS = ['cpp', 'java', 'javascript', 'typescript', 'go', 'rust', 'kotlin', 'python', 'html', 'xml', 'json', 'css', 'idl', 'json5', 'proto', 'mojom', 'shell', 'yaml'];

const flat = (text: string): string => text.split('\n').map((l) => l.trim()).filter((l) => l !== '').join('\n');

/** Lines inside the `# match` blocks of a `.sirp` — how much a patch leans on. */
function matchLines(md: string): number {
  let inside = false;
  let n = 0;
  for (const line of md.split('\n')) {
    if (/^# match\b/.test(line)) inside = true;
    else if (/^# end\b/.test(line)) inside = false;
    else if (inside) n++;
  }
  return n;
}

export interface TuneCell { gen: string; lines: number; ms: number; drifts: Map<string, 'ok' | 'refused' | 'WRONG' | null> }

export async function tuneOne(
  language: string, shape: Parameters<typeof tuneModel>[0], settings: PartialLimits & { exact?: boolean }, budgetMs: number,
): Promise<TuneCell> {
  const syntax = TUNE_SYNTAX[language] ?? TUNE_FLAT[language]!;
  const adapter = adapterForLanguage(syntax.language);
  const model = tuneModel(shape);
  const oldText = tuneRender(syntax, model, false);
  const newText = tuneRender(syntax, model, true);
  const { exact, ...limits } = settings;
  const started = performance.now();
  let md: string;
  try {
    ({ md } = await generatePatch({ oldText, newText, language: syntax.language, limits, exact, signal: AbortSignal.timeout(budgetMs) }));
  } catch (e) {
    const reason = (e as { reason?: unknown }).reason;
    return { gen: typeof reason === 'string' ? reason : (e as Error).name, lines: 0, ms: performance.now() - started, drifts: new Map() };
  }
  const ms = performance.now() - started;
  const patch = parseSirFile(md);
  const drifts = new Map<string, 'ok' | 'refused' | 'WRONG' | null>();
  for (const [name, drift] of Object.entries(TUNE_DRIFTS)) {
    const moved = drift(model, syntax);
    if (moved === null) { drifts.set(name, null); continue; }
    const base = tuneRender(syntax, moved, false);
    const want = tuneRender(syntax, moved, true);
    try {
      const got = applyAll(base, patch, adapter).source;
      drifts.set(name, flat(got) === flat(want) ? 'ok' : 'WRONG');
    } catch {
      drifts.set(name, 'refused');
    }
  }
  return { gen: 'ok', lines: matchLines(md), ms, drifts };
}

async function caseTuning(opts: Options): Promise<void> {
  await tuneGrid(opts, TUNE_SYNTAX, TUNE_LANGS);
}

// The same grid on TUNE_FLAT: a unit with no block of its own, the next unit right after
// it — does a pattern lean on the next unit's first line, as Python's does?
async function caseTuningFlat(opts: Options): Promise<void> {
  await tuneGrid(opts, TUNE_FLAT, Object.keys(TUNE_FLAT));
}

async function tuneGrid(opts: Options, syntaxes: Readonly<Record<string, TuneSyntax>>, all: readonly string[]): Promise<void> {
  const langs = opts.lang === undefined ? all : opts.lang.split(',');
  const depths = opts.big ? [1, 2, 3, 5] : [1, 2, 3];
  const units = opts.big ? 24 : 8;
  const regimes = ['distinct', 'repeat', 'clone'] as const;
  const driftNames = Object.keys(TUNE_DRIFTS);
  const short = (d: string): string => d.slice(0, 6);
  console.log(`  ${units} units; depth ${depths.join(', ')}; regimes ${regimes.join(', ')}; the edit in the middle of a block and at its end`);
  console.log('  each drift column: ok of the shapes it applies to; !N = N landed WRONG');
  console.log('  gen: shapes generated; lines: mean of the # match lines; ms: mean generate\n');
  const W = [17, 6, 6, 7, ...driftNames.map(() => 7), 8] as const;
  for (const language of langs) {
    const syntax = syntaxes[language];
    if (syntax === undefined) throw new Error(`tuning: no syntax for '${language}' — one of ${Object.keys(syntaxes).join(', ')}`);
    await adapterForLanguage(syntax.language).init();
    const shapes = depths.filter((d) => d <= syntax.maxDepth)
      .flatMap((depth) => regimes.flatMap((regime) => (['middle', 'end'] as const).map((at) => ({ units, depth, regime, at }))));
    console.log(`\n  ${language}`);
    console.log(row(['profile', 'gen', 'lines', 'ms', ...driftNames.map(short), 'survive'], W));
    for (const [label, settings] of PROFILES) {
      const cells: TuneCell[] = [];
      for (const shape of shapes) {
        const c = await tuneOne(language, shape, settings, opts.budgetMs);
        cells.push(c);
        if (opts.detail) {
          const marks = driftNames.map((d) => ({ ok: '✓', refused: '·', WRONG: '✗', null: ' ' } as const)[String(c.drifts.get(d) ?? null) as 'ok']).join('');
          console.log(`    ${label.padEnd(17)} d${shape.depth} ${shape.regime.padEnd(8)} ${shape.at.padEnd(6)} ${c.gen.padEnd(10)} ${String(c.lines).padStart(3)} ${marks}`);
        }
      }
      const made = cells.filter((c) => c.gen === 'ok');
      const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
      let okAll = 0;
      let all = 0;
      const perDrift = driftNames.map((d) => {
        const outcomes = cells.map((c) => (c.gen === 'ok' ? c.drifts.get(d) : 'refused')).filter((x) => x !== null);
        const ok = outcomes.filter((x) => x === 'ok').length;
        const wrong = outcomes.filter((x) => x === 'WRONG').length;
        if (d !== 'none') { okAll += ok; all += outcomes.length; }
        return outcomes.length === 0 ? '—' : `${ok}/${outcomes.length}${wrong > 0 ? `!${wrong}` : ''}`;
      });
      console.log(row([
        label,
        `${made.length}/${cells.length}`,
        mean(made.map((c) => c.lines)).toFixed(1),
        mean(made.map((c) => c.ms)).toFixed(0),
        ...perDrift,
        `${Math.round((100 * okAll) / Math.max(1, all))}%`,
      ], W));
    }
  }
}

function sizes(opts: Options): number[] {
  return opts.big ? [10, 25, 50, 100, 300, 600] : [10, 25, 50, 100];
}

const CASES = new Map<string, (opts: Options) => Promise<void>>([
  ['parse', caseParse],
  ['apply', caseApply],
  ['generate', caseGenerate],
  ['probes', caseProbes],
  ['depth', caseDepth],
  ['python', casePython],
  ['python-depth', casePythonDepth],
  ['siblings', caseSiblings],
  ['markup', caseMarkup],
  ['tuning', caseTuning],
  ['tuning-flat', caseTuningFlat],
]);

export async function main(argv: readonly string[]): Promise<void> {
  const opts = parseOptions(argv);
  const chosen = opts.case === undefined ? [...CASES.keys()] : [opts.case];
  for (const name of chosen) {
    if (!CASES.has(name)) throw new Error(`unknown case '${name}' — one of ${[...CASES.keys()].join(', ')}`);
  }
  await cppAdapter.init();
  await pythonAdapter.init();
  await htmlAdapter.init();
  await xmlAdapter.init();
  await cssAdapter.init();
  await jsonAdapter.init();
  await json5Adapter.init();
  console.log(
    `\nsir bench — synthetic C++, Python, HTML, XML, CSS, JSON, JSON5 and IDL, Node ${process.versions.node}, ${process.platform}-${process.arch}\n` +
      `up to ${opts.reps} runs after a warm-up, median; budget ${opts.budgetMs / 1000} s per cell ` +
      `(* = one run, past the budget); times in ms unless marked s\n`,
  );
  for (const name of chosen) {
    console.log(`\n── ${name} ──`);
    await CASES.get(name)!(opts);
  }
  console.log('');
}
