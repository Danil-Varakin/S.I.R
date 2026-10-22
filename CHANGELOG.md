# Changelog

Every release names its numbers — package, protocol range, config schema range and,
from 0.4, patch format range —
then what changed, breaking changes first. The rules for all three are in
[VERSIONING.md](./VERSIONING.md); an entry is written before its tag (P6).

## 0.5.0 — 2026-10-22

**Protocol 5–5 · config schema 3–3 · patch format 2–2**

### Breaking

- **hatch is sir now — search, insert, replace.** Everything that carried the name is
  named anew, and nothing of hatch is read — no number keeps the old one readable
  (VERSIONING.md F1, H1, H4, decided by the author):
  - the commands `hatch` and `hatch-apply` are `sir` and `sir-apply`; the release files
    are `sir-apply-0.5.0-<os>-<arch>` and `sir-0.5.0.tgz`; the repository is
    `Danil-Varakin/S.I.R` (GitHub forwards the old address);
  - a patch is a `.sirp`. A `.hatch` is not a patch anywhere: `apply`, `sir-apply` and
    `pair` take it for code, and `--out x.hatch` is refused as a name;
  - the patch format is 2–2: line 1 of the header is `Sir: 2`, field 4 is `Sir-Version`.
    A patch that opens with `Hatch: 1` is refused as older (exit 2, "regenerate the
    patch"). `Generated-From`, `Generated-By` and `Hatch-Version` are fields sir does not
    know. A file with no header is hunks alone and still reads, as format 2;
  - the config is `sir.config.json`, schema 3–3, with the keys of schema 2. A
    `hatch.config.json` is not looked for, and a config of schema 1 or 2 is refused
    ("move the file to v3"). `$HATCH_CONFIG` is `$SIR_CONFIG`, `$HATCH_GRAMMAR_DIR` is
    `$SIR_GRAMMAR_DIR`;
  - the protocol is 5–5: `version` answers `sir` in place of `hatch`; `header` answers
    `sirVersion` and no longer `generatedFrom`, `generatedBy`. A client of protocol 4 —
    the VS Code extension 0.0.1 — is refused; the S.I.R extension 0.1.0 speaks 5 and
    ships with this release (S3);
  - the exports of the package: `SirError`, `parseSirFile`, `printSirFile`, `SirFile`
    (were `HatchError`, `parseHatchFile`, `printHatchFile`, `HatchFile`).
  Breaking for the package (P3) on every point; `PROTOCOL_MIN`, `CONFIG_MIN` and
  `FORMAT_MIN` rise together.
  → in scripts and CI: `hatch` → `sir`, `hatch-apply` → `sir-apply`, and the file names
  of the release.
  → every patch: rename `x.hatch` to `x.sirp` and its first line `Hatch: 1` to `Sir: 2` —
  the hunks are the same — or regenerate it with `sir generate`.
  → the config: rename `hatch.config.json` to `sir.config.json`, set `"version": 3` and
  `"$schema"` to `https://raw.githubusercontent.com/Danil-Varakin/S.I.R/v0.5.0/schemas/sir.config.v3.schema.json`
  (`sir init` writes one); `$HATCH_CONFIG`, `$HATCH_GRAMMAR_DIR` → `$SIR_CONFIG`,
  `$SIR_GRAMMAR_DIR`.
  → the editor: install the S.I.R VS Code extension 0.1.0 in place of the hatch one.
  → code over the package: `Hatch*` names → `Sir*`; a client of the service reads
  `version.sir` and `header.sirVersion`.
- **The command `sir grammars` is gone.** It shipped in 0.2, fetched the grammars into
  a user cache, and since 0.4 did nothing but warn — one minor release with the old
  spelling still working, as F2 asks. `sir grammars` now exits 1 as an unknown command,
  and `sir` no longer lists it. Breaking for the package (P3), so the release carrying
  it is at least a minor one (P2).
  → drop `sir grammars` from scripts and CI; nothing replaces it, because nothing is
  downloaded — the grammars ship inside sir. In the repository the grammars are put in
  place by `npm run grammars` (`scripts/fetch-grammars.ts`), which `npm test` and
  `npm pack` already run.
- **The flag `--download-grammars` is gone**, from `apply`, `generate` and — since its
  options are picked out of `apply`'s (F2) — from `sir-apply`. It shipped in 0.3, and
  since 0.4 was accepted, did nothing and warned: the one minor release F2 asks for. It is
  now an unknown argument (exit 1), and out of `--help`. Breaking for the package (P3).
  The protocol param `allowDownload` is **unchanged**: still accepted, still ignored.
  → remove the flag from scripts and CI; there is nothing to allow, because nothing is
  downloaded. A client over the service may keep sending `allowDownload`.
- **`LanguageAdapter.init()` takes no argument, and `InitOptions` is gone** from the
  package's exports, together with `GenerateRequest.init`. Nothing had read that object
  since 0.4: its one field, `log`, was there to report a grammar being downloaded, and
  grammars ship inside sir. An export of `src/index.ts` changed, so breaking (P3).
  → a caller that wrote `adapter.init({})` writes `adapter.init()`, and one that passed
  `init` to `generatePatch` drops it; neither did anything.
- **git no longer sees the `GIT_*` variables of the environment sir runs in.** sir
  reads the old version through `simple-git`, now 4.0.2 (was 3.36.0): it closes the
  critical advisory GHSA-v5rq-49vh-5v5c in `@simple-git/argv-parser` (now 2.0.1) and
  GHSA-x6jw-m9v5-85vh, GHSA-g4wm-2vf7-vfgr, GHSA-858h-whjf-mvg5 in `simple-git` up to
  4.0.1 — `simple-git` is a runtime dependency, so it shipped inside every client that
  carries sir. `simple-git` 4 strips every `GIT_`-prefixed variable, and `EDITOR`,
  `PAGER`, `VISUAL`, from the environment of the git it runs. sir finds the repository
  itself, by its `.git`, so a `GIT_DIR` or `GIT_WORK_TREE` in the environment could only
  point git at another repository than the one sir named — now both read the same one.
  What changes is configuration passed through the environment: `GIT_CONFIG_COUNT` /
  `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`, `GIT_CONFIG_GLOBAL`, `GIT_CEILING_DIRECTORIES`
  and the like no longer reach the git that reads a base, so a run that relied on one —
  `safe.directory` for a checkout owned by another user, say — is refused where it
  succeeded. Every option sir passes to git was already spelled in full, and no value
  of a coordinate starting with `-` ever reached git, so the stricter argument checks of
  `simple-git` 4 refuse nothing sir sends. Breaking for the package (P3) on that one
  point; no protocol, config or format number moves.
  → set what git needs in its config files instead of the environment — `git config
  --global --add safe.directory <path>` rather than `GIT_CONFIG_*`; nothing to change
  otherwise.

### Added

- **`npm run bench`** — the speed and performance cases, as a suite of their own
  (`bench/`): `parse`, `apply`, `generate`, `probes`, `depth`, on a synthetic C++ stand
  that is the same on every machine. `--case`, `--reps`, `--budget`, `--big`; a per-cell
  budget so one heavy case cannot eat the run. The suite holds the stand and the cases;
  the numbers it produces are recorded outside the package, with the stand each was taken
  on. It is **not** part of `npm run check`: the heavy cases take minutes.
  `npm run typecheck` covers it.
- **`config` answers `language`** — the word `generate` writes in `# match` for the same
  `path` and `overrides`: the language's own name (`cpp` for `.cc`, `objc` for `.mm`),
  after `generate.language`; for a `.sirp`, that of the file `pair` names for it. `null`
  when none is picked, never an error. No grammar is loaded. A client laying out a patch
  by hand takes the name from here instead of a table of its own. Protocol 5.
- **`config` answers `header`** — the header `generate` would write for the same `path`
  and `overrides` now, its blank line after it, by the same code: `Sir`, `Target`,
  `Base-Blob`, `Sir-Version`, `Grammar`, each left out when it has no value — no
  `Base-Blob` for a text base, no base or one that cannot be read (`unavailable`), no
  `Grammar` when no language is picked, no `Target` outside the upstream. For a `.sirp`,
  the header of the file `pair` names for it; `null` with no pair. The blob is named by
  git, not read, and no grammar is loaded. A patch written by hand opens with the same
  header as a generated one, and a client keeps no copy of the field list. Protocol 5.
- **A hunk written by hand, through the service** — what the CLI does in the editor
  when synthesis cannot anchor a change, with no session. `SynthesisError` (`no-match`,
  `ambiguous`) answers `detail.draft`: the `.sirp` the editor would get, without the
  comment lines on top — the header, every hunk so far, and last a hunk to start the change from;
  `draftHunk` (that hunk, from 1), `draftLine` (its `# match` in `draft`), `change`
  (`line` in the text so far, `removed`, `added`). `generate` takes `keep`: a `.sirp`
  whose hunks are settled, checked as the CLI checks an edit — it parses, its heading is
  the language's, every hunk lands on the base in order (one that does not: its own
  error kind, with `detail.hunk` and `detail.mdLine` in `keep`). Synthesis goes on from
  them; the next change it cannot anchor answers a new `draft` that holds them. The kept
  hunks open `patch` byte for byte, `# note` included. CLI and service share the code
  (`generate/draft.ts`, `generate/steer.ts`); the CLI behaves as before. Protocol 5. In the package, `SynthesisError` gains `draft` and
  `GenerateRequest` gains `keep`.

- **HTML and XML.** `.html`, `.htm` are read as HTML (`tree-sitter-html` 0.23.2),
  `.xml`, `.plist` as XML (`@tree-sitter-grammars/tree-sitter-xml` 0.7.0); the names
  `html`, `htm`, `xml`, `plist` are accepted in `# match`, `--language` and `language`.
  A block is an element with both tags: the start tag is its header, the end tag closes
  it; an element with no end tag (`<img>`, `<p>` left open) and `<br/>`, `<tag/>` are no
  block. `<script>` and `<style>` are blocks whose content is text. Whitespace is free
  outside attribute values, comments and CDATA; inside a quoted attribute value it is
  data, as in a string literal. Both grammars ship inside the package and every
  `sir-apply`. Protocol 5.
- **CSS and JSON.** `.css` is read as CSS (`tree-sitter-css` 0.25.0), `.json` as JSON
  (`tree-sitter-json` 0.24.8); the names `css` and `json` are accepted in `# match`,
  `--language` and `language`. CSS: a block is `{` … `}` of a rule or an at-rule
  (`@media`, `@supports`, `@keyframes`, nested rules), its header the selector or the
  at-rule; a space between selectors is the descendant combinator and is kept, so
  `.a .b` and `.a.b` are different anchors. JSON: a block is an object or an array, its
  header the key it is the value of; an object inside an array has none. Comments, which
  some JSON files carry, are read. Protocol 5.
- **JSON5, `DEPS` and Starlark.** `.json5` is read as JSON5 — by the JavaScript grammar,
  for a JSON5 file is an object literal of JavaScript (keys without quotes, single
  quotes, comments, trailing commas), and no new grammar ships. A block is an object or an
  array with the key as its header, as in JSON; an object that is an element of an array
  has its first pair for its header (`{ name: "AIPromptAPI",`), so entries of the same body
  are told apart by their names. A file named `DEPS` and `.star` files are read as Python,
  whose syntax they share; a language is picked by a file's whole name before its
  extension. The names `json5` and `star` are accepted in `# match`, `--language` and
  `language`. Protocol 5.
- **Formats read as text, with no grammar** — IDL (`.idl`, `.webidl`), Mojom (`.mojom`),
  Protocol Buffers (`.proto`), shell (`.sh`, `.bash`, Debian's `postinst`, `postrm`,
  `preinst`, `prerm`), YAML (`.yaml`, `.yml`), TOML (`.toml`) and plain text (`.txt`).
  A block is a pair of `()`, `[]`, `{}` that balances outside the format's strings and
  comments; its header is what stands before the opener on its line (`interface X {`,
  `f() {`). Each format keeps its own strings, comments and reading of whitespace: in
  shell, YAML and text the indentation of a line is kept and a space inside a line is
  never dropped. No grammar ships for them, and the header of their `.sirp` has no
  `Grammar`. Other files are picked by name: `--language shell` for a script without an
  extension, `--language text` for a template. The names `idl`, `webidl`, `mojom`,
  `proto`, `protobuf`, `shell`, `sh`, `bash`, `yaml`, `yml`, `toml`, `text`, `txt` are
  accepted in `# match`, `--language` and `language`. A `.txt` file, refused before,
  is now read as text. Protocol 5. In the package,
  `LanguageAdapter.grammar` is optional.

### Changed

- Internal, no behavior: the rule "the root a relative path is measured from — the
  repository around the file, else its own directory" is one function, `repoRootAround`
  in `infra/fs.ts`, which both the writer of a patch (`out-path.ts`) and its reader
  (`pair.ts`) call; "read the file if it can be read" is `readIfReadable` there, beside
  `readInputFile`, which keeps the opposite contract (absence is an error naming the
  flag); and the pair "render the error, take its exit code" is `reportFatal` in
  `infra/log.ts`, which the entry points call instead of each spelling it out. Seven
  values that no other module used are no longer exported. `infra/fs.ts` gained `kindOf`,
  which answers "a file, a directory, something else, or nothing there" in one `stat`, so
  `out-path.ts` — the last module outside `fs.ts` to reach for `statSync` — no longer
  does; `statSync` is now called in `fs.ts` alone.
- Internal, no behavior: checks that could never decide anything are gone, so that a
  mutation test measures the code and not its dead ends — the matcher's `stop` check
  at the start of a walk (every caller returns once it is set), its guards for an empty
  stack and for a position at the end of the file, and the stand-in for a no-match that
  recorded no position; the tightening of a first step at the top of a file in
  synthesis, which 28 560 edits at the start of the corpus files never reached; an
  `allowEdge` the exact cut never read; the optional `failure` of a hunk that did not
  land, which is always there; two repeated checks in the parser.
- **`generate` for Python: blocks closed by one line write that line once.** Where an
  `if` and the `def` around it both end at the next line of the `def`'s level, synthesis
  wrote that line once per block — `... def size(self): ... def size(self): ...` — and
  the second copy had to be another line, so every pattern with the parents fit nowhere,
  and with no parent the change was refused as ambiguous when the same headers stood in
  several classes. The line is now written once, by the inner block. Where `generate`
  refused it now writes a patch with the parents (golden `python/generate/45`); where it
  wrote a patch from a later rung, it may now keep the rung with the parents (no golden
  changed). Brace languages are untouched: every block there
  has its own `}`. No patch applies differently (F1).
- **Python: one outdent closes every block nested inside.** `class Archive:` at column 0
  ends the method and the class before it at once; the matcher took it for a way out of
  the method and refused it as the closer of the class. A pattern may now name a class
  and its closer with a method of it left open: `... class Queue: ... >>> def
  __init__(self, limit=100): <<< ... class Archive: ...` lands. `generate` for Python
  writes the parent and its closer where it wrote a pattern with no parent, and a patch
  where it refused (`... def push( ... ): ... >>> def check(x): <<< ... def size(self):
  ...` when `check` stood in two classes). A Python patch written so is refused by hatch
  0.4.1 (`no-match`), not applied wrongly: the hunk syntax is unchanged (H2). Every apply golden
  applies as before (F1). Brace languages are untouched: a bracket knows its own closing
  token, in Python too (`{}`, `()`, `[]`). Protocol 5, a change of it.
- **Messages, reworded where they pointed the wrong way.** A hunk of a hand-written patch
  (the editor, `keep`) that lands on the old version by itself but not after the hunks
  before it now says which one moved its anchor: `hunk 3 (line 21) does not land: it
  lands on the old version by itself, but hunk 1 rewrote the text it anchors on — …`
  (before, only the error of the text it met). With `exact`, a new version whose CRLF
  file has a line ending in a bare LF is refused as `the new version mixes line endings
  (line N ends with LF); a patch writes the endings of the base — turn exact off or make
  the endings one`, not as "a fault of synthesis": no patch can write that byte for byte;
  `reason` stays `unreproduced`. In a match or patch block, a heading with something
  after it — `# end x`, `# patch now`, `# match cpp now` — is named as such: `'# end x'
  is not a heading: '# end' takes nothing after it` (before: "must start with four
  spaces", and the hint to indent it). Typos: `there is no insertion point >>> in the
  match block`, `(the first one is on line 3)`, no full stop after two messages. Only
  text changes; every kind, `reason` and exit code stays.
- **`generate`: a change told apart only by the line right below it.** The neighbour
  below stood after `...` — `a(); >>> go(); ... <<< b();` — and so fitted any `b();`
  further down; with few neighbours allowed (`--siblings 1`) such a change was refused as
  ambiguous. When no pattern stands, synthesis now tries once more with the first
  neighbour below pressed against the change: `a(); >>> go(); <<< b();`. It is the last
  resort — a line written between the change and that neighbour breaks it — so wherever a
  pattern stood before, `generate` writes the same one (no golden changed). In a tight gap
  a mark stands on its left side, as `apply` reads it back.

### Fixed

- `A >>> B` with no `...`, where `A` ends in a word and `B` starts with one (`int foo
  >>> bar;`, `return >>> value`), fit nowhere: the one space the canon keeps between two
  words belonged to neither literal, so `B` could never start right after `A`. A tight
  gap now steps over that one space, and the mark stays where §3.4 puts it — right after
  `A`. No patch that applied before applies differently: such a pattern fit nowhere, so
  only refusals turn into matches (F1). Inside a string literal the same one space is
  stepped over (`"hello >>> world"` fits `"hello world"`, not `"hello  world"`).
  `generate` sees it too: where it had to write `A >>> ... B` across such a space it now
  writes `A >>> B` (golden `cpp/generate/73`).
- `generate` could write a Python patch that `apply` refused on the very file it was made
  from — exit 0, then exit 3. An anchor spanning a blank line (`tick()⏎⏎tick()`) was
  verified as built, but a blank line in a match block is no part of a literal: the
  `.sirp` read back as `tick()⏎tick()`, which the Python canon, keeping blank lines,
  does not find. Anchors are now built as `apply` reads them back — no blank lines, no
  trailing whitespace, no CR at a line end — and verified so; where only the blank line
  told two places apart, `generate` now says it cannot anchor the change (exit 8; at a
  terminal the editor is offered) instead of writing a patch that does not apply. Brace
  languages read the same either way, but the form `generate` prints changes there too:
  a match block no longer carries a blank line, trailing spaces or a stray CR inside an
  anchor (goldens `cpp/generate/22`, `26`, `35`, `46`, `74`, `83`, `objc/generate/13`).
  No existing patch applies differently (F1): only what `generate` writes changes.
- The link table of the service — `hunks` in `resolve`, `apply` and `generate` — could
  hand one hunk's text to another. `final` is what a hunk writes, PROTOCOL.md says — but
  a later hunk that inserted right at the start of that text, or replaced from inside it
  onward, landed inside `final` and
  `finalText`, so a client highlighted it as the earlier hunk's; a hunk that a later one
  overwrote whole kept the later one's text as its own. Likewise `base` is what a hunk
  replaces — but a hunk right after text an earlier one deleted had that deleted text in
  its `base`. Now the start of a span moves past what another hunk wrote or deleted at
  that point, the end stays before it, and a span overwritten whole is left empty where
  it stood. Only these edge cases change; nothing applies differently. `generate` steering
  (`-a`, `keep`) projects what each hunk wrote the same way, so it no longer counts a
  later hunk's text as written by an earlier one. Protocol 5, a fix.
- The hunk to start a change from — the last hunk of `detail.draft` and of the draft the
  CLI hands the editor — dropped the blank lines between its context and the change. The
  mark sits right after the context, so those lines fell inside what the hunk replaces,
  and the body did not write them back: a draft laid as it is gave `one();⏎TWO();` where
  the new version has `one();⏎⏎TWO();`, and a draft finished by adding context and sent
  back as `keep` no longer matched `newText`. The body now writes the blank lines back; an
  insertion under blank lines, having no place of its own to mark, replaces the next line
  that is not blank and writes it back after the inserted lines. Where no blank line
  stands between, the draft is as before. Protocol 5, a fix of a part not yet released.
- A Python pattern could land in a class it does not name. In
  `class A: def g … def h … class B: def g … class B: pass`, the pattern
  `... class A: ... >>> def g(self): <<< ... class B: ...` changed `g` of the first
  `class B`: the way through `A.g` was refused as an escape from `g`, and the way
  through `B.g` took the next `class B:` as its closer. With one outdent closing every
  nested block, both ways stand, and the pattern is refused as ambiguous (exit 4) instead
  of changing the wrong class. The old result was the bug (P3).
- A `.sirp` that ends after a match block with no `# patch` was refused on a line past
  the end of the file — the empty one after the last line break. The refusal now names
  the match block's `# end`. `mdLine` of that `ParseError` changes, as a client sees it.
- `generate` could write a patch that fits every file and writes over it. When a change
  covered the whole file — a file of one line, a minified one, whose line changed —
  synthesis wrote `>>> ... <<<`: no literal at all, so the pattern fit any file, and
  applied over the version upstream had made it replaced all of it, what upstream added
  included. Such a span now spells the text it replaces (`... >>> <old text> <<< ...`), as
  every other replacement does: it fits only a file that still holds that text, and is
  refused (exit 3) where upstream changed it. A file of blank lines alone, with nothing to
  spell, keeps the bare span. Only what `generate` writes changes; no patch applies
  differently (F1). Golden `cpp/generate/70` (the whole file deleted) changes form. The
  old result was the bug (P3).
- A Python file that opens with a BOM refused a pattern pinned to its first line (no
  `...` before it): the Python canon keeps the whitespace at the start of the file, and
  took the BOM for it. The BOM is no indentation and is now left out. Only refusals turn
  into matches (F1).

## 0.4.1 — 2026-10-06

**Protocol 4–4 · config schema 2–2 · patch format 1–1**

The first release of the 0.4 line: the tag `v0.4.0` was pushed, its check failed on
Windows and Linux (see Fixed), and nothing was published under it. The number is not
reused (P7), so everything 0.4.0 would have brought is here.

### Breaking

- **A patch is a `.hatch` file.** `generate` writes `<name of --in>.hatch`; `apply
  --match` refuses any other name ("a patch is a .hatch file"), and `pair` takes a
  `.md` for code. The hunks inside are the same to the character. hatch 0.1–0.3 wrote
  `.md`; F1 is rewritten for this in VERSIONING.md (decided 2026-10-02: no one used
  hatch yet, and a patch that looks like Markdown is reformatted by Markdown tools).
  → rename your patches: `git mv x.md x.hatch`; scripts and CI that name `*.md`
  patches name `*.hatch`.
- `generate --out` (and `generate.out`, the service's `out`) that names a file with
  another extension than `.hatch` is refused with `ConfigError` (exit 5) before any
  file is read; before it wrote the file under that name. A directory is taken as
  before.
  → name the file `*.hatch`, or give a directory.
- **The header replaces the marker line.** A `.hatch` opens with `Name: value` lines up
  to a blank line: `Hatch: 1` (the format number, VERSIONING.md H1–H3), `Target` (the
  file it patches, from the repository root), `Generated-From` (the git blob of the
  base, when it came out of git), `Generated-By`, `Grammar`. `<!-- hatch: target=… -->`
  is no longer written or read: before the first `# match` it is prose, as it always
  was. A file with no header applies as format 1; a format newer than this hatch reads
  is refused with "update hatch".
  → regenerate the patch, or replace the line with `Hatch: 1` and `Target: <path>`
  followed by a blank line.
- **`--no-marker`, `generate.marker` and the protocol param `marker` are removed** —
  `Target` is always written when the patch has a place. None shipped in a release. In
  `pair`, `how: "marker"` is now `"target"` and the reason `unsafe-marker` is
  `unsafe-target` (protocol 4, unreleased).
  → drop `--no-marker` from scripts and `generate.marker` from `hatch.config.json`.
- **A project and its upstream; `generate.mirror` and `--mirror` are removed.** A
  config may name `"upstream"`: the root of the code the project patches, measured from
  the config file (`".."` for a project inside its upstream, `"upstream"` for an
  upstream inside the project, `"."` for one repository). The patch of a file is then
  `<config dir>/<generate.out>/<path from the upstream>.hatch`, and its `Target` is that
  path. `--mirror` goes without the release where it would still work and warn (F2) —
  decided by the author 2026-10-02.
  → replace `"mirror": true` with `"upstream": "."` at the top level of the config
  (`generate.out` stays); drop `--mirror` from scripts — the config does it.
- **Config schema 1 is read no longer** (`CONFIG_MIN` 2, C3): such a file is refused with
  "move the file to v2".
  → set `"version": 2` and replace `generate.mirror` as above; nothing else changes.
- **The config of a file is looked for in more places.** Up from the file to its
  repository root as before; then a config whose `upstream` holds the file — in the
  subdirectories of every repository root on the way up, and above the repository;
  then `$HATCH_CONFIG`, then the current directory. Two such configs are an error that
  names both. A patch finds its config up from itself.
  → nothing for a project of one repository; for a project over an upstream, add
  `"upstream"` to its config.
- **`apply --verify` needs a clean base.** It takes the base out of git — the git flags,
  else `generate.base` of the config; with neither, a person at a terminal is asked
  whether the files on disk are that base, and without one it is refused (exit 1).
  `apply` that writes is unchanged.
  → name the base (`--head` / `--branch` / `--commit`, or `generate.base`), or add
  `--base-from-disk`.
- **`generate` asks before writing over another file's patch** at a place it computed
  (two files met at one name): `--yes` goes ahead, without a terminal it is refused
  with `ConfigError` (exit 5). The same file's patch, and a `--out x.hatch` named
  outright, are written over as before.
  → pass `--yes` where that is meant.
- Over the service (protocol 4): `pair` answers `how: "upstream"` instead of `"mirror"`,
  the reason `outside-upstream` instead of `outside-repository`, and the new reason
  `two-patches` with `patchPaths`; the param `mirror` is gone.
  → a client switches on the new names.
- **A grammar in `HATCH_GRAMMAR_DIR` must be the pinned one.** A file whose sha256
  differs from the pin fails the run (`GrammarError`, exit 6); before it was used with a
  warning.
  → put the pinned grammar there (`npm run grammars` fetches it), or unset the variable.
- **`HATCH_GRAMMAR_CACHE` and `HATCH_GRAMMARS_DOWNLOAD` do nothing**: there is no
  download and no cache any more (see Added).
  → drop them from CI; the old cache directory can be deleted.
- **The protocol field `md` is now `patch`**: the text `generate` answers, and the one
  `resolve`, `apply` and `pair` take. Inside protocol 4, which already raises
  `protocolMin` to 4 (R3); `mdSpan` and `mdLine` keep their names.
  → a client reads `result.patch` and sends `params.patch`; the VS Code extension 0.0.1
  is updated with this release.
- `hatch generate` with nothing to change — the new version is the old one, line for
  line as the language normalizes it, blank lines not counted; with `--exact`, byte for
  byte — exits **7** with `NoChanges: the new version is the base …` and writes no
  patch. Before: exit 0, `generated 0 hunk(s)`, and a patch of one empty line that no
  hatch could apply. A change of only spacing or blank lines now counts as none.
  → a script that runs `generate` on files that may be unchanged treats exit 7 as
  "nothing to do", not as a failure, and stops expecting a patch for such a file.
- Over the service, the same request fails with the new error kind `NoChanges`
  (`exitCode` 7, `detail.baseSpec`) instead of `ParseError` "no match/patch pairs"
  (protocol 4). By R5 a change a client could notice, so **`protocolMin` rises to 4**:
  a client of protocol 2 or 3 is refused with "update the client".
  → the VS Code extension 0.0.1 speaks 4–4 and ships together with this release; no
  other client of protocols 2–3 was released.
- VERSIONING.md: S2 (announce a raise of `protocolMin`/`CONFIG_MIN` one release ahead)
  is removed, with its reason; S4 carries its own notice rule.
- `hatch generate` that cannot anchor a change exits **8** with `SynthesisError: could
  not anchor the change at line N of the new version — …`. Before: exit 3 or 4, as a
  `MatchError` or an `AmbiguityError` — the codes of a patch that does not apply, with
  positions in a text the reader never saw. A person at a terminal is still handed the
  editor, as before.
  → a script that reads exit 3/4 from `generate` as "could not anchor" reads 8; 3 and 4
  now come from `apply` only.
- Over the service, the same `generate` fails with the new error kind `SynthesisError`
  (`exitCode` 8, `detail.reason` — `no-match`, `ambiguous`, `unreproduced` — and
  `detail.newLine`) instead of `MatchError`/`AmbiguityError` (protocol 4, inside the
  raise of `protocolMin` above).
  → a client that told "could not anchor" by `MatchError`/`AmbiguityError` from
  `generate` switches on `SynthesisError`; the VS Code extension shows the message and
  needs no change.
- The service answers each request when it is done, **not in the order they came**:
  `generate` hands the loop back after every change, and a `pair`, a `config` or a
  `cancel` sent meanwhile is answered before it (protocol 4, inside the raise of
  `protocolMin` above). PROTOCOL.md said "one at a time, in order".
  → a client pairs replies with requests by `id`; the VS Code extension already does.
- The API of the package: `generatePatch` with nothing to change throws `NoChanges`,
  and `synthesize`/`generatePatch` that cannot anchor a change throw `SynthesisError`
  — where they returned an empty patch, and threw `MatchError`, `AmbiguityError` or a
  plain `Error`. Both classes are exported now.
  → code that calls them catches `NoChanges` and `SynthesisError` from `hatch`.

### Added

- **Notes on hunks.** A `# note` … `# end` block right before a `# match` is the
  author's comment on that hunk: prose in any column, no gutter, never read by the
  matcher. Over the service the hunk in `resolve`/`apply` carries `note` and `noteSpan`
  (protocol 4). Text between hunks outside a note is still a parse error, now with a
  message that names the note block. Every patch applies as before (F1): before the first
  `# match` only a closed note followed by blank lines is read as one, any other prose
  there is prose as always (apply golden `c/apply/10`). A patch with notes needs this
  release: hatch 0.3.0 refuses it with "text between hunks is not supported".
  `generate -a` keeps a note written in its editor, before the hunk it is about;
  `generate` itself writes none, and generating a patch again drops the notes in it.
- `--eol repository|worktree` for `generate` and `apply`, `generate.base.eol` (config
  schema 2), `baseGit.eol` (protocol 4): a version read out of git with the line
  endings of the file on disk (`worktree`), for repositories with `core.autocrlf`,
  where git stores LF and the checkout has CRLF. The conversion is the rule a patch
  already lands by — the endings of the file — read off its first line. The default,
  `repository`, is the old behavior.
- **`hatch-apply`** — a new release file for project builds: one executable with Node,
  the tree-sitter runtime and the grammars inside, for linux-x64, linux-arm64,
  darwin-arm64 and win-x64, with `SHA256SUMS`. `hatch-apply apply|verify --match
  <patch>`: the file by `Target`, the base out of git (or `--base-from-disk`, which warns
  that the files on disk are taken as it), no questions — what `hatch` would ask about
  (a tag named as a branch, a commit off the branch named) is refused; exit 5 when no
  clean base is named. In place — `apply` without `--out` — a file that already holds
  the result is not written again (no new mtime for the build to recompile over), and a
  file with changes of its own is written over and said so: the code a build patches is
  not the project's to keep, and a patch that changed is laid on the clean base again.
  `--version` prints the Node inside and every grammar pin. Its options are picked out of
  `hatch apply`'s, so each has the same meaning (VERSIONING.md F2, a test holds it), and
  every apply golden runs through each binary in CI and in the release.
- The package's entries are in `dist/bin/`: `hatch` is `dist/bin/hatch.js`, the service
  `dist/bin/service.js`; `node dist/service/index.js` still starts the service, as the
  VS Code extension does, and `import { serve } from 'hatch/service'` is unchanged.
  Modules of the CLI no longer run when started directly (`node dist/cli/apply.js`).
- **The grammars ship inside hatch** (`grammars/` of the package, about 17 MB, 1.7 MB
  packed): `apply` and `generate` work right after `npm i`, offline, and nothing is ever
  downloaded. `hatch grammars` and `--download-grammars` still work in this release, do
  nothing and say so — they are removed in 0.5 (F2). Over the service `allowDownload`
  is accepted and ignored. In the repository `npm run grammars`
  (`scripts/fetch-grammars.ts`) fetches the pinned grammars; `npm test` and `npm pack`
  run it.
- `apply` without `--in`: the file is the one the patch names in `Target` — from the
  upstream of the project, else from the repository around the patch. `apply --config`
  and `--no-config`.
- `hatch init --upstream <path> [--out <dir>]` writes `"upstream"` and `generate.out`
  (default `patches`) into the config of the project, and refuses an upstream that is
  not there.
- Protocol 4:
  - `configPath` (absolute) in the params of `generate`, `resolve`, `apply` and in the
    `overrides` of `config`, `pair`: the config to use, no search — the layout of a
    project beside its upstream.
  - `generate` answers `outExists` and `outTarget` — whether a file is at `outPath` and
    the `Target` it names — so a client asks before writing over another file's patch.
  - `config` answers `upstreamRoot`, and watches a config found by its claim.
  - `resolve` and `apply` take the patch's own path: its text from disk unless sent, the
    code by `Target`, the base from the patch's config. Both answer `code` (the file the
    patch was laid on), `header` (the patch's header as read) and `warningsAt` — the
    same marks `generate` gives, for a patch edited by hand too (X1).
  - `config` answers `projectRoot` and `target` (the pair's `Target`); `config` and
    `pair` take `configPath` beside `overrides`.
  - `GitError` carries `detail.reason`: `no-such-file`, `not-a-file`, `no-such-branch`,
    `not-a-branch`, `no-such-commit`, `not-on-branch`, `no-commits`, `no-repository`,
    `outside-repository`, `bad-coordinate`, `no-git` (X2).
  - Error messages over the service name no CLI flag: `nope: no such branch …`; the CLI
    still says `--branch nope: no such branch …` (X3).
  - Every reply carries `elapsedMs` (X4).
  - `config { path, overrides? }` answers the settings `generate` would apply with those
    params — the same code reads both — the config file's schema version, the
    repository root, the base (`text`, or `git` with `spec`, the full `sha` and `eol`)
    and `watch`: the paths whose change may change the answer (config files up the
    tree, `HEAD`, the branch's ref, `packed-refs`, worktrees included).
  - `pair { path, patch?, overrides? }`: a file of code and its `.hatch`, either way —
    the header's `Target` first, then `generate.out` and `upstream` — with `exists` and
    `how`, or `reason` when there is none: `no-out`, `outside-upstream`, `flat-out`,
    `outside-out`, `not-a-patch-name`, `two-patches`, `unsafe-target` (a `Target` that
    leaves its root), `newer-format` (update hatch), `older-format` (regenerate the
    patch), `bad-header` (a header that does not read).
  - A line that is JSON but not a request object (`null`, `42`, `[…]`) is answered with
    `BadRequest` and `id` 0, and the service goes on; before, it ended the process. A
    param of the wrong type — `path: 42`, `limits: "all"` — is a `BadRequest` that names
    it, not whatever the code it reached threw (`TypeError`). Values a config checks
    (`exact`, `bridgeGap`, `out`, the keys of `limits`) answer `ConfigError`, as before.
  - `SynthesisError` with `detail.reason: "no-match"` also when no candidate pattern
    could be built around the change (it said `ambiguous`, and nothing had fitted twice).
  - `generate` answers `warningsAt` beside `warnings`: `{ hunk, mdLine, message }`.
  - `cancel { id }` takes back a request still running: `generate` stops before its next
    change and answers the new error kind `Cancelled`; `{ cancelled: false }` when no
    such request runs. Killing the process still works as it did.
  - `config` for a file whose git base cannot be read — not committed yet, no such
    branch — answers the settings with `base: { kind: "unavailable", error }` instead
    of failing with `GitError`, and watches `HEAD` and the branch, so that the next
    commit changes the answer (before the first commit, too).
  - `resolve` answers `baseText` when the base came out of git.
  - `resolve`/`apply` with a `path` and no base take the config's `generate.base`, as
    `generate` does (refused before).

- Config schema 2 (`CONFIG_MIN` 2 — see Breaking): `generate.base.head`,
  `generate.base.branch`, `generate.base.commit`, `generate.base.eol` — the old version
  `generate` compares against, named once for the project as `--head` / `--branch` /
  `--commit` name it — and `upstream`. With a base set, `hatch generate --in <file>`
  needs no source flag. Any git flag replaces all three for that run; `--in-old`
  ignores them. Over the service, a `generate` that sends neither `baseText` nor
  `baseGit` takes this base (protocol 4: such a request was refused before). hatch 0.3.0
  meeting `"version": 2` says to update hatch.

- `hatch init` writes a `hatch.config.json`: only `"$schema"` and `"version"`, so every
  default stays the built-in one. `--config-version <n>` picks the schema (a line on
  stderr when it is not the newest), `--dir` the directory (default: the git root around
  the current directory, outside a repository the directory itself), `--force` replaces
  an existing file (without it: exit 5, the file untouched), `--dry-run` prints instead.
- Protocol 4: the method `configTemplate` answers the
  text of a new config for a schema version and initial settings, the path the core
  would look for it at, whether a file is there, and every schema version in the range
  with a one-line summary. It writes nothing. A `ConfigError` about keys outside the
  chosen schema carries `detail.version` and `detail.keys`; a key a schema dropped is
  named with the schemas that had it (`generate.mirror`: `since: 1`, `until: 1`) and what
  took its place.
- Each config schema has its own JSON Schema, `schemas/hatch.config.v<N>.schema.json`,
  and a written config points its `"$schema"` at the one of its version — read from the
  tag of the release that shipped it, so a released schema never changes (until then,
  from `main`).
  `hatch.config.schema.json` stays the newest schema, for SchemaStore.

### Changed

- Two git refusals of the CLI read differently: a path out of the repository is
  `--in /abs/x.cc: outside its repository root …` (was `--in: /abs/x.cc is outside …`),
  and the advice after "not a branch" / "not on branch" names the coordinate before its
  flag — `name any other revision as the commit (--commit)`.
- The generate goldens record the header `generate` writes (`Hatch`, `Target`,
  `Grammar`), the apply goldens open with `Hatch` and `Target`; one of them (`c/apply/9`)
  stays without a header, as a hand-written patch. The hunks are the same to the byte.

- A config is checked against the keys of the schema its `"version"` names: a key of
  a newer schema is refused with the schema it belongs to.
- `generate` checks the place for the patch before synthesis, in the CLI and over the
  service: an `--out` under a file fails at once, not after the work — and before
  `NoChanges`.
- `hatch apply` that would write a file with the very text it holds writes nothing, and
  says `already so: not written`: the file keeps its mtime.
- `hatch apply` refusing to write a git version over a file with changes of its own says
  `the result would go over <file>, which holds changes …` — it named `--out` and `--in`
  even when neither was typed. The exit code is 1, as before.
- `generate -a`, and `generate` handing a change to the editor, lay each kept hunk once
  instead of replaying every hunk on every step: 100 changes in a 1000-line file take
  about 3 s instead of about 3 minutes; the hunks are the same.
- `config` over a git base asks git 5 times instead of 8: about 40% faster.
- `hatch init --dry-run` says `printed config schema vN`, not `wrote`.

### Fixed

- A file whose name starts with two dots (`..hidden.c`) was taken for a path out of its
  root: refused as `--repo-path` or as the file of a git base, and left without a
  `Target` or a `pair`. It is inside, as any other name.
- The config search from the home directory itself went on above it (`/Users`); it
  stops there, as it always did from below it.
- A patch whose headings spell its language in two cases (`# match cpp`, `# match CPP`)
  was refused as two languages; it is one.
- `hatch apply --config` was described and refused as an unknown argument; it works, as
  it does for `hatch-apply`.
- `hatch-apply apply` with `--in` relative to a directory below the repository root
  wrote the result to that path from the root — another file — and exited 0; it writes
  the file named.
- `apply --eol` was ignored without a git source and never checked; it is checked now,
  and refused when no version out of git is named. The flag has not shipped yet (F2).
- On Windows, a run writing `--out` over a file another run held open failed with
  `EPERM` instead of writing it: the rename is tried again for up to two seconds, so
  each run lands whole and one of them wins — what the write promised everywhere else.
- The service cut a request in two at U+2028 or U+2029 inside a string — characters
  `JSON.stringify` leaves as they are — and answered two `BadRequest`s with `id: 0`, never
  the request itself (a `generate` waited for ever). A line now ends at `\n` alone, as the
  transport always said (protocol 4, unreleased).

## 0.3.0 — 2026-09-28

**Protocol 2–3 · config schema 1–1**

### Added

- **Writing a hunk by hand.** When synthesis cannot anchor a change and a person is at
  the terminal, `generate` offers the editor (`$VISUAL` / `$EDITOR` / `vi`, `notepad`)
  with every hunk so far and a hunk to start from; the result is checked — it must parse
  and land on the old version — and asked about again until it does, or the run stops
  without a `.md`. Synthesis then goes on from what those hunks produce. Without a
  terminal the error is the same as before.

- `apply` reads the file to patch out of git with the same flags and the same rules as
  `generate` — `--head`, `--branch`, `--commit`, `--repo-path`. With a git coordinate
  `--in` only names the file: the repository, the default path in it, the name of the
  result; it need not exist on disk. `--verify --branch main` answers "does this patch
  still fit main" without checking anything out.
- A request git can carry out but that may not mean what it says is **asked about**
  instead of refused: a `--commit` not on the `--branch` named beside it, a tag or a
  raw sha given as `--branch`, and `apply` writing a git version over an `--in` that
  holds changes that version lacks. The default answer is no; `--yes` / `-y` answers
  yes in advance; with no terminal to answer the answer is no. What git cannot carry
  out at all is still refused, `--yes` or not.
- Service, protocol 3 (additive, `protocolMin` stays 2): `resolve` and `apply` take
  `baseGit` like `generate` does and answer `baseSpec`; `version` announces
  `protocolMin` and `configSchemaMin`.
- The config schema version is a range: a `"version"` newer than this hatch reads says
  "update hatch", an older one says "move the file", instead of one message for both.
- `hatch.config.json` is ready for the SchemaStore catalog (`.github/schemastore/`):
  once listed, VS Code and JetBrains check and complete it by the file name.
- `PROTOCOL.md`: the service contract — transport, methods, errors, the link table, how
  a client checks the version — in the repository and in the package.

### Breaking

- `generate -a`: `n` no longer leaves a hunk out. It offers to write the hunks by hand
  in the editor; refusing that — or having no terminal — stops the run without a `.md`.
  Hunks are asked about as they are made, not after all of them. Leaving a hunk out
  after the fact used to break the ones built on top of it (4 of 36 cases in the golden
  set) and wrote the broken `.md` silently. Shipped without the minor release F2 asks
  for, by the author's decision.
  → to keep a change out of the `.md`, take it out of the new version (`--in`) before
  generating, or answer `n` and edit that hunk away in the editor; a script that piped
  `n` to drop hunks now stops with exit 1.

### Changed
- `generate -a` stops when its input closes before every hunk is answered — piped
  answers running out, `< /dev/null`, CI — and writes nothing, saying at which hunk it
  stopped. It used to fail with "readline was closed". Answers may still be piped in,
  one line per hunk.
- An empty language — `--language ""`, `params.language: ""` — is the same as none in
  every command and service method, and the language comes from the heading or the
  extension. `apply` and the service's `generate` used to refuse it, `resolve` did not.

- `generate` writes the language's own name into `# match` — `cpp`, `objc`, `python` —
  in the CLI and in the service alike, however the language was picked. The CLI used to
  write the file's extension (`# match cc`) and the service the name, so one file gave
  two different `.md`. A visible change of the printed form only: every `.md` already
  written applies as before.

### Fixed

- A `.md` written by `generate` 0.2.0 or earlier for a `.m`, `.mm`, `.pyi`, `.kts`,
  `.mts`, `.cts` or `.inc` file applies: it names the language by the extension
  (`# match mm`), and `apply` did not know those extensions as names. Every extension a
  language claims is now also its name, and `generate` refuses to write a heading
  `apply` would read back as another language. The service's `version` lists the new
  names in `languages`.
- `--branch` names a branch even when a tag has the same name (`v1.2` the release
  branch beside `v1.2` the tag): git calls the short name ambiguous, and hatch used to
  answer "not a branch" — or, told `--yes`, read the tag. The service's `baseGit` too.
- `apply` asks before writing over `--in` when `--out` is the same file spelled another
  way — `F.cc` for `f.cc` on a case-insensitive disk.
- `--branch` / `--commit` values that start with `-` are refused before git sees them:
  `--branch --all` made git list every ref and hatch answer about a missing file.
- `hatch constructor`, `hatch toString` and the like are unknown commands; `hatch help
  constructor` no longer crashes with a stack trace.
- `hatch grammars` no longer reads every grammar in full just to see that it is there,
  and reports a cache entry that failed its checksum and was fetched again as
  `downloaded`, not `cache`.
- Writing a file keeps its permission bits (a script stays executable) and writes
  through a symlink to the file it points to, leaving the link a link — both used to be
  lost to the rename.
- `hatch.config.schema.json` has an `$id` that resolves, and its `version` description
  no longer spells out numbers that go stale.
- A patch applied to a CRLF file writes CRLF lines. A `.md` carries no line endings of
  its own — the parser reads `\r\n` and `\n` alike, and git or an editor may turn them
  either way — so a patch of several lines used to land with LF in the middle of a CRLF
  file, and `generate` → `apply` did not give the new file back. Now a bare LF of the
  patch takes the ending of the line the edit starts on. **An `apply` result changes**
  for multi-line patches on CRLF files only; the old result (mixed line endings) was
  the bug. LF files apply byte for byte as before. The same holds for the service's
  `resolve` and `apply`.
- The extension of a file is read from its name only: a dot in a directory
  (`my.proj/Makefile`) is no longer taken for one.

## 0.2.0 — 2026-09-24

**Protocol 2–2 · config schema 1–1**

### Breaking

- `--branch` takes a branch only; a tag or a raw sha is refused with a pointer to
  `--commit`.
  → pass a tag or a sha as `--commit v1.2`, not `--branch v1.2`.
- A value that is itself another option of the same command is refused
  (`--out --exact` used to write into a directory named `--exact`).
  → give every option that takes a value its value; a file literally named like an
  option goes as `./--exact`.
- `hatch.config.json` is looked for up to the repository root and never above the home
  directory: a config above the repository no longer applies.
  → move the file into the repository root (or pass it with `--config <path>`).
- `apply --out` follows the same placement rules as `generate --out`.
  → a relative `--out` now counts from the repository root and a directory gets the
  name of `--in` inside it; pass an absolute path to write exactly where you mean.

### Added

- The service: a long-running process speaking JSON over stdio — `version`, `generate`,
  `resolve`, `apply`, progress as separate messages. Hunk coordinates in both the base
  and the patched text. Protocol 1 was never released; this is protocol 2.
- Public API: `generatePatch` (the whole of `generate` on text) and `resolveHunks`.
- The old version out of git by three independent coordinates — `--head`, `--branch`,
  `--commit`, `--repo-path` — each one optional, each defaulted: the branch we are on,
  its last commit, the path of `--in`. `--branch` with `--commit` checks the commit is
  on the branch. The service takes the same as `baseGit`.
- One set of rules for `--out` in both commands: a directory or a file, missing
  directories created, a relative path from the repository root, `-` for stdout.
  `--mirror` / `generate.mirror` keeps patches in a tree of their own (the config key
  was added without raising the schema number — see VERSIONING.md).
- A misspelt option is met with the nearest one ("did you mean --branch?").
- `--log` overwrites its file instead of failing on it; a log that cannot be opened is
  a warning, the run goes on.

### Fixed

- Faster synthesis: the source map is built once per text, occurrences are counted
  lazily.

## 0.1.1 — 2026-08-27

**No service · config schema 1–1**

### Fixed

- The installed `hatch` command runs again: the `#!/usr/bin/env node` line is back.

## 0.1.0 — 2026-08-27

**No service · config schema 1–1**

First release.

- `hatch apply` — applies `.md` match/patch instructions to a source file, hunk by hunk.
- `hatch generate` — writes those instructions from two versions of a file, anchored
  structurally (enclosing blocks, not neighbouring lines), each hunk checked by applying
  it.
- `hatch grammars` — puts the tree-sitter grammars in place; the only command that goes
  online.
- Languages: C, C++, Objective-C, Java, Kotlin, JavaScript, TypeScript, TSX, Rust, Go,
  Python.
- `hatch.config.json` for the anchoring policy, with `--print-config` showing where
  every value came from.
- A public API (`applyAll`, `synthesize`, `parseHatchFile`, `printHatchFile`, the
  language adapters), `npm pack`, CI and the tag-driven release.
