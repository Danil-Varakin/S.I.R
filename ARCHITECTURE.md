# Architecture

## The one principle that drives everything

**All nesting is balanced once, by the language adapter, during `buildMap`, and
frozen into an immutable `SourceMap`. The matcher never keeps a file-depth stack
and never counts brackets while matching — it queries the prebuilt map like a
reference table.**

There is not a single `case '}'` in `src/core/`. Every structural decision the
matcher makes is a comparison of numbers, because the `{open, close}` pairs were
computed by tree-sitter at map-build time.

Consequences:

- "Arbitrary nesting" (a target at any depth, through hidden intermediate
  namespaces) works for free: the target is found as an anchor, and the closing
  token of its block comes from the map. Intermediate levels never participate.
- The matcher keeps only a small stack of blocks that **the pattern itself
  opened** with its literals. Its depth equals the number of opening tokens
  written in the pattern, independent of the file's real nesting.

Contract: **garbage in, garbage out.** The adapter assumes compilable input;
checking language syntax is not its job. tree-sitter parses even the preprocessor
cleanly — both branches of an `#if/#else` land in the tree with correct nesting —
so there is no "undefined-depth zone" for brace imbalance. The residual risk is
`ERROR` nodes on macro-heavy code.

## Where each rule lives

One rule, one home. The map of the repository is in
[README.md](./README.md#project-layout); this is the shorter question — *if I need to
change X, which file owns it?*

| the rule | its home |
|---|---|
| what a `.sirp` looks like: headings in column 0, the four-space gutter | `core/sir-parser.ts` — the headings are exported from there, the printer imports them |
| the header's fields and their order | `core/header.ts`, the `FIELDS` table: the reader, the writer and the type are all made of it |
| the format range `FORMAT_MIN..FORMAT_VERSION` | `core/header.ts` |
| how a pattern is walked, and what counts as ambiguous | `core/matcher.ts` |
| where an edit cuts, and which line ending it takes | `core/patcher.ts` + `core/eol.ts` |
| which error gets which exit code | `core/errors.ts` — the code travels with the error |
| what "insignificant whitespace" means | `normalize` in `lang/<language>/index.ts`, never the core |
| what counts as a block | `blockOf` in `lang/<language>/index.ts`, read off the tree-sitter tree |
| canonical ↔ original coordinates | `lang/canon.ts`, pointwise, no standing index arrays |
| which grammar, pinned to which sha256 | `lang/<language>/index.ts`; finding the bytes is `infra/grammar-store.ts` |
| which name or extension means which language | `lang/adapter.ts`, a closed whitelist |
| how a change becomes a hunk | `generate/synth.ts`; what counts as one change is `generate/diff.ts` |
| whose a file is — which config speaks for it, where the upstream root is | `infra/project.ts`; nobody else computes a project root |
| code ↔ patch, both ways | `infra/pair.ts` forward through `infra/out-path.ts` |
| the file-system rules: atomic write, the walk up, path containment | `infra/fs.ts` |
| facts → text, and the exit code of a failed run | `infra/log.ts` |
| the wire: every field of every method | `service/protocol.ts`, borrowing nothing from the core |

## The file format has no delimiter code can contain

A patch file is `# match <lang>` … `# end` / `# patch` … `# end`, and **every
payload line carries a four-space gutter** that is stripped on read. The headings
are recognized in column 0 only, so a payload line can never reach column 0: a
` ``` ` fence, a `# patch` heading or a `# end` inside a raw string is text.

Why not Markdown fences: Chromium raw strings contain fences (embedded documentation,
markdown in test data), and a bare fence inside a patch body would close the block
early — the file parses, applies, and one line silently vanishes from the output.
Lengthening the fence when the payload holds one repairs only what sir's own printer
emits; a hand-written `.sirp` keeps the trap.

The gutter rule is checkable in one sentence. Its consequences are load-bearing elsewhere: a payload line that forgets the gutter is
a parse error rather than a silent loss; `# end` bounds the block, so blank lines
inside it (trailing ones included) are payload and the patch body round-trips byte
for byte; and the gutter is stripped by exactly four characters, so relative
indentation survives — the precondition for Python, where indent is syntax.

One limit is inherent and documented in the README: a payload line made of
*significant trailing whitespace* is indistinguishable from junk to a
whitespace fixer. Printing and parsing preserve it; `generate` warns when it emits
such a line.

## The core ↔ lang boundary

Complexity is split along two physical axes that meet at one narrow contract:

- `src/core/` — **S.I.R semantics**, with zero knowledge of brackets, indents, or
  tree-sitter.
- `src/lang/` — **everything language-dependent**: nesting (`buildMap`, via
  tree-sitter) and text canonicalization (`normalize`).
- `src/lang/source-map.ts` — the **only** bridge. The matcher and the synthesizer
  import this and nothing else from `lang/`.

The test for a correct boundary: *if adding a language forces a change in
`core/`, the boundary is wrong.* A new language is one new folder under `lang/`,
plus two lines in the adapter registry (`lang/adapter.ts`, a closed whitelist —
never a dynamic `import()` of a name taken from an untrusted `.sirp`).

```ts
interface BlockSpan {          // canonical coordinates
  open: number;                // opening token (Python block: its `:`)
  close: number;               // its pair    (Python block: end of the body)
  headerStart?: number;        // start of the construct's header — synth only
  closeEnd?: number;           // end of the closing token       — synth only
}

interface SourceMap {                          // ALL positions are CANONICAL
  matchesAt(norm, pos): boolean;               // match here? (respects token boundaries)
  occurrences(norm, from, to): Iterable<number>; // purely textual anchor occurrences, lazily
  countOccurrences(norm, from, to): number;    // how many, without listing them
  enclosing(pos): BlockSpan[];                 // enclosing blocks, innermost first
  blocksWithin(from, to): BlockSpan[];         // blocks fully inside a range — synth only
  readonly eof: number;                        // canonical length
  toOriginalPos(pos, side): number;            // canonical mark → ORIGINAL offset
  toCanonPos(origPos): number;                 // ORIGINAL offset → canonical
}

interface LanguageAdapter {
  init(): Promise<void>;                       // load tree-sitter grammar (WASM), once
  buildMap(source): SourceMap;                 // synchronous after init
  normalize(raw): string;                      // how to canonicalize literal text
  readonly name: string;                       // the language's own name: `# match cpp`
  extensions: readonly string[];
  readonly grammar: GrammarSource;             // file, package, version, sha256 pin
}
```

|                | C++ implements as                          | Python implements as                   |
|----------------|--------------------------------------------|----------------------------------------|
| `BlockSpan`    | `{ }` pair from the tree-sitter tree       | an indented block: from its `:` to the end of the body; brackets as in C++ |
| `headerStart`  | start of the owning node (`void foo(…)`)   | start of the `def`/`class`/`if` line   |
| `closeEnd`     | just past `}`                              | absent for an indented block — there is no closing token |
| `occurrences`  | textual search over the canonical string   | same                                   |
| `normalize`    | indentation dropped                        | leading indentation **preserved**      |

Two fields exist purely for the synthesizer and take no part in matching:
`headerStart` (so a parent anchor is the *header* of a construct — `void foo(…)` —
rather than a useless lone `{` in Allman style) and `closeEnd` (so the pattern can
*close* what it opened). Both are optional: a bare nested block `{ … }` has no
meaningful header, and a language without a closing token has no `closeEnd`. The
consumer must cope with their absence.

The map is **tested in isolation** from the matcher — spans asserted directly on
tricky inputs (brackets inside strings, raw literals, preprocessor zones). That
isolates the buggiest part of the system into a unit-testable unit.

## Coordinates: canonical throughout, original only for marks

The matcher works **entirely in canonical space** (the source after `normalize`):
`pos += norm.length` is trivial. Positions are translated to **original** offsets
only for marks, only at the end, via `toOriginalPos`. This is sound because
`normalize` only touches whitespace, so the subsequence of non-whitespace
characters is identical in the canonical and original text. There are **no
standing canon↔original index arrays** — the translation is pointwise, by aligning
non-whitespace characters. `toCanonPos` is the inverse, needed by the synthesizer,
which learns about an edit in original coordinates (line numbers) but must reason
in canonical ones.

`matchesAt` stays `boolean` (not `number|null`): the cursor is canonical and the
match length is `norm.length`, so advancing is trivial.

## The AST: a sequence of steps

A pattern is a sequence of **steps** `(gap, anchor)`. The gap says *how* to
advance the cursor; the anchor says *what* to stop on — a literal, or end-of-file.
Literals consume text; gaps carry the zero-width marks (`>>>`, `<<<`).

```ts
type GapMode = { op: 'tight' } | { op: 'skipAny' };      // no gap | ...
interface PlacedMark { side: 'left' | 'right'; mdLine: number; }
interface Literal { raw: string; mdSpan: [number, number]; }  // RAW text; canon is the adapter's job
interface Gap { mode: GapMode; insert?: PlacedMark; replaceEnd?: PlacedMark; }
type Anchor = { target: 'literal'; literal: Literal } | { target: 'eof' };
interface Step { gap: Gap; anchor: Anchor; }
interface MatchPattern { steps: Step[]; }
interface Note { text: string; mdSpan: [number, number]; }    // `# note` … `# end`
interface Hunk { match: MatchPattern; patch: string; mdSpan?: [number, number]; note?: Note; }
```

`mdSpan` is where the literal came from in the `.sirp`, used for error messages. It
is optional on `Hunk` because a synthesized hunk has no `.sirp` origin. `note` is the
author's comment on the hunk; the matcher never reads it.

**Marks anchor to "symbol + side."** A mark sits between characters, with a side
that binds it to one non-whitespace character:

- `side='left'` (recorded **before** the jump): anchor = the previous literal's
  last non-whitespace char; the edit starts right after it. No previous literal
  (first step) → position 0 = **BOF**.
- `side='right'` (recorded **after** the jump): anchor = the next anchor's first
  non-whitespace char; the edit starts right before it. No next (reached EOF) →
  `source.length` = **EOF**.

So `A >>> ... B` inserts right after A (left); `A ... >>> B` inserts before B
(right). In the `.sirp` the side is readable from the position of the marker
relative to `...`. **BOF/EOF are not a separate flag** — they are the degenerate
boundaries of this rule. Replace ranges follow the same rule: `>>>` gives the
start, `<<<` the end.

End-of-file is an explicit, typed anchor, so "insert at end" and "no literals at
all" are union variants, not special-cased empty trailing gaps. Discriminants are
domain-named (`op`, `target`), not a generic `kind`.

## How the matcher walks a pattern

The walk is a depth-first search with backtracking over a cursor, a stack, and the
marks collected so far. Three rules carry all the weight:

**An unclosed opening token orders, it does not lock.** When a literal covers the
`open` of a block, the matcher pushes that block's `close` onto its stack — a
*promise* that the pattern will get there. But the search for the next anchor
still runs to end of file. Escaping an open block is legal; it just leaves an
expired entry behind. This is why a pattern must spell out a construct's closing
token if it wants to stay inside that construct.

**Obligation before search.** If the top of the stack is still ahead of the cursor
and the next anchor matches exactly there, that position is taken
**unconditionally** — the pair was chosen by the tree, not by text search. Only if
the rest of the pattern then fails does the matcher fall back to scanning
occurrences (skipping the position it already tried). This is what makes a
trailing `}` in a pattern resolve to *its own* pair rather than to the next `}` in
the file.

**A closer may not strand an earlier open block.** When the candidate anchor
covers the `close` of a block opened outside it, the jump is rejected if any entry
on the stack lies before the candidate: you cannot close an outer or later block
while leaving an earlier one open.

Uniqueness is judged **by the resulting edit**, not by the path taken: two search
branches that produce the same mark positions are one match. A second, *different*
edit raises `AmbiguityError` and the search stops. On failure, the matcher reports
the deepest position it reached and which step failed.

## Apply runs hunks sequentially

`apply` applies hunks **one at a time, each against the current (already-mutated)
state**:

```
await adapter.init()                 // load the tree-sitter grammar once
current = read(inFile)
for each hunk:
    map = adapter.buildMap(current)  // map of the CURRENT text (O(n) per hunk)
    edit = patcher(matcher(hunk.match, map), current)
    current = apply(edit, current)
write_atomic(outFile, current)       // one temp+rename at the end
```

This lets a hunk anchor to content a previous hunk introduced (matching against
the pristine original couldn't find it), and it is what makes `generate` tractable
when changes cluster — the synthesizer emits *dependent* hunks anchored to the
progressively-transformed surroundings. The cost is one `buildMap` (tree-sitter
parse) per hunk — negligible for typical patches. Atomicity is preserved: one
write of the final string.

The patcher itself is deliberately dumb: canonical marks → original offsets → one
splice. It does **not** check whether the patch was already applied; if the
matcher found a place, the edit happens. There is exactly one edit per hunk (the
parser enforces one `>>>`), so there is no "apply end-to-start" ordering problem.

## Normalization lives in the adapter, not the core

"What counts as insignificant whitespace" is a fact about the *language*, exactly
like "what is a bracket." So it is `LanguageAdapter.normalize(raw): string`, not a
core function. The core stores the literal **raw**. The parser is language-neutral
and runs *before* the language is chosen, so it has nothing to normalize with; the
matcher computes the canon lazily once the adapter is known, caching it per run
(each pattern literal is normalized once, not once per backtrack).

- **C++** (also fine for C-likes): whitespace is significant *only between two word
  characters* `[A-Za-z0-9_]`; everywhere else — around punctuation, newlines, and
  the leading indent — it is dropped. So `int x` ≠ `intx`, but
  `features {` ≡ `features{`. Whitespace **inside a string literal is data** and is
  kept verbatim, so `Log("a  b")` and `Log("a b")` are different anchors. The
  exception is a literal that spans lines (`R"(…)"`, a docstring, a template
  literal): a `.sirp` anchor is a fragment cut on line boundaries and can begin inside
  one without knowing it, so those stay transparent. Where a language's string
  literals start and end is declared per language; the scanner is shared
  (`lang/zones.ts`).
- **Python** (`lang/python/normalize.ts`): the leading indent is *preserved* as a
  level marker. That is why the parser keeps the leading whitespace of a
  line-start fragment in `raw`.

Structure (`buildMap`) comes from tree-sitter for both; only `normalize` differs.

## The two pipelines share one source of truth

```
apply:    .sirp ─parse→ MatchPattern ┐
          source ─buildMap→ SourceMap ┘─matcher→ marks ─patcher→ (per hunk) → atomic write

generate: (old,new) ─diff→ segments ─synth→ Hunk[] ─printer→ .sirp
```

`generate` queries the *same* `SourceMap` that `apply` uses. One source of truth
about file structure feeds both pipelines, so they cannot drift apart.

The header of a `.sirp` (`Sir`, `Target`, `Base-Blob`, `Sir-Version`,
`Grammar`) lives in `src/core/header.ts`: one table of the fields in their order — the
reader, the writer and the `HeaderFields` type are all made of it, so a field is added
in one line, at the end (VERSIONING.md H4) — `readHeader` (the lines as written),
`parseHeader` (held to the format range `FORMAT_MIN..FORMAT_VERSION` and to a contained
`Target`), `printHeader`. The parser checks the format and reads the hunks after it
exactly as before; the matcher never sees the header. `infra/pair.ts` reads `Target`
back to name a patch's file, and tells a newer or older format and a header that does
not read from an unsafe `Target`.

Whose a file is — which `sir.config.json` speaks for it, and where the code a project
patches lives — is decided in one place, `src/infra/project.ts`. A config may name an
`upstream`: the root of code the project does not own (the upstream a fork patches), measured
from the config file. `configFileFor`/`loadProject` find the config (up from the file;
else one whose upstream claims it; else `$SIR_CONFIG`, the current directory),
`upstreamTarget` turns a file into its `Target`, `upstreamCode` a `Target` back into
the file. `out-path.ts` (where a patch goes), `pair.ts` (both ways), the CLI and the
service all ask it; none of them computes a project root of its own. Git is not part of
it: the base of a file is read from the repository nearest that file.

### diff → atomic segments

`generate/diff.ts` is the only place that touches the `diff` package. Above the
raw unified-diff hunks it produces **atomic change segments**: one insertion, one
deletion or one replacement each — that is, exactly one S.I.R hunk, honouring the
core rule of one `>>>` per hunk. Runs of unchanged lines split segments, so the
default is maximally fine-grained; a bridging budget can pull adjacent edits back
together when a coincidentally-identical line splits one logical change (blank
lines are bridged for free).

### synth: anchoring is structural, never positional

For each segment the synthesizer builds a `HunkContext` — the current file, its
map, the canonical bounds of the edit, and the chain of enclosing blocks that have
a header and are not destroyed by the edit itself. From it, candidate patterns are
generated **lazily**, cheapest first, along two axes:

- the **cut form** — how the edit's location is described (insert before/after an
  anchor, replace exactly the removed text, replace between two context anchors,
  replace the gap between neighbours);
- the **context ladder** — parents first (innermost outward), then detail inside
  generalized brackets, and only as a last resort neighbouring lines, which drift.

The nearest parent is included from the very first rung even when the edit is
already unique, because a bare minimum (`... >>> target = 1; <<< ...`) carries no
structure and will happily land in a different function once the file moves. Each
parent contributes two anchors: its **header** (up to and including the opening
token, so the matcher takes its closing token as an obligation) and its **closing
token**. Context anchors are generalized — the balanced innards of brackets
collapse to `...` — so an anchor survives edits to an argument list.

**Nothing is trusted.** Every candidate is run through the real matcher and the
real patcher, and is accepted only if applying it reproduces the intended file.
The patch body is not assembled by hand either: it is sliced out of the intended
file between the very same cut offsets, so whatever whitespace falls inside the
cut is carried along.

By default "reproduces" is judged **per line, after normalization** — indentation
and inner spacing are free, the set of lines is not. Whole-text normalized
comparison would be wrong: `normalize` treats a newline as ordinary whitespace, so
a hunk that swallowed an entire line would pass, and later segments — addressed by
line number against the progressively patched file — would then be built against
the wrong text and fail far from the real mistake. `--exact` tightens acceptance
and the final check to byte-for-byte.

### steer: when a person decides

`generate -a`, and any `generate` at a terminal whose synthesis cannot anchor a change,
runs the same steps one at a time (`generate/steer.ts`). Its whole state is the list of
hunks so far and what they make of the old version: each step takes the first change
still between that text and the new one. A hunk synthesis made is laid on that text
once — it was made against it and lands there only — which gives what replaying every
hunk over the old version would, at the price of one; hunks a person wrote are replayed
from the old version. A hunk offered is shown and kept, or the
person is handed the editor with **every** hunk so far; what comes back must parse and
land on the old version in order, or it goes back with the reason on top. Because the
next step starts from what the hunks produce, a hunk written by hand — pattern and patch
body alike — is simply the new state. Text a hunk wrote counts as settled and is not
offered again, so a body edited on purpose stays edited, and the run ends warning that
the `.sirp` does not give the new version. A `# note` written in the editor stays with
its hunk: the printer writes it before the `# match` it is about. The person comes in
from outside (`Steering`: review, offer the editor, edit), which keeps the loop testable
without a terminal.

The service runs the same loop with no one at it (`unattended`), because the state is
only text: a change synthesis cannot anchor ends the run with a `SynthesisError` whose
draft is what the editor would get — every hunk so far and a hunk to start from
(`generate/draft.ts`, which the batch synthesis uses too) — and the client sends it back,
finished, as `keep`. `keep` is checked as an edit is, replayed as the first state, and
printed byte for byte ahead of the hunks made after it. Nothing is held between requests.

### Line endings belong to the file

A `.sirp` carries no line endings of its own: the parser reads `\r\n` and `\n` alike, and
git or an editor may turn them either way. So the patcher lands a patch with the ending
of the line the edit starts on — CRLF in a CRLF region, the bytes as they are in LF.
The line, not the file: a file of mixed endings keeps what each place has.

## Diagnostics and invariants (green on every commit)

- **Parser round-trip:** `parse(print(ast))` ≡ `ast` structurally, escaping
  included (the printer adds exactly the backslash the parser strips).
- **Payload round-trip:** `parse(print(hunk)).patch` == `hunk.patch` byte for
  byte — fences, S.I.R headings and blank lines included — up to line endings,
  which belong to the target file. The patch body is verbatim output, so
  corrupting it is invisible to every test further up.
- **System round-trip:** `apply(generate(old,new), old) == new`, verified inside
  `generate` itself and again in the test suite.
- **Map in isolation:** spans correct on tricky C++ inputs.
- **Ambiguity is an error:** a second *different* match raises `AmbiguityError`
  with the competing positions. Silently picking the first of two valid spots is
  the worst possible bug.
- **Failure diagnostics:** on failure the matcher reports the deepest point
  reached (position + which step failed).

Errors carry their CI exit code (`src/core/errors.ts`): `ParseError`→2,
`MatchError`→3, `AmbiguityError`→4, `ConfigError`→5, `GrammarError`→6, `NoChanges`→7,
`SynthesisError`→8 — `generate` could not anchor a change, told apart from a `.sirp` that
does not apply; `GitError`, `LanguageError`, `PathError`→1. The base `SirError` is
abstract, and anything else exits 1.

## tree-sitter is the default structure provider

`buildMap` parses the source with tree-sitter and reads block spans straight from
the syntax tree, giving `enclosing`/`blocksWithin`. This replaces a
hand-written character scanner and bracket matcher — precisely the parts that are
buggiest to hand-roll (raw strings, the C++14 digit separator `'`, string
prefixes, preprocessor imbalance), all of which tree-sitter handles. We keep our
own canonicalization (tree-sitter does not collapse whitespace for fuzzy matching)
and the mapping of node offsets into canonical coordinates.

The WASM build is used (cross-platform, no native compilation, stable across Node
versions). Cost: a dependency (`web-tree-sitter` + the `.wasm` grammars) and an
**async init** — `Parser.init()`/`Language.load()` return promises, so the adapter
exposes `init(): Promise<void>`, awaited once at CLI startup; `buildMap` is
synchronous thereafter. libclang/clangd were rejected: they need the project's
full compile environment (flags, includes), a heavy native dependency, and an
async server — reintroducing the build-coupling this port exists to remove.

## Grammars ship inside

The grammars are part of the package (`grammars/`, filled at build time by
`scripts/fetch-grammars.ts` from the pins in `src/lang/*/index.ts`).
`infra/grammar-store.ts` only finds them — `$SIR_GRAMMAR_DIR`, then `grammars/` — and
holds the bytes to the sha256 pin wherever they come from. There is no download and no
cache at run time, so a run is the same offline, in CI and in `sir-apply`.

## One engine, three entries

`src/bin/` holds the only files that run anything: `sir.ts` (the CLI), `service.ts`
(the JSON-lines service) and `sir-apply.ts` (the build's tool). Each only calls a
`main`; no module of the CLI or the service does anything when imported, so the same
code is a library, a command and — bundled by `scripts/build-apply-bin.mjs` with esbuild
into one CommonJS file and injected into a copy of Node as a single executable —
`sir-apply`. Inside that executable there is no package directory:
`infra/runtime.ts` is the one place that knows, and hands out its assets (the
tree-sitter runtime's `.wasm`, the grammars, still held to their pins); the version is a
constant the build defines. `sir-apply` runs `cli/apply.ts` in its own mode — no
questions, a clean base only, a file it patches in place written over rather than kept,
and not written at all when it already holds the result — and the apply goldens run
through every binary a release builds (`test/golden/run-binary.mjs`), so the build and
the editor cannot disagree. Its options are not a list of their own: `binSpec` picks
them out of `sir apply`'s (`cli/args.ts` `pickOptions`), so a flag of `sir-apply` has
the meaning it has in `sir apply` by construction (VERSIONING.md F2).

## The service: decoded requests, a wire of its own

`service/handler.ts` keeps its methods in a `Map` — name, the params it knows with their
types, the function — so a new method is one entry, and "unknown method" lists them
from the same map. `service/request.ts` decodes a line before any of it is used: a value
that is not a request object, or a param of the wrong type, is a `BadRequest` naming it,
never whatever the code it would reach throws; `handle` answers every line and never
rejects, so one bad line cannot end the process.

The wire types live in `service/protocol.ts`, written out field by field — none is
borrowed from the core. `test/unit/protocol-types.test.ts` holds each one equal to the
core type the service fills it from: a change in the core fails the typecheck until the
protocol is changed on purpose, with its number (VERSIONING.md R2).

## Git: any non-zero exit is a no

`infra/git.ts` makes every simple-git instance with the `errors` plugin set to count any
non-zero exit as a refusal — by default simple-git calls a task failed only when git
also wrote to stderr, so `--is-ancestor` or `--quiet` would say "yes" by saying nothing.
`attempt` turns a refusal into `undefined`; a question that needs a value reads it from
the output. A base `config` reports is checked by the type of its object (`cat-file -t`),
not by reading it, and the paths to watch come from one `rev-parse` call.
