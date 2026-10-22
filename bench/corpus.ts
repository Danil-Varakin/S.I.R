// The stands the speed cases run on. Synthetic on purpose: a stand has to be the same
// on every machine and in every month, and a checkout of somebody's project is neither.
//
// Two regimes, and they must not be mixed — they differ by orders of magnitude:
//
//   'repeat'   bodies built from calls of the same SHAPE (`list->Add(kFlagN_M)`). A
//              generalized anchor collapses the argument to `...`, so every occurrence
//              reads alike. This is the worst case for the backtracking search.
//   'distinct' every line has a call name of its own, so an anchor is unique from the
//              first rung. Use this one for anything that is not about that worst case.

export type Regime = 'repeat' | 'distinct';

export interface CppFileOptions {
  readonly perBody?: number;
  readonly regime?: Regime;
}

/** A C++ file of `funcs` classes, each with a method whose body nests if/for. */
export function cppFile(funcs: number, options: CppFileOptions = {}): string {
  const perBody = options.perBody ?? 6;
  const regime = options.regime ?? 'distinct';
  const call = (f: number, b: number): string =>
    regime === 'repeat' ? `list->Add(kFlag${f}_${b})` : `Install${f}_${b}(list, opts)`;

  const out: string[] = ['#include "base/feature_list.h"', '#include "base/logging.h"', '', 'namespace content {', ''];
  for (let f = 0; f < funcs; f++) {
    const inNamespace = f % 7 === 0;
    if (inNamespace) out.push(`namespace detail_${f} {`, '');
    out.push(`class Handler${f} : public BaseHandler {`, ' public:');
    out.push(`  void Register${f}(FeatureList* list, const Options& opts) {`);
    for (let b = 0; b < perBody; b++) {
      if (b % 3 === 0) {
        out.push(`    if (opts.enable_${f}_${b}) {`, `      ${call(f, b)};`, `      LOG(INFO) << "flag ${f}.${b}";`, '    }');
      } else if (b % 3 === 1) {
        out.push(`    for (const auto& item : opts.items_${f}_${b}) {`, `      ${call(f, b)};`, '    }');
      } else {
        out.push(`    ${call(f, b)};`);
      }
    }
    out.push('  }', '', `  int Count${f}() const { return count_${f}_; }`, '', ' private:', `  int count_${f}_ = ${f};`, '};', '');
    if (inNamespace) out.push(`}  // namespace detail_${f}`, '');
  }
  out.push('}  // namespace content', '');
  return out.join('\n');
}

/** The same file with `n` edits spread through it: one line added to `n` method bodies. */
export function withEdits(text: string, n: number): { text: string; edits: number } {
  const lines = text.split('\n');
  const targets: number[] = [];
  for (const [i, line] of lines.entries()) if (/^ {4}(list->Add|Install)/.test(line)) targets.push(i);
  const step = Math.max(1, Math.floor(targets.length / n));
  const picked: number[] = [];
  for (let k = 0; k < n && k * step < targets.length; k++) picked.push(targets[k * step]!);
  for (const i of [...picked].reverse()) lines.splice(i + 1, 0, '    EnableNewPath(list);');
  return { text: lines.join('\n'), edits: picked.length };
}

/** One edit at a chosen nesting depth, file size held by `funcs`: tells "grows with the
 *  file" apart from "grows with the number of parents a pattern has to carry". */
export function nested(funcs: number, depth: number): string {
  const out: string[] = ['namespace content {', ''];
  for (let f = 0; f < funcs; f++) {
    let indent = '';
    const closers: string[] = [];
    if (depth >= 1) { out.push(`${indent}class Handler${f} {`, `${indent} public:`); closers.push(`${indent}};`); indent += '  '; }
    if (depth >= 2) { out.push(`${indent}void Register${f}(FeatureList* list, const Options& opts) {`); closers.push(`${indent}}`); indent += '  '; }
    if (depth >= 3) { out.push(`${indent}if (opts.enable_${f}) {`); closers.push(`${indent}}`); indent += '  '; }
    if (depth >= 4) { out.push(`${indent}for (const auto& item : opts.items_${f}) {`); closers.push(`${indent}}`); indent += '  '; }
    out.push(`${indent}Install${f}(list, item);`);
    for (const closer of closers.reverse()) out.push(closer);
    out.push('');
  }
  out.push('}  // namespace content', '');
  return out.join('\n');
}

/** The first call in a `nested` file, duplicated under another name: one edit. */
export function editFirstCall(text: string): string {
  const lines = text.split('\n');
  const i = lines.findIndex((line) => /Install\d+\(/.test(line));
  if (i === -1) throw new Error('corpus: no call to edit');
  lines.splice(i + 1, 0, lines[i]!.replace(/Install\d+\(/, 'EnableNewPath('));
  return lines.join('\n');
}

/** A hunk of the form `generate` settles on: a parent header and its closing token. */
export function patchFor(method: number, body = '      EnableNewPath(list);'): string {
  return `Hatch: 1\n\n# match cpp\n    ...\n    void Register${method}(\n    ...\n    ) {\n    ...\n    >>>\n    }\n    ...\n# end\n# patch\n${body}\n# end\n`;
}

// ── Python: the parent with no closing token (07-findings, С1) ─────────────────────────

/** A Python file of `classes` classes. Each opens with `def __init__` whose body runs
 *  `bodyLen` lines — past `maxSiblings`, so the parent's closer (the next class) is out
 *  of reach of the change unless an outdent may close the blocks it skips. Every class
 *  carries the same nested `def check(x):`, so a pattern without a parent is ambiguous. */
export function pyFile(classes: number, bodyLen = 12): string {
  const out: string[] = ['import os', ''];
  for (let c = 0; c < classes; c++) {
    out.push(`class Queue${c}:`, `    def __init__(self, limit=${c}):`);
    for (let b = 0; b < bodyLen; b++) out.push(`        self.field_${c}_${b} = limit + ${b}`);
    out.push('', '    def push(self, item):', '        def check(x):', '            return x', '        return check(item)', '');
    out.push('    def size(self):', `        return self.field_${c}_0`, '', '');
  }
  return out.join('\n');
}

/** The header of the middle class's `__init__` changed: the change opens a block. */
export function pyEditInit(text: string, classes: number): string {
  const c = Math.floor(classes / 2);
  return text.replace(`    def __init__(self, limit=${c}):`, `    def __init__(self, cap=${c}):`);
}

/** The nested `def check(x):` of the middle class changed — the same line stands in
 *  every class. */
export function pyEditCheck(text: string, classes: number): string {
  const lines = text.split('\n');
  const head = lines.indexOf(`class Queue${Math.floor(classes / 2)}:`);
  const at = lines.indexOf('        def check(x):', head);
  lines[at] = '        def check(y):';
  return lines.join('\n');
}

/** A hunk with the parent's header and its closer — the next class — around a change
 *  that opens a block: the form an outdent closing several blocks at once makes legal. */
export function pyPatchFor(c: number): string {
  const body = ['...', `class Queue${c}:`, '...', '>>>', `def __init__(self, limit=${c}):`, '<<<', '...', `class Queue${c + 1}:`, '...'];
  return `Hatch: 1\n\n# match python\n${body.map((l) => `    ${l}`).join('\n')}\n# end\n# patch\n    def __init__(self, cap=${c}):\n# end\n`;
}

/** The same edit in the form `generate` writes today: no parent. */
export function pyPatchParentless(c: number): string {
  const body = ['...', '>>>', `def __init__(self, limit=${c}):`, '<<<', '...'];
  return `Hatch: 1\n\n# match python\n${body.map((l) => `    ${l}`).join('\n')}\n# end\n# patch\n    def __init__(self, cap=${c}):\n# end\n`;
}

// ── neighbours on both sides (07-findings, С2) ─────────────────────────────────────────

/** `funcs` C++ functions of filler, and one that holds three look-alike triples: the
 *  first `go();` is told apart only by BOTH its neighbours standing right next to it. */
export function siblingsFile(funcs: number): string {
  const out: string[] = ['namespace content {', ''];
  for (let f = 0; f < funcs; f++) {
    out.push(`void Filler${f}(Options* opts) {`, `  Setup${f}(opts);`, `  Run${f}(opts);`, '}', '');
    if (f === Math.floor(funcs / 2)) {
      out.push('void Target() {', '  a();', '  go();', '  b();', '  a();', '  go();', '  c();', '  d();', '  go();', '  b();', '}', '');
    }
  }
  out.push('}  // namespace content', '');
  return out.join('\n');
}

/** The first `go();` of `Target` changed. */
export function siblingsEdit(text: string): string {
  return text.replace('  a();\n  go();\n  b();', '  a();\n  go(fast);\n  b();');
}

// ── Python depth: the search an outdent rule can grow (07-findings, С1) ────────────────

const PY_HEADERS = ['def register(self, opts):', 'if opts.enabled:', 'for item in opts.items:', 'while item.pending:', 'with item.lock:'];

/** `classes` classes, each nesting `depth` blocks: the class, then the same headers in
 *  every class — `def register`, `if`, `for`, `while`, `with` — so only the class name
 *  tells two places apart. The innermost body runs `bodyLen` lines, past `maxSiblings`,
 *  and a `def size` follows the chain in every class.
 *  The worst case for the rule: every inner header opens a block the pattern may now
 *  leave by an outdent, and each has a twin in every class. */
export function pyNested(classes: number, depth: number, bodyLen = 10): string {
  const out: string[] = ['import os', ''];
  for (let c = 0; c < classes; c++) {
    out.push(`class Handler${c}:`);
    let indent = '    ';
    for (let d = 1; d < depth; d++) {
      out.push(`${indent}${PY_HEADERS[d - 1]!}`);
      indent += '    ';
    }
    for (let b = 0; b < bodyLen; b++) out.push(`${indent}self.step_${c}_${b} = ${b}`);
    // a method after the chain: the changed block ends before the class does, so the
    // pattern leaves it by `...` — the expired entry the rule is about
    out.push('', '    def size(self):', `        return self.step_${c}_0`, '', '');
  }
  return out.join('\n');
}

/** The innermost header of the middle class changed — a line that opens a block, the
 *  change С1 is about; at depth 1 there is none, and a body line changes instead. */
export function pyNestedEdit(text: string, classes: number, depth: number): string {
  const lines = text.split('\n');
  const head = lines.indexOf(`class Handler${Math.floor(classes / 2)}:`);
  if (depth === 1) {
    lines[head + 1] = lines[head + 1]!.replace(/= 0$/, '= 100');
    return lines.join('\n');
  }
  const header = PY_HEADERS[depth - 2]!;
  const at = lines.findIndex((l, i) => i > head && l.trim() === header);
  lines[at] = lines[at]!.replace(/:$/, '  # changed:');
  return lines.join('\n');
}

// ── markup: HTML and XML, blocks that differ by an attribute of the header ────────────

/** A WebUI page of `rows` rows: each a <div> of the same shape, told apart only by its
 *  `id` — the header — like the rows of a settings page. */
export function htmlFile(rows: number): string {
  const out: string[] = ['<dom-module id="page">', '  <template>', '    <settings-section section="main">'];
  for (let r = 0; r < rows; r++) {
    out.push(
      `      <div class="settings-box" id="row${r}">`,
      `        <cr-link-row label="$i18n{rowLabel}"`,
      '            on-click="onRowClick_"></cr-link-row>',
      '        <span class="secondary">$i18n{rowDescription}</span>',
      '      </div>',
    );
  }
  out.push('    </settings-section>', '  </template>', '</dom-module>', '');
  return out.join('\n');
}

/** The middle row gains an element after its link row. */
export function htmlEdit(text: string, rows: number): string {
  const head = text.indexOf(`id="row${Math.floor(rows / 2)}">`);
  const at = text.indexOf('></cr-link-row>\n', head) + '></cr-link-row>\n'.length;
  return `${text.slice(0, at)}        <cr-toggle checked="{{enabled_}}"></cr-toggle>\n${text.slice(at)}`;
}

/** Android resources of `styles` styles of the same items, told apart only by `name`. */
export function xmlFile(styles: number): string {
  const out: string[] = ['<?xml version="1.0" encoding="utf-8"?>', '<resources>'];
  for (let s = 0; s < styles; s++) {
    out.push(
      `    <style name="Theme${s}" parent="Theme.AppCompat">`,
      '        <item name="colorPrimary">@color/default_primary</item>',
      '        <item name="windowActionBar">false</item>',
      '    </style>',
    );
  }
  out.push('</resources>', '');
  return out.join('\n');
}

/** The middle style gains an item. */
export function xmlEdit(text: string, styles: number): string {
  const head = text.indexOf(`name="Theme${Math.floor(styles / 2)}"`);
  const at = text.indexOf('</item>\n', head) + '</item>\n'.length;
  return `${text.slice(0, at)}        <item name="android:statusBarColor">@color/brand</item>\n${text.slice(at)}`;
}

/** A stylesheet of `rules` rules of the same declarations, told apart by the selector. */
export function cssFile(rules: number): string {
  const out: string[] = [':host {', '  --cr-section-padding: 20px;', '}', ''];
  for (let r = 0; r < rules; r++) {
    out.push(`.row-${r} .label {`, '  align-items: center;', '  display: flex;', '  min-height: 48px;', '}', '');
  }
  return out.join('\n');
}

/** The middle rule gains a declaration after `display`. */
export function cssEdit(text: string, rules: number): string {
  const head = text.indexOf(`.row-${Math.floor(rules / 2)} .label {`);
  const at = text.indexOf('  display: flex;\n', head) + '  display: flex;\n'.length;
  return `${text.slice(0, at)}  gap: 4px;\n${text.slice(at)}`;
}

/** A JSON file of `keys` objects of the same pairs, told apart by their key. */
export function jsonFile(keys: number): string {
  const out: string[] = ['{'];
  for (let k = 0; k < keys; k++) {
    out.push(`  "feature${k}": {`, '    "dependencies": ["permission:tabs"],', '    "contexts": ["privileged_extension"],', '    "channel": "stable"', `  }${k === keys - 1 ? '' : ','}`);
  }
  out.push('}', '');
  return out.join('\n');
}

/** The middle object gains a pair after `contexts`. */
export function jsonEdit(text: string, keys: number): string {
  const head = text.indexOf(`"feature${Math.floor(keys / 2)}": {`);
  const line = '    "contexts": ["privileged_extension"],\n';
  const at = text.indexOf(line, head) + line.length;
  return `${text.slice(0, at)}    "min_manifest_version": 3,\n${text.slice(at)}`;
}

/** Blink's feature list in JSON5: `features` entries of the same body, told apart by `name`. */
export function json5File(features: number): string {
  const out: string[] = ['{', '  data: [', ];
  for (let k = 0; k < features; k++) {
    out.push('    {', `      name: "Feature${k}",`, '      public: true,', '      status: {', '        "Win": "stable",', '        "default": "",', '      },', '    },');
  }
  out.push('  ],', '}', '');
  return out.join('\n');
}

/** The middle feature gains a pair after its name. */
export function json5Edit(text: string, features: number): string {
  const line = `      name: "Feature${Math.floor(features / 2)}",\n`;
  const at = text.indexOf(line) + line.length;
  return `${text.slice(0, at)}      base_feature_status: "disabled",\n${text.slice(at)}`;
}

/** Blink IDL read as text: `interfaces` interfaces of the same members, told apart by name. */
export function idlFile(interfaces: number): string {
  const out: string[] = [];
  for (let k = 0; k < interfaces; k++) {
    out.push('[', '    Exposed=Window', `] interface Thing${k} {`, '    readonly attribute long length;', '    [Measure, RaisesException] Float32Array getChannelData(', '        unsigned long channelIndex);', '};', '');
  }
  return out.join('\n');
}

/** The middle interface gains an attribute. */
export function idlEdit(text: string, interfaces: number): string {
  const head = text.indexOf(`interface Thing${Math.floor(interfaces / 2)} {`);
  const line = '    readonly attribute long length;\n';
  const at = text.indexOf(line, head) + line.length;
  return `${text.slice(0, at)}    readonly attribute long braveLength;\n${text.slice(at)}`;
}

// ── tuning: one model of code, every language, and the upstream drifting under it ──────
//
// What the `tuning` case asks: which settings of `generate` make a patch that keeps
// landing in the RIGHT place after upstream moves on, and which make it land in the
// wrong one. One model is rendered into every language, so a difference between two
// languages is the language and not the stand.
//
//   unit     = container (namespace / class / section / object)
//              └ function (name + parameters — the header `--parent-detail` spells)
//                ├ a statement at function level (`prepare`)
//                └ `depth - 1` nested blocks (`if` / `<div>` / `"on1": {`)
//                  └ five statements; the edit adds one after the third
//
// Regimes — how alike the units are:
//   'distinct'  every name of its own: a sibling line alone is unique
//   'repeat'    the same bodies, the same conditions; only the function name differs
//   'clone'     the same function too; only the CONTAINER differs — the patch needs the
//               outermost parent to tell them apart

export type TuneRegime = 'distinct' | 'repeat' | 'clone';

export interface TuneStmt { readonly name: string; readonly args: readonly string[] }

interface TuneUnit {
  readonly group: string;
  readonly func: string;
  readonly params: readonly string[];
  readonly prep: TuneStmt;
  readonly guard: string | null;
  readonly conds: readonly string[];
  readonly body: readonly TuneStmt[];
  /** The index in `body` the edit goes after; only the target unit has one. */
  readonly editAfter: number | null;
}

export interface TuneModel { readonly units: readonly TuneUnit[]; readonly indent: number }

/** `at` — where in the innermost block the edit goes: after its middle line, or after
 *  its last, where the block's closer can stand in for a sibling. */
export interface TuneShape {
  readonly units: number;
  readonly depth: number;
  readonly regime: TuneRegime;
  readonly at: 'middle' | 'end';
}

/** The model of a shape: `units` units, the target in the middle. */
export function tuneModel(shape: TuneShape): TuneModel {
  const target = Math.floor(shape.units / 2);
  const units: TuneUnit[] = [];
  for (let k = 0; k < shape.units; k++) {
    const own = shape.regime === 'distinct' ? `${k}_` : '';
    units.push({
      group: `g${k}`,
      func: shape.regime === 'clone' ? 'run' : `run${k}`,
      params: ['ctx', 'mode'],
      prep: { name: `prepare${shape.regime === 'distinct' ? k : ''}`, args: ['ctx'] },
      guard: null,
      conds: Array.from({ length: shape.depth - 1 }, (_, j) => `on${own}${j}`),
      body: Array.from({ length: 5 }, (_, i) => ({ name: `step${own}${i}`, args: ['ctx'] })),
      editAfter: k === target ? (shape.at === 'end' ? 4 : 2) : null,
    });
  }
  return { units, indent: 1 };
}

const NEW_STMT: TuneStmt = { name: 'newPath', args: ['ctx'] };

/** How upstream moved on. Each returns the model after the move, the edit still in the
 *  target unit — or `null` where the move means nothing for this shape. "Near" is the
 *  line the edit goes after, the one a pattern anchors on first. */
export const TUNE_DRIFTS: Readonly<Record<string, (m: TuneModel, s: TuneSyntax) => TuneModel | null>> = {
  /** Nothing moved: the patch must land on the file it was made from. */
  none: (m) => m,
  /** The line right above the edit gains an argument. */
  'near-args': (m) => bodyAt(m, 0, (s) => ({ ...s, args: [...s.args, 'extra'] })),
  /** The line right above the edit is renamed. */
  'near-rename': (m) => bodyAt(m, 0, (s) => ({ ...s, name: `${s.name}_v2` })),
  /** The line two above the edit is another line now. */
  'above-swap': (m) => bodyAt(m, -1, () => ({ name: 'audit', args: ['ctx'] })),
  /** The line right below the edit is another line now. */
  'below-swap': (m) => bodyAt(m, 1, () => ({ name: 'audit', args: ['ctx'] })),
  /** A line far from the edit, at function level, is another line now. */
  far: (m) => onTarget(m, (u) => ({ ...u, prep: { name: 'setup', args: ['ctx'] } })),
  /** The function's header gains a parameter. */
  'header-args': (m, s) => (s.hasParams ? onTarget(m, (u) => ({ ...u, params: [...u.params, 'flags'] })) : null),
  /** The innermost block's condition is renamed. */
  'cond-rename': (m) => (m.units[0]!.conds.length === 0 ? null : onTarget(m, (u) => ({ ...u, conds: u.conds.map((c, i) => (i === u.conds.length - 1 ? `${c}_v2` : c)) }))),
  /** The function is renamed. */
  'func-rename': (m) => onTarget(m, (u) => ({ ...u, func: `${u.func}_v2` })),
  /** The container (namespace, class, section) is renamed. */
  'outer-rename': (m) => onTarget(m, (u) => ({ ...u, group: `${u.group}_v2` })),
  /** A new block wraps everything in the function. */
  wrap: (m, s) => (s.canWrap ? onTarget(m, (u) => ({ ...u, guard: 'guard' })) : null),
  /** The target unit moved to the end of the file. */
  move: (m) => ({ ...m, units: [...m.units.filter((u) => u.editAfter === null), ...m.units.filter((u) => u.editAfter !== null)] }),
  /** A unit with the same body under another function, placed BEFORE the target. */
  'dup-body': (m) => insertBefore(m, (u) => ({ ...u, group: 'gx', func: `${u.func}_copy`, editAfter: null })),
  /** The same function in another container, placed BEFORE the target. */
  'dup-func': (m) => insertBefore(m, (u) => ({ ...u, group: 'gx', editAfter: null })),
  /** Every line indented twice as deep. */
  reindent: (m) => ({ ...m, indent: m.indent * 2 }),
  // ── the neighbours move: what a pattern may lean on that is not the target's own ──
  /** The target unit moved to the start of the file. */
  'move-first': (m) => ({ ...m, units: [...m.units.filter((u) => u.editAfter !== null), ...m.units.filter((u) => u.editAfter === null)] }),
  /** The target unit and the one before it changed places. */
  'swap-prev': (m) => swapWith(m, -1),
  /** The target unit and the one after it changed places. */
  'swap-next': (m) => swapWith(m, 1),
  /** The unit after the target is gone. */
  'next-gone': (m) => withoutAt(m, 1),
  /** The unit before the target is gone. */
  'prev-gone': (m) => withoutAt(m, -1),
  /** A new unit of the same shape, its own names, right after the target. */
  'next-new': (m) => insertNear(m, 1),
  /** A new unit of the same shape, its own names, right before the target. */
  'prev-new': (m) => insertNear(m, 0),
};

function targetIndex(m: TuneModel): number {
  return m.units.findIndex((u) => u.editAfter !== null);
}

function swapWith(m: TuneModel, offset: -1 | 1): TuneModel | null {
  const at = targetIndex(m);
  const other = at + offset;
  if (other < 0 || other >= m.units.length) return null;
  const units = [...m.units];
  [units[at], units[other]] = [units[other]!, units[at]!];
  return { ...m, units };
}

function withoutAt(m: TuneModel, offset: -1 | 1): TuneModel | null {
  const other = targetIndex(m) + offset;
  if (other < 0 || other >= m.units.length) return null;
  return { ...m, units: m.units.filter((_, i) => i !== other) };
}

/** A unit like the target, under names of its own, at `targetIndex + offset`. */
function insertNear(m: TuneModel, offset: 0 | 1): TuneModel {
  const at = targetIndex(m) + offset;
  const t = m.units[targetIndex(m)]!;
  const fresh: TuneUnit = { ...t, group: 'gnew', func: t.func === 'run' ? 'run' : 'runnew', editAfter: null };
  return { ...m, units: [...m.units.slice(0, at), fresh, ...m.units.slice(at)] };
}

/** The body line `offset` from the one the edit goes after; `null` past either end. */
function bodyAt(m: TuneModel, offset: number, f: (s: TuneStmt) => TuneStmt): TuneModel | null {
  const u = m.units.find((x) => x.editAfter !== null)!;
  const at = u.editAfter! + offset;
  if (at < 0 || at >= u.body.length) return null;
  return onTarget(m, (x) => ({ ...x, body: x.body.map((s, i) => (i === at ? f(s) : s)) }));
}

function onTarget(m: TuneModel, f: (u: TuneUnit) => TuneUnit): TuneModel {
  return { ...m, units: m.units.map((u) => (u.editAfter === null ? u : f(u))) };
}

function insertBefore(m: TuneModel, f: (u: TuneUnit) => TuneUnit): TuneModel {
  const at = m.units.findIndex((u) => u.editAfter !== null);
  return { ...m, units: [...m.units.slice(0, at), f(m.units[at]!), ...m.units.slice(at)] };
}

// ── rendering: the same model in each language ─────────────────────────────────────────

type Tree = string | { readonly open: string; readonly close: string | null; readonly kids: readonly Tree[] };

export interface TuneSyntax {
  readonly language: string;
  readonly hasParams: boolean;
  /** Whether the function can hold a block at all (CSS cannot nest one). */
  readonly canWrap: boolean;
  /** The deepest `depth` the language can render. */
  readonly maxDepth: number;
  readonly width: number;
  /** `,` between items, as JSON needs; nothing elsewhere. */
  readonly separator?: string;
  readonly root?: { readonly open: string; readonly close: string; readonly before?: readonly string[] };
  container(name: string): [string, string | null];
  func(name: string, params: readonly string[]): [string, string | null];
  block(cond: string): [string, string | null];
  stmt(s: TuneStmt): string;
}

const brace = (open: string, close = '}'): [string, string] => [`${open} {`, close];

export const TUNE_SYNTAX: Readonly<Record<string, TuneSyntax>> = {
  cpp: {
    language: 'cpp', hasParams: true, canWrap: true, maxDepth: 9, width: 2,
    container: (n) => brace(`namespace ${n}`, `}  // namespace ${n}`),
    func: (n, p) => brace(`void ${n}(${p.map((x) => `int ${x}`).join(', ')})`),
    block: (c) => brace(`if (ctx->${c})`),
    stmt: (s) => `${s.name}(${s.args.join(', ')});`,
  },
  java: {
    language: 'java', hasParams: true, canWrap: true, maxDepth: 9, width: 4,
    container: (n) => brace(`class ${n.toUpperCase()}`),
    func: (n, p) => brace(`void ${n}(${p.map((x) => `int ${x}`).join(', ')})`),
    block: (c) => brace(`if (ctx.${c})`),
    stmt: (s) => `${s.name}(${s.args.join(', ')});`,
  },
  javascript: {
    language: 'javascript', hasParams: true, canWrap: true, maxDepth: 9, width: 2,
    container: (n) => brace(`class ${n.toUpperCase()}`),
    func: (n, p) => brace(`${n}(${p.join(', ')})`),
    block: (c) => brace(`if (ctx.${c})`),
    stmt: (s) => `${s.name}(${s.args.join(', ')});`,
  },
  typescript: {
    language: 'typescript', hasParams: true, canWrap: true, maxDepth: 9, width: 2,
    container: (n) => brace(`class ${n.toUpperCase()}`),
    func: (n, p) => brace(`${n}(${p.map((x) => `${x}: number`).join(', ')}): void`),
    block: (c) => brace(`if (ctx.${c})`),
    stmt: (s) => `${s.name}(${s.args.join(', ')});`,
  },
  go: {
    language: 'go', hasParams: true, canWrap: true, maxDepth: 9, width: 4,
    root: { open: '', close: '', before: ['package main', ''] },
    container: (n) => brace(`func ${n}()`),
    func: (n, p) => brace(`${n} := func(${p.map((x) => `${x} int`).join(', ')})`),
    block: (c) => brace(`if ctx.${c}`),
    stmt: (s) => `${s.name}(${s.args.join(', ')})`,
  },
  rust: {
    language: 'rust', hasParams: true, canWrap: true, maxDepth: 9, width: 4,
    container: (n) => brace(`mod ${n}`),
    func: (n, p) => brace(`fn ${n}(${p.map((x) => `${x}: i32`).join(', ')})`),
    block: (c) => brace(`if ctx.${c}`),
    stmt: (s) => `${s.name}(${s.args.join(', ')});`,
  },
  kotlin: {
    language: 'kotlin', hasParams: true, canWrap: true, maxDepth: 9, width: 4,
    container: (n) => brace(`class ${n.toUpperCase()}`),
    func: (n, p) => brace(`fun ${n}(${p.map((x) => `${x}: Int`).join(', ')})`),
    block: (c) => brace(`if (ctx.${c})`),
    stmt: (s) => `${s.name}(${s.args.join(', ')})`,
  },
  python: {
    language: 'python', hasParams: true, canWrap: true, maxDepth: 9, width: 4,
    container: (n) => [`class ${n.toUpperCase()}:`, null],
    func: (n, p) => [`def ${n}(self, ${p.join(', ')}):`, null],
    block: (c) => [`if ctx.${c}:`, null],
    stmt: (s) => `${s.name}(${s.args.join(', ')})`,
  },
  html: {
    language: 'html', hasParams: true, canWrap: true, maxDepth: 9, width: 2,
    root: { open: '<body>', close: '</body>' },
    container: (n) => [`<section id="${n}">`, '</section>'],
    func: (n, p) => [`<form name="${n}" data-params="${p.join(' ')}">`, '</form>'],
    block: (c) => [`<div class="${c}">`, '</div>'],
    stmt: (s) => `<input name="${s.name}" value="${s.args.join(' ')}">`,
  },
  xml: {
    language: 'xml', hasParams: true, canWrap: true, maxDepth: 9, width: 4,
    root: { open: '<resources>', close: '</resources>', before: ['<?xml version="1.0" encoding="utf-8"?>'] },
    container: (n) => [`<group id="${n}">`, '</group>'],
    func: (n, p) => [`<task name="${n}" params="${p.join(' ')}">`, '</task>'],
    block: (c) => [`<when test="${c}">`, '</when>'],
    stmt: (s) => `<step name="${s.name}" args="${s.args.join(' ')}"/>`,
  },
  json: {
    language: 'json', hasParams: false, canWrap: true, maxDepth: 9, width: 2, separator: ',',
    root: { open: '{', close: '}' },
    container: (n) => [`"${n}": {`, '}'],
    func: (n) => [`"${n}": {`, '}'],
    block: (c) => [`"${c}": {`, '}'],
    stmt: (s) => `"${s.name}": [${s.args.map((a) => `"${a}"`).join(', ')}]`,
  },
  css: {
    language: 'css', hasParams: true, canWrap: false, maxDepth: 1, width: 2,
    container: (n) => brace(`@supports (--${n}: 1)`),
    func: (n, p) => brace(`.${n}:is(${p.map((x) => `.${x}`).join(', ')})`),
    block: () => { throw new Error('css: no nested block'); },
    stmt: (s) => `--${s.name}: f(${s.args.join(', ')});`,
  },
  json5: {
    language: 'json5', hasParams: false, canWrap: true, maxDepth: 9, width: 2, separator: ',',
    root: { open: '{', close: '}' },
    container: (n) => [`${n}: {`, '}'],
    func: (n) => [`${n}: {`, '}'],
    block: (c) => [`${c}: {`, '}'],
    stmt: (s) => `${s.name}: [${s.args.map((a) => `"${a}"`).join(', ')}]`,
  },
  proto: {
    language: 'proto', hasParams: false, canWrap: true, maxDepth: 9, width: 2,
    container: (n) => brace(`message ${n.toUpperCase()}`),
    func: (n) => brace(`message ${n}`),
    block: (c) => brace(`oneof ${c}`),
    stmt: (s) => `optional string ${s.name} = 1 [default = "${s.args.join(' ')}"];`,
  },
  mojom: {
    language: 'mojom', hasParams: true, canWrap: true, maxDepth: 9, width: 2,
    container: (n) => brace(`interface ${n.toUpperCase()}`, '};'),
    func: (n, p) => brace(`struct ${n}${p.length > 0 ? `_${p.join('_')}` : ''}`, '};'),
    block: (c) => brace(`union ${c}`, '};'),
    stmt: (s) => `int32 ${s.name} = ${s.args.length};`,
  },
  shell: {
    language: 'shell', hasParams: false, canWrap: true, maxDepth: 9, width: 2,
    container: (n) => brace(`${n}()`),
    func: (n) => brace(`${n}()`),
    block: (c) => [`if [ -n "$${c}" ]; then`, 'fi'],
    stmt: (s) => `${s.name} "${s.args.join(' ')}"`,
  },
  yaml: {
    language: 'yaml', hasParams: false, canWrap: true, maxDepth: 9, width: 2,
    container: (n) => [`${n}:`, null],
    func: (n) => [`${n}:`, null],
    block: (c) => [`${c}:`, null],
    stmt: (s) => `${s.name}: ${s.args.join(' ')}`,
  },
  idl: {
    language: 'idl', hasParams: true, canWrap: true, maxDepth: 9, width: 4,
    container: (n) => brace(`interface ${n.toUpperCase()}`, '};'),
    func: (n, p) => brace(`operation ${n}(${p.map((x) => `long ${x}`).join(', ')})`, '};'),
    block: (c) => brace(`group ${c}`, '};'),
    stmt: (s) => `${s.name}(${s.args.join(', ')});`,
  },
};

// ── the same model, the unit without a block of its own ───────────────────────────────
//
// In TUNE_SYNTAX every unit is a block with its closer: whatever a pattern leans on
// inside it is the unit's own. Here the container is a line that starts a unit and
// nothing ends it but the next unit (`case G1:`, `<li>`, `[g1]`, `#if`): the units stand
// side by side inside one block, and the line after the target unit is the first line of
// another. Python's defect (BACKLOG §1, "сосед снизу вместо закрывашки") is a pattern
// leaning on that line; these ask whether any other language does. The `tuning-flat`
// case of `bench/run.ts`.
export const TUNE_FLAT: Readonly<Record<string, TuneSyntax>> = {
  'cpp-case': {
    language: 'cpp', hasParams: true, canWrap: true, maxDepth: 9, width: 2,
    root: { open: 'switch (g) {', close: '}\n}', before: ['void Dispatch(int g, int ctx, int mode) {'] },
    container: (n) => [`case ${n.toUpperCase()}:`, 'break;'],
    func: (n, p) => brace(`while (${n}(${p.join(', ')}))`),
    block: (c) => brace(`if (ctx->${c})`),
    stmt: (s) => `${s.name}(${s.args.join(', ')});`,
  },
  'go-case': {
    language: 'go', hasParams: true, canWrap: true, maxDepth: 9, width: 4,
    root: { open: 'switch g {', close: '}\n}', before: ['package main', '', 'func dispatch(g, ctx, mode int) {'] },
    container: (n) => [`case ${n.toUpperCase()}:`, null],
    func: (n, p) => brace(`for ${n}(${p.join(', ')})`),
    block: (c) => brace(`if ctx.${c}`),
    stmt: (s) => `${s.name}(${s.args.join(', ')})`,
  },
  'cpp-ifdef': {
    language: 'cpp', hasParams: true, canWrap: true, maxDepth: 9, width: 2,
    container: (n) => [`#if BUILDFLAG(${n.toUpperCase()})`, '#endif'],
    func: (n, p) => brace(`void ${n}(${p.map((x) => `int ${x}`).join(', ')})`),
    block: (c) => brace(`if (ctx->${c})`),
    stmt: (s) => `${s.name}(${s.args.join(', ')});`,
  },
  'html-li': {
    language: 'html', hasParams: true, canWrap: true, maxDepth: 9, width: 2,
    root: { open: '<ul>', close: '</ul>' },
    container: (n) => [`<li id="${n}">`, null],
    func: (n, p) => [`<form name="${n}" data-params="${p.join(' ')}">`, '</form>'],
    block: (c) => [`<div class="${c}">`, '</div>'],
    stmt: (s) => `<input name="${s.name}" value="${s.args.join(' ')}">`,
  },
  'shell-case': {
    language: 'shell', hasParams: false, canWrap: true, maxDepth: 9, width: 2,
    root: { open: 'case "$1" in', close: 'esac' },
    container: (n) => [`${n})`, ';;'],
    func: (n) => brace(`${n}()`),
    block: (c) => [`if [ -n "$${c}" ]; then`, 'fi'],
    stmt: (s) => `${s.name} "${s.args.join(' ')}"`,
  },
  // JavaScript inside `<script>`: the grammar of HTML reads it as raw text, no block in it
  'html-script': {
    language: 'html', hasParams: true, canWrap: true, maxDepth: 9, width: 2,
    root: { open: '<script>', close: '</script>' },
    container: (n) => [`const ${n} = {`, '};'],
    func: (n, p) => [`${n}(${p.join(', ')}) {`, '},'],
    block: (c) => brace(`if (ctx.${c})`),
    stmt: (s) => `${s.name}(${s.args.join(', ')});`,
  },
  // shell with no braces at all: `if … fi`, `for … done` are words, not brackets, and the
  // text reading makes no block of them
  'shell-if': {
    language: 'shell', hasParams: false, canWrap: true, maxDepth: 9, width: 2,
    container: (n) => [`if [ "$1" = "${n}" ]; then`, 'fi'],
    func: (n) => [`for item in ${n}; do`, 'done'],
    block: (c) => [`if [ -n "$${c}" ]; then`, 'fi'],
    stmt: (s) => `${s.name} "${s.args.join(' ')}"`,
  },
  text: {
    language: 'text', hasParams: false, canWrap: true, maxDepth: 9, width: 2,
    container: (n) => [`== ${n} ==`, null],
    func: (n) => [`${n}:`, null],
    block: (c) => [`when ${c}:`, null],
    stmt: (s) => `${s.name} ${s.args.join(' ')}`,
  },
  toml: {
    language: 'toml', hasParams: false, canWrap: true, maxDepth: 9, width: 2,
    container: (n) => [`[${n}]`, null],
    func: (n) => [`[${n}.task]`, null],
    block: (c) => [`[${c}.when]`, null],
    stmt: (s) => `${s.name} = "${s.args.join(' ')}"`,
  },
};

/** The text of a model in a language; `edited` — with the new line in the target unit. */
export function tuneRender(syntax: TuneSyntax, model: TuneModel, edited: boolean): string {
  const unit = (u: TuneUnit): Tree => {
    const body: Tree[] = [];
    for (const [i, s] of u.body.entries()) {
      body.push(syntax.stmt(s));
      if (edited && u.editAfter === i) body.push(syntax.stmt(NEW_STMT));
    }
    let inner: Tree[] = body;
    for (const c of [...u.conds].reverse()) {
      const [open, close] = syntax.block(c);
      inner = [{ open, close, kids: inner }];
    }
    if (u.guard !== null) {
      const [open, close] = syntax.block(u.guard);
      inner = [{ open, close, kids: inner }];
    }
    const [fOpen, fClose] = syntax.func(u.func, u.params);
    const [cOpen, cClose] = syntax.container(u.group);
    return { open: cOpen, close: cClose, kids: [{ open: fOpen, close: fClose, kids: [syntax.stmt(u.prep), ...inner] }] };
  };
  const step = ' '.repeat(syntax.width * model.indent);
  const out: string[] = [...(syntax.root?.before ?? [])];
  const emit = (trees: readonly Tree[], indent: string): void => {
    for (const [i, t] of trees.entries()) {
      const sep = syntax.separator !== undefined && i < trees.length - 1 ? syntax.separator : '';
      if (typeof t === 'string') { out.push(`${indent}${t}${sep}`); continue; }
      out.push(`${indent}${t.open}`);
      emit(t.kids, indent + step);
      if (t.close !== null) out.push(`${indent}${t.close}${sep}`);
    }
  };
  const units = model.units.map(unit);
  if (syntax.root === undefined || syntax.root.open === '') {
    emit(units, '');
  } else {
    out.push(syntax.root.open);
    emit(units, step);
    out.push(syntax.root.close);
  }
  out.push('');
  return out.join('\n');
}
