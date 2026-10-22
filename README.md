# Hatch

**Structure-aware semantic patches for source code.** Instead of brittle line
numbers, a Hatch patch describes *where* to change code in terms of the code's
own structure — and the tool finds the spot. A TypeScript port of the original
Python prototype, with a typed AST and an npm-native pipeline (no Python in the
build).

> Русская версия: [README.ru.md](./README.ru.md)
> Architecture: [ARCHITECTURE.md](./ARCHITECTURE.md) · Contributing: [CONTRIBUTING.md](./CONTRIBUTING.md)

---

## Why

Patching a fast-moving upstream codebase with classic `.patch` files breaks
constantly: a few inserted lines upstream and every hunk's line numbers drift.
Hatch describes a change declaratively — "insert this *after that include*,
*inside that function*" — using three operators. The position is resolved against
the parsed structure of the file, so reformatting and unrelated edits upstream
don't invalidate the patch.

Three commands:

- **`apply`** — apply a `.hatch` instruction file to a source file.
- **`generate`** — diff two versions of a file and emit the `.hatch` instructions.
- **`init`** — write a `hatch.config.json` (see Configuration below).

`generate` then `apply` round-trips: applying a generated patch to the old file
reproduces the new file. `generate` guarantees this by construction — it applies
each candidate hunk with the real patcher and keeps only what reproduces the
change.

## The file format

A patch is a `.hatch` file: a header (its fields are under "The header" below), then
`match`/`patch` block pairs:

```
Hatch: 1
Target: src/a.cc
Base-Blob: 3b18e512dba79e4c8300dd08aeb37f8e728b8dad
Hatch-Version: 0.5.0
Grammar: tree-sitter-cpp@0.23.4

# match <language>
    <pattern, one four-space gutter per line>
# end
# patch
    <replacement text, same gutter>
# end
```

The blocks follow three rules:

1. **Column 0 belongs to the structure.** `# match`, `# patch` and `# end` are
   recognized only there.
2. **Every payload line carries a four-space gutter**, which is stripped on read.
   So a payload line can never reach column 0 — a ` ``` ` fence, a `# patch`
   heading or a `# end` inside a raw string is just text. There is no delimiter
   in this format that code could collide with.
3. **`# end` closes a block.** Blank lines inside a block are payload, trailing
   ones included; blank lines between hunks are not. Text between the header and
   the first `# match` is not significant: hatch does not read it.

A hunk may carry a comment: a `# note` … `# end` block right before its `# match`.
The note is free text in any column, without a gutter, and only people read it — the
matcher never does; over the service it comes back as the hunk's `note`. Text between
hunks outside a note is a parse error. `generate` never writes notes: rerunning it
over a `.hatch` replaces the notes along with the rest.

```
# note
WAIT: without it the driver hangs on a full buffer.
# end
# match c
    ...
```

A payload line that forgets the gutter is a parse error, never a silent loss.
The one exception worth knowing: a payload line made of *significant trailing
whitespace* is indistinguishable from junk to a whitespace fixer, so don't run
one over an instruction file — `generate` warns when it emits such a line.

Line endings are not payload. An instruction file may reach you with LF or CRLF —
git and editors turn them either way — and both read alike. A patch takes the line
ending of the file it lands in: in a CRLF file every line it writes ends in CRLF, in an
LF file it lands byte for byte. Where a file mixes the two, the line the edit starts on
decides.

### The header

The header is the first lines of the file of the form `Name: value`, up to the first blank
line, as in a Debian patch (DEP-3). It says which file the patch is for and what made it;
the hunks follow the blank line.

```
Hatch: 1
Target: chrome/browser/feature_list.cc
Base-Blob: 3b18e512dba79e4c8300dd08aeb37f8e728b8dad
Hatch-Version: 0.5.0
Grammar: tree-sitter-cpp@0.23.4
```

| # | field | value | when `generate` writes it | what hatch does with it |
|---|---|---|---|---|
| 1 | `Hatch` | the `.hatch` format number, an integer; now `1` | always | reads the patch only when the number is in the range this hatch knows: a newer patch is refused with "update hatch", an older one with "regenerate the patch" |
| 2 | `Target` | the file the patch is for: a relative path with `/`, no `..`. Measured from the `upstream` root when the config sets one, else from the repository root | when the patch has a place; not with `--out -`, nor for a patch outside a repository | `apply` without `--in` and `hatch-apply` find the file by it, and the editor extension jumps from the patch to the code. An absolute path or `..` is a parse error |
| 3 | `Base-Blob` | the id of the git blob of the old version the patch was made against | when the old version came out of git (`--head`, `--branch`, `--commit`, `generate.base`) | not checked — for reference. `git cat-file -p <Base-Blob>` prints the base the patch is known to apply to |
| 4 | `Hatch-Version` | the version of hatch that wrote the patch: `0.5.0` | always | not checked — for reference |
| 5 | `Grammar` | the tree-sitter grammar the file was parsed with: `<package>@<version>` | always | not checked — for reference. Another version of a grammar may parse code differently, and this field shows which one the patch was made with |

Rules:

- `Hatch` is always line 1. The other known fields follow in the order of the table, each
  at most once; a field left out does not move the rest. A known field out of its place,
  or named twice, is a parse error (exit 2).
- Field names are read without regard to case; spaces around a value are dropped.
- Fields hatch does not know may stand anywhere after `Hatch` and are read past: a header
  may carry fields of your own, such as `Author:` or a link to a ticket.
- A header line not of the form `Name: value` is a parse error: only a blank line ends the
  header.
- In a patch written by hand only `Hatch` is required. The header may be left out
  entirely: such a file reads as format 1, and `apply` then needs `--in`.
- A new field is only ever added at the end of the table (VERSIONING.md H4), so a header an
  older hatch wrote reads the same in a newer one.

## The language: three operators

The `match` block is written in the target language with operators interleaved:

| Operator | Meaning |
|----------|---------|
| `...`    | skip ahead to the next anchor (all occurrences are tried, with backtracking) |
| `>>>`    | insertion point |
| `<<<`    | end of the replacement range (which starts at `>>>`) |

Everything that isn't an operator is a **literal anchor** — a piece of the target
file that must be there. A pattern describes the file **as a whole**: no `...`
before the first literal means "starts at the very beginning of the file", and no
`...` after the last one means "ends at end of file".

Whitespace between literals and operators is insignificant for brace languages,
so the anchors can be copied out of the source and reindented freely. In Python it
is not: the leading indentation of a payload line is part of the anchor, and a
multi-line anchor therefore pins the level of every line it spans. Copy Python
anchors out of the source with their indentation intact.

**Inside a string literal, whitespace is data and it counts.** `Log("a  b")` and
`Log("a b")` are different anchors, and the second will not match the first. The
exception is a MULTI-LINE literal (`R"(…)"`, a docstring, a template literal, a Go
backtick): whitespace inside one still collapses. An anchor is a fragment cut on line
boundaries, so it can begin inside such a literal with no way to know — and levelling
both sides is the only way they can agree.

Operators are recognized only as standalone *words* (whitespace or line edge on
both sides), so `template <typename... Args>` stays literal. A genuine standalone
`...` in code is escaped as `\...`.

An operator between two words with no `...` — `int foo >>> bar;` — stands for the one
space between them: `bar` must follow `foo` after exactly one space of the canon (one
space inside a string literal too), and the insertion lands right after `foo`.

## Examples

Insert a call at the end of a function body:

```markdown
# match cpp
    ...
    void RegisterFeatures(FeatureList* list) {
      list->Add(kFastPath);
    >>>
    }
    ...
# end
# patch

      list->Add(kNewPath);
# end
```

Read it as: *skip anything, find that function header, then that call, **insert
here**, and the very next thing must be the closing `}` — then anything to end of
file.* The `}` is not decoration: it is what pins the insertion **inside** this
function (see the third fixed rule below).

Replace a range — everything between `>>>` and `<<<` is old code that must match
and is thrown away:

```markdown
# match cpp
    ...
    namespace content {
    ...
    >>>
    void RegisterFeatures( ... ) {
    <<<
    ...
# end
# patch
    // Registers every content feature.
    void RegisterFeatures( FeatureList* list ) {
# end
```

Note the `...` **inside** the anchor: the balanced innards of a bracket pair can
be skipped, so the anchor survives edits to the argument list. `generate` writes
its anchors this way by default.

## Install

hatch comes in three forms. Each installs on its own and serves its own task:

| what | for | what the system needs |
|---|---|---|
| [VS Code extension](https://github.com/Danil-Varakin/HatchVSCodeExtension-) | writing patches and seeing where every hunk lands, right in the editor | nothing: hatch and the grammars are inside the extension |
| `hatch-apply` | laying patches on the code in a project's build | nothing: Node and the grammars are inside the file; `git` when the base comes out of git |
| `hatch` (CLI) | `generate`, `apply`, `init` in a terminal, scripts and CI; the API for your own tools | Node.js 22 or newer; `git` when versions come out of git |

All three are tested in CI on Linux, macOS and Windows.

**VS Code extension.** The file `hatch-vscode-<version>.vsix` from the extension's
[Releases page](https://github.com/Danil-Varakin/HatchVSCodeExtension-/releases); in VS Code:
**Extensions** → **…** → **Install from VSIX…**. Details are in the extension's README.

**`hatch-apply`.** One executable per platform (linux-x64, linux-arm64, darwin-arm64,
win-x64) on [hatch's Releases page](https://github.com/Danil-Varakin/hatchTs/releases). How
to download it, check its checksum and call it is under
["Applying patches in a build"](#applying-patches-in-a-build-hatch-apply).

**`hatch` (CLI).** The package is not in the npm registry; every release on the same page
carries a `hatch-<version>.tgz`, and npm installs it by its URL:

```bash
npm i -g https://github.com/Danil-Varakin/hatchTs/releases/download/v<version>/hatch-<version>.tgz
```

You get a `hatch` command with the grammars of every language inside; nothing is fetched
afterwards. From a clone it also works without installing: `npm run hatch -- <command>`.

## Usage

```bash
# apply
hatch apply --match changes.hatch --in src/main.cpp --out src/main.cpp

# ...or patch the file as git holds it: does the patch still fit master?
hatch apply --match changes.hatch --in src/main.cpp --branch master --verify

# generate
hatch generate --in new.cpp --in-old old.cpp --out changes.hatch   # a file: it has an extension

# ...or take the old version from git: the same file, as of the last commit here
hatch generate --in src/main.cpp --head --out changes.hatch

# a branch (its last commit), a single commit, another path inside the repository
hatch generate --in src/main.cpp --branch master --out changes.hatch
hatch generate --in src/main.cpp --commit 1f3ac9d --out changes.hatch
hatch generate --in src/main.cpp --branch master --commit 1f3ac9d \
               --repo-path src/legacy/main.cpp --out changes.hatch

# a hatch.config.json at the root of the repository
hatch init
```

`hatch` with no arguments lists the commands, `hatch <command> --help` shows its
options, `hatch --version` reports the tool version and the config schema version.

Exit codes, for scripts to rely on:
`0` ok · `1` usage or any other refusal · `2` `.hatch` parse · `3` no match ·
`4` ambiguous · `5` config · `6` grammar · `7` no changes · `8` cannot anchor (details
under "Exit codes" below).

### `apply` options
```
--match, -m <file.hatch>   the patch                                  [required]
--in,    -i <file>         the file the patch is applied to. Left out, it is the
                           file in the patch's Target: from the project's upstream
                           root (the config is searched up from the patch), with no
                           upstream from the root of the repository holding the
                           patch. Read from disk. With --head, --branch, --commit
                           or --repo-path only its path is used, the content comes
                           out of git, and the file need not exist on disk
--head,   -H               the file from git: the last commit of the current
                           branch, the path of --in
--branch, -b <branch>      the file from the last commit of this branch, local or
                           remote-tracking. A tag or a sha here is asked about first
--commit, -c <revision>    the file from this commit: a sha, a tag, HEAD~3. With
                           --branch the commit must be on that branch, or you are asked
--repo-path  <path>        read this path from git instead of the path of --in;
                           from the repository root. The result is still named after --in
--eol <repository|worktree>
                           line endings of the file read from git: as git stores
                           them (default) or as --in on disk has them (core.autocrlf)
--out,   -o <path>         where to write the result   [required unless --dry-run or --verify].
                           An existing directory or a path ending in a slash gets
                           <name of --in> inside it; any other path is the file
                           name, and it is overwritten. Missing directories are
                           created, a relative path is from the repository root,
                           `-` is stdout. A file that already holds this result is
                           not written, and its modification time stays. Writing
                           over --in taken from git asks first when --in holds
                           changes the git version lacks
--language, -l <lang>      the language; else `# match <lang>` in the patch, else
                           the extension of --in
--dry-run                  print the edits the patch would make; write nothing
--verify                   check that the patch applies: the answer is the exit code
                           alone (0 — it applies), nothing is written. The patch is
                           checked on a version out of git: the flags above, else
                           generate.base of the config. With neither, hatch asks at
                           a terminal whether the files on disk are the base; with
                           no terminal it refuses
--base-from-disk           with --verify: the base is the files on disk, no question
--config <file>            this config instead of the one found up from the patch
--no-config                read no config; --in is then required
--log [place]              write a full log to a file with mode 0600. A place that
                           is a directory or ends in a slash gets a file with a new
                           name for every run; any other place is the file name,
                           overwritten. No value — ./hatch-logs/
--yes,   -y                answer yes to every question in advance. Without --yes
                           and without a terminal the answer is no, and the run stops
--help,  -h                this help
```

### `generate` options
```
--in,     -i <file>        the new version of the file                [required]
--in-old     <file>        the old version: a file on disk
--head,   -H               the old version from git: the last commit of the current
                           branch, the path of --in
--branch, -b <branch>      the old version from the last commit of this branch, local
                           or remote-tracking. A tag or a sha here is asked about first
--commit, -c <revision>    the old version from this commit: a sha, a tag, HEAD~3.
                           With --branch the commit must be on that branch, or you are asked
--repo-path  <path>        the old version is this path in git instead of the path
                           of --in; from the repository root, not the current directory
--eol <repository|worktree>
                           line endings of the old version read from git: as git
                           stores them (default) or as --in on disk has them
                           (core.autocrlf)
--out,    -o <path>        where to write the .hatch. A path with no extension, one
                           ending in a slash, or an existing directory gets
                           <name of --in>.hatch inside it; a path ending in .hatch is
                           the file itself, overwritten; any other extension is
                           refused, exit 5. Missing directories are created, a
                           relative path is from the repository root. Left out —
                           next to --in. `-` is stdout
--language, -l <lang>      the language; else by the extension of --in
--exact,  -e               the patch reproduces the new file byte for byte. Without
                           it lines are compared after normalization: indentation
                           and inner spacing do not count, the set of lines does
--agreement, -a            show each hunk as it is made: Enter keeps it, n opens the
                           editor to write the hunks by hand. Refusing the editor,
                           or input that ends, stops the run and no .hatch is
                           written. Answers may be piped in, one line per hunk
--parents <n|all>          at most n enclosing blocks in a pattern (all)
--min-parents <n>          at least n enclosing blocks in every pattern (1)
--require-parents          when the change cannot be tied to any enclosing block,
                           refuse rather than write a pattern with no structure
--parent-detail <n>        bracket levels spelled out in the headers of enclosing
                           blocks, from the outermost: 0 gives `foo( ... )`,
                           1 gives `foo(bar( ... ))` (0)
--min-siblings <n>         at least n neighbouring significant lines on each side
                           of the change in every pattern (0)
--siblings <n>             at most n neighbouring significant lines on each side (8);
                           0 — neighbouring lines are not used
--sibling-detail <n>       bracket levels spelled out in neighbouring lines, from
                           the outermost (0)
--bridge-gap <n>           changes with at most n unchanged non-blank lines between
                           them become one hunk (0)
--config <file>            this config instead of searching; the path is not bound
                           to a repository, so one config can serve several
--no-config                read no config: built-in defaults and flags only
--print-config             print the effective settings, the config file, and the
                           origin of each value (default, config, flag), then exit
--debug,  -v               trace synthesis to stderr: every segment of the change,
                           every anchoring probe and the chosen hunk
--log [place]              write a full log — the settings with their origins and
                           the whole synthesis trace — to a file with mode 0600. A
                           place that is a directory or ends in a slash gets a file
                           with a new name for every run; any other place is the
                           file name, overwritten. No value — ./hatch-logs/
--yes,    -y               answer yes to every question in advance. Without --yes
                           and without a terminal the answer is no, and the run stops
--help,   -h               this help
```

In brackets — the default. The anchoring options and `--out`, `--language`, `--exact`,
`--head`, `--branch`, `--commit`, `--eol` can be pinned in the config (see "Configuration").

### `init` options
```
--config-version <n>       the config schema version; default the newest this hatch
                           reads (printed by `hatch --version`)
--dir <dir>                where to write hatch.config.json; default the root of the
                           git repository around the current directory, outside one
                           the directory itself
--upstream <path>          write "upstream" — the root of somebody else's code, from
                           the config's directory — and "generate.out": "patches".
                           A directory that is not there is refused
--out <dir>                with --upstream: the value of generate.out instead of "patches"
--force                    replace an existing hatch.config.json; without it —
                           refused, exit 5
--dry-run                  print the file to stdout, write nothing
--help,   -h               this help
```

`init` writes only `"$schema"` and `"version"` (with `--upstream`, also `"upstream"` and
`generate.out`): every other value stays the built-in one until you set it.

### A version out of git

`--head`, `--branch`, `--commit` and `--repo-path` work the same in `generate` (the old
version) and in `apply` (the file the patch is applied to). The version is named by three
**independent coordinates**; any may be left out and then takes its default:

| coordinate | flag | left out means |
|---|---|---|
| branch | `--branch` | the branch we are on |
| commit | `--commit` | the last commit of that branch |
| path   | `--repo-path` | the path of `--in` inside the repository |

All three left out is the same file as of the last commit; asking for it takes `--head`.
`--branch master` is the last commit of `master`, `--commit 1f3ac9d` is the same file in
that commit, `--repo-path` swaps the file without changing the commit.

A commit names a version on its own and is taken as given. `--branch` beside `--commit`
claims the commit is on that branch; when it is not, hatch asks before reading. `--branch`
takes only a branch: a tag or a sha is asked about, with a pointer to `--commit`.
`--repo-path` takes only a file: a directory is refused.

`--in-old` is a path on disk, completed by your shell; `--repo-path` is a path in the
repository, looked up by git.

### How much context a hunk carries

The anchoring options choose between two kinds of failure. More enclosing blocks and fewer
neighbouring lines make the anchor **structural**: it survives neighbouring lines being
edited by someone else's commit, because an unclosed `{` orders the search and its closer
keeps the change inside the block. Fewer blocks and more neighbours give a shorter anchor
that reads better but drifts with its neighbours.

hatch answers ambiguity with detail first: it spells out one bracket at a time — the one
that actually cuts down the places the anchor can start — and stops when no bracket helps.
There is no ceiling on this. Only then does it add neighbouring lines.

`--parent-detail` and `--sibling-detail` set how many brackets are spelled out in every
hunk at once. A longer anchor stays unique but breaks more often when the upstream edits
arguments. That trade cannot be measured from one pair of versions, so it is a setting,
not an automatic choice.

### Settings by task and language

The built-in values are the best general choice in every language of "Language
support": the ladder itself takes as many parents and neighbours as uniqueness needs,
usually one neighbour. Change them for a specific risk — what the upstream is going to
do to the code around the patch.

| task | in `hatch.config.json` | what you gain | what you pay |
|---|---|---|---|
| the general case | nothing | the patch survives a new argument on a neighbour and on the function, reindenting, blocks inserted and moved (not in Python and YAML — see below) | a renamed parent or a renamed line above the edit — refused |
| the code has copies: generated code, the same method in several classes | `"parents": { "min": 99 }` | a copy of the function elsewhere is never taken for it | renaming any enclosing block (function, class, namespace) — refused |
| the upstream often renames functions and classes | `"siblings": { "min": 2 }` | a renamed container survives twice as often | an edit to the line two above the change — refused |
| shorter, more readable hunks | `"parents": { "detail": { "base": 1 } }` | parent headers with their arguments; in C++ a fifth shorter pattern | a new function parameter or a renamed condition — refused |
| the upstream often changes arguments | nothing (`detail.base` 0) | `foo( ... )` survives a new argument | — |

What not to do:

- `"parents": { "max": 1 }` or `2` — on repeated code (identical function bodies)
  `generate` fails as ambiguous;
- `"siblings": { "max": 0 }` — a line added in the middle of a block has nothing to be
  anchored to: without neighbours only an edit at the edge of a block is placed, where
  the closing bracket stands in for the neighbour;
- `"siblings": { "detail": { "base": 1 } }` — a new argument on a neighbouring line, the
  most common upstream edit, is refused.

`exact` does not change anchoring: it decides whether whitespace is compared, not where
the anchor is.

What depends on the language:

| language | spelled verbatim in an anchor | recommendation |
|---|---|---|
| C++, Java, JavaScript, TypeScript | names; arguments and conditions are `( ... )` | built-in values |
| Go, Rust, Kotlin, IDL | the condition of a block (`if ctx.ready {`, `group ready {`) | built-in values; a renamed condition is refused with any settings |
| Python | the condition of a block (`if ctx.ready:`) | built-in values; a renamed condition is refused with any settings; a block that changes its place among its neighbours (moved, swapped with one, a new block next to it) may land in the wrong place without an error, with any settings |
| YAML | lines as they are; read as text, its indentation makes no blocks | built-in values; as in Python, a block that changes its place among its neighbours may land in the wrong place without an error |
| HTML, XML | attribute values in headers and neighbouring lines | built-in values; an attribute edited next to the patch is refused at any detail |
| JSON | keys | built-in values; a renamed neighbouring key is refused |
| CSS | the selector; arguments are `( ... )` | built-in values |

The keys of one config apply to every language of the project. A setting for one
language is given by a flag on the run or by a separate config (`--config`).

Numbers and the stand: `npm run bench -- --case tuning` (one model of code in 18
languages, nesting depth 1–3, distinct / repeated / cloned bodies, the edit in the middle
and at the end of a block, 22 kinds of upstream edit); the claims of this section are
held by `test/unit/tuning.test.ts`.

### Writing a hunk by hand

When synthesis cannot anchor a change — two identical places, say — and a person is at the
terminal, `generate` explains why and opens the editor (`$VISUAL`, else `$EDITOR`, else
`vi` / `notepad`). The editor gets the `.hatch` so far: **every** hunk, a hunk to start
from for this change, and the change itself quoted on top. The text that comes back is
checked: it has to parse, and every hunk has to land on the old version in order. If it
does not, the reason goes on top and the question repeats; answering no stops the run
without a `.hatch`, and the edited file is kept (its path is printed). Once it stands,
synthesis goes on from the text those hunks produce. A patch body edited to differ from
`--in` stays as edited, and the run ends with a warning.

With no terminal — a script, CI — `generate` exits with code 8.

Through the service (an editor extension) the same round trip is `SynthesisError`'s
`detail.draft` sent back as `generate`'s `keep` — see [PROTOCOL.md](./PROTOCOL.md).

### When hatch asks before going on

Some requests git can carry out but that may not say what was meant. Those are **asked
about**: the warning says what going ahead means.

| situation | going ahead means |
|---|---|
| `--commit` is not on the `--branch` named beside it | the commit is read out of a history the branch never had |
| `--branch` names a tag or a sha | it is read as a plain revision, as with `--commit` |
| `apply` writes over `--in` taken from git, and the file holds changes that version lacks | the patched git version takes its place; uncommitted changes are lost |
| `generate` writes a patch where the patch of another file already is | that patch is overwritten |

```
warning: commit 1f3ac9d is not on branch main — going ahead reads that commit all the
same, out of a history branch main never had
  go ahead? [y/N]
```

The default is **no**. `--yes` / `-y` answers yes in advance. With no terminal — a pipe,
CI — the answer is no, and the run stops with a hint about `--yes`.

What git cannot carry out at all — a branch, commit or file that is not there, a directory
where a file goes, git not runnable — is always a refusal, and `--yes` does not change that.

### Configuration

`hatch.config.json` pins the settings of `generate` for a project, so the flags need not be
repeated on every run. `hatch init` writes one (options above).

- The format is JSON with no comments and no trailing commas.
- Precedence: built-in defaults < `hatch.config.json` < command-line flags.
- The config is chosen in this order, the first found wins:
  1. `--config <file>`;
  2. `hatch.config.json` up the directories from `--in` (for `apply`, from the patch) to
     the repository root; the search never enters the home directory;
  3. a config whose `upstream` holds the file — in the subdirectories of repository roots
     on the way up and in directories above the repository (see "A project over somebody
     else's code"); two of them are an error naming both;
  4. the file in `$HATCH_CONFIG`;
  5. `hatch.config.json` in the current directory, if its `upstream` holds the file.
- `apply` takes only `upstream` (where `Target` is measured from) and `generate.base` (the
  base of `--verify`) from the config. How a patch is read, the config never changes: a
  `.hatch` means the same on every machine.
- An unknown key, a value of the wrong type, a negative or fractional number — refused with
  exit 5, and the message names the key.
- Write only the keys that differ from the built-in values: then a better default in a
  later hatch reaches the project.
- The effective settings and the origin of each: `hatch generate --in src/a.cc --print-config`.

#### Config keys

| key | value | default | flag | purpose |
|---|---|---|---|---|
| `$schema` | URL | — | — | The JSON Schema of the version `version` names. For editors only — completion and checking while you type; hatch never reads it |
| `version` | integer, now `2` | the newest this hatch reads | `init --config-version` | The schema version the file is written for; keys are checked against it. A version newer than this hatch knows is refused with "update hatch" |
| `upstream` | path or `null` | `null` | `init --upstream` | The root of somebody else's code the project writes patches for; a path from the config's directory. With it `generate.out` must be a directory, and patches are laid out in it by the path of each file from that root |
| `generate.out` | path or `null` | `null` | `--out` | Where the `.hatch` is written. `null` — next to the source file. A value with no extension or ending in a slash is a directory, and the patch in it is named `<file name>.hatch`; a value ending in `.hatch` is the file itself; any other extension is refused. A relative path is from the repository root, and with `upstream` from the config's directory |
| `generate.language` | language name or `null` | `null` | `--language` | The language of the files. `null` — by the extension. Needed when the extension points at the wrong language: `.h` holding C, say (`.h` is C++ by default) |
| `generate.exact` | `true` / `false` | `false` | `--exact` | `true` — the patch reproduces the new file byte for byte. `false` — lines are compared after normalization: indentation and inner spacing do not count, the set and order of lines do |
| `generate.bridgeGap` | 0–1000 | `0` | `--bridge-gap` | Two changes with at most this many unchanged non-blank lines between them become one hunk. A larger value gives fewer, longer hunks |
| `generate.parents.min` | 0–1000 | `1` | `--min-parents` | The least number of enclosing blocks (function, class, namespace) in every pattern. An enclosing block ties the change to the structure, so it does not move to another function when neighbouring lines change. `0` allows a pattern with no enclosing block |
| `generate.parents.max` | 0–1000 or `"all"` | `"all"` | `--parents` | The most enclosing blocks in a pattern. hatch adds them from the inside out until the place of the change is unique |
| `generate.parents.required` | `true` / `false` | `false` | `--require-parents` | `true` — when the change cannot be tied to any enclosing block, `generate` refuses rather than write a pattern with no structure |
| `generate.parents.detail.base` | 0–1000 | `0` | `--parent-detail` | Bracket levels spelled out in the headers of enclosing blocks, from the outermost; the rest becomes `...`. `0` gives `foo( ... )`, `1` gives `foo(bar( ... ))`. More reads easier, but the pattern breaks more often when arguments change |
| `generate.siblings.min` | 0–1000 | `0` | `--min-siblings` | The least number of neighbouring significant lines on each side of the change in every pattern |
| `generate.siblings.max` | 0–1000 | `8` | `--siblings` | The most neighbouring significant lines on each side in a pattern. `0` — the pattern leans on the structure alone |
| `generate.siblings.detail.base` | 0–1000 | `0` | `--sibling-detail` | Bracket levels spelled out in neighbouring lines, from the outermost |
| `generate.base.head` | `true` / `false` | `false` | `--head` | `true` — the old version comes out of git: the last commit of the current branch |
| `generate.base.branch` | branch name or `null` | `null` | `--branch` | The old version is the last commit of this branch, local or remote-tracking. `null` — the current branch |
| `generate.base.commit` | revision or `null` | `null` | `--commit` | The old version is this commit: a sha, a tag, `HEAD~3`. With `branch` it must be on that branch. `null` — the last commit of the branch |
| `generate.base.eol` | `"repository"` / `"worktree"` | `"repository"` | `--eol` | Line endings of the version read from git. `"repository"` — as git stores them; `"worktree"` — as the file on disk has them. `"worktree"` is needed with `core.autocrlf=true`, or every line looks changed |

Any of `generate.base.head`, `branch`, `commit` means "the old version comes out of git". A
git flag on the command line replaces all three for that run; `--in-old` ignores them.

#### Examples: `out`, `base`, `upstream`

**`generate.out` — where the patch goes.** Without it the patch sits next to its file:

```json
{ "version": 2 }
```
```
repo/
├── src/net/http.cc
└── src/net/http.cc.hatch        hatch generate --in src/net/http.cc --head
```

A directory in `out` gathers every patch in one place — flat, by file name:

```json
{ "version": 2, "generate": { "out": "patches" } }
```
```
repo/
├── src/net/http.cc
└── patches/
    └── http.cc.hatch
```

When two files share a name (`src/net/http.cc` and `src/ui/http.cc`), their patches claim
one place, and hatch asks before overwriting. `upstream` (below) avoids that.

**`generate.base` — what the file is compared with.** Without it every `generate` run needs
`--in-old` or a git flag. With it, `--in` is enough:

| `base` | old version | what the patch describes |
|---|---|---|
| `{ "head": true }` | the last commit of the current branch | the uncommitted changes of the file |
| `{ "branch": "main" }` | the last commit of `main` | everything the working file differs from `main` by — the changes of a development branch, say |
| `{ "commit": "v1.0" }` | the tag `v1.0` | everything changed since that release |

```json
{ "version": 2, "generate": { "base": { "branch": "main" } } }
```

**`upstream` — patches as a tree.** `upstream` names the root of the code the patches are
for, and `out` the directory where patches repeat the paths of files from that root. `"."`
— the root is the config's directory, the repository itself:

```json
{ "version": 2, "upstream": ".", "generate": { "out": "patches", "base": { "head": true } } }
```
```
repo/
├── hatch.config.json
├── src/net/http.cc
├── src/ui/http.cc
└── patches/
    └── src/
        ├── net/http.cc.hatch    Target: src/net/http.cc
        └── ui/http.cc.hatch     Target: src/ui/http.cc
```

When patches and code live in different repositories, `upstream` points from the config's
directory to the other code — `".."`, say; see "A project over somebody else's code".

What `generate` does with each kind of `--out` (or `generate.out`):

| `--out` | the patch goes to | `Target` |
|---|---|---|
| not given | next to `--in`: `<in>.hatch` | from the repository root |
| `-` | stdout | — |
| `patches`, `patches/`, an existing directory | `<repository root>/patches/<name of --in>.hatch` | from the repository root |
| `p.hatch`, `deep/p.hatch` | that file, from the repository root | from the repository root |
| `p.md`, `p.txt` | refused, exit 5 | — |
| an absolute path | as above, from `/` | none when the patch is outside the repository |
| with `"upstream"` and a directory | `<config dir>/<out>/<path from the upstream>.hatch` | from the upstream root |
| with `"upstream"` and `-` or no `out` | refused, exit 5 | — |

A relative path is measured from the repository root, not the current directory: the same
settings mean the same place in a terminal, in an editor and in CI. Outside a repository —
from the directory of the file. The same file's patch, and a file named outright
(`--out x.hatch`), are overwritten without asking.

### A project over somebody else's code

A fork keeps its patches in a repository of its own and patches code it never commits
to. Say the upstream is checked out in `work/`, and the project sits inside it:

```
work/                         the upstream — a repository you do not commit to
├── src/ui/window.cc
├── third_party/zlib/         a repository of its own inside it
└── myfork/                   your project — your repository
    ├── hatch.config.json
    └── patches/
```

`work/myfork/hatch.config.json` says where the code is:

```json
{ "version": 2, "upstream": "..", "generate": { "out": "patches", "base": { "head": true } } }
```

`upstream` is the root of the patched code, **from the config file**. With it the patch
of `work/src/ui/window.cc` is `work/myfork/patches/src/ui/window.cc.hatch`, and its
`Target` is `src/ui/window.cc`. The base comes out of the git repository nearest the
file — `work/third_party/zlib/...` is read from zlib's own repository, with no list of
repositories to keep.

```bash
hatch generate --in work/src/ui/window.cc                   # finds myfork's config
hatch apply --verify --match work/myfork/patches/src/ui/window.cc.hatch
```

The config of a file is found by its claim: up from the file to its repository root
first; then in the immediate subdirectories of every repository root on the way up
(`work/*/hatch.config.json`), and in the directories above the repository. Two configs
that claim one file are an error that names both.

| layout | config | `upstream` |
|---|---|---|
| the project inside the upstream | `work/myfork/hatch.config.json` | `".."` |
| the upstream inside the project | `proj/hatch.config.json`, code in `proj/upstream/` | `"upstream"` |
| beside each other | `ws/proj/hatch.config.json`, code in `ws/upstream/src/` | `"../upstream/src"` — run from `ws/proj`, or pass `--config` / `$HATCH_CONFIG` |
| one repository, patches in a tree of their own | at the repository root | `"."` |
| one repository, a patch next to its file or in one directory | at the repository root | none |

`hatch init --upstream ..` writes such a config.

### Exit codes (for CI)
`0` success · `2` parse error · `3` no match (reports the deepest point the
pattern reached) · `4` ambiguous match (reports the competing positions) · `5`
bad configuration · `6` grammar missing or failing its checksum · `7` `generate`
found nothing to change — the new version is the old one after normalization (spacing
and blank lines alone are no change), or byte for byte with `--exact` — and wrote no
`.hatch` · `8` `generate` could not anchor a change: no pattern around it lands there and
only there (at a terminal the editor is offered first) · `1` everything
else: a wrong invocation, a missing file, a git refusal, an unknown language, a
question answered no, or an unexpected failure.

`6` is deliberately its own code: it says the *build* lacks a grammar, or holds one that
is not the pinned one (`HATCH_GRAMMAR_DIR`), not that anything is wrong with the patch.

Ambiguity is an **error**, never a silent pick: if a pattern fits in two places
with different results, you get exit `4` and the positions, and the fix is more
context.

When a patch won't apply, `--debug` on `generate` is the fastest way to see how
the anchors were chosen; `--dry-run` on `apply` shows the exact edits without
touching the file.

## Applying patches in a build: `hatch-apply`

A project's build should not need Node, npm or the network to lay its patches on the
code. Every release carries `hatch-apply` — one executable with Node, the tree-sitter
runtime and every pinned grammar inside — for linux-x64, linux-arm64, darwin-arm64 and
win-x64, and a `SHA256SUMS` beside them. It is the same engine as `hatch apply`: a patch
`generate` made that applies in the editor applies in the build.

```bash
curl -LO https://github.com/Danil-Varakin/hatchTs/releases/download/v0.4.1/hatch-apply-0.4.1-linux-x64
curl -LO https://github.com/Danil-Varakin/hatchTs/releases/download/v0.4.1/SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS
install -m755 hatch-apply-0.4.1-linux-x64 tools/hatch-apply

tools/hatch-apply verify --match myfork/patches/src/ui/window.cc.hatch
tools/hatch-apply apply  --match myfork/patches/src/ui/window.cc.hatch
```

| | |
|---|---|
| `hatch-apply apply --match <patch> [--out <path>]` | lays the patch on its file — in place without `--out` |
| `hatch-apply verify --match <patch>` | the same, writing nothing: exit 0 when it applies cleanly |
| `hatch-apply --version` | its version, the Node inside, the pin of every grammar |

The file is the one the patch names in `Target`, found through the project's
`hatch.config.json` as `hatch` finds it (`--in` names another). The base is always a
clean one: out of git — `--head` / `--branch` / `--commit`, else `generate.base` of the
config — or, with `--base-from-disk`, the files on disk as they are (and it warns that
it took them so); those must be the clean base, never files a patch was already laid on
(see "Known limitations"). With neither it stops with exit 5. It **never asks**: what
`hatch` would ask about (a tag named as a branch, a commit off the branch named) is refused, and
said. In place, a file that already holds the result is not written again, so the build
does not recompile it; a file with changes of its own — the result of a patch that has
changed since, say — is written over, and said: the code a build patches is not the
project's to keep. Its options are picked out of `hatch apply`'s, each with the same
meaning; it does not generate, serve or download. For a base out of git, `git` must be
on the `PATH`.

## API

```ts
import { applyAll, synthesize, parseHatchFile, printHatchFile, adapterForLanguage } from 'hatch';

const adapter = adapterForLanguage('cpp');
await adapter.init();

const { source, edits } = applyAll(oldCode, parseHatchFile(md), adapter);
const md2 = printHatchFile(synthesize(oldCode, newCode, adapter), 'cpp');
```

### Functions

| | |
|---|---|
| `applyAll(source, file, adapter)` | applies hunks in order; returns `{ source, edits }`. Throws `MatchError` or `AmbiguityError` on the first hunk that does not fit |
| `synthesize(old, new, adapter, options?)` | produces `Hunk[]` from two versions of a file. Throws `SynthesisError` when a change cannot be anchored |
| `generatePatch(request)` | the whole of `generate` in one call, on text: the `.hatch` with its header, warnings, links. Throws `NoChanges` when there is nothing to change |
| `resolveHunks(source, file, adapter)` | where each hunk lands: the patch, the base and the patched text side by side, a failure per hunk instead of a throw |
| `parseHatchFile(text)` | `.hatch` → `HatchFile` |
| `printHatchFile(hunks, language?)` | `Hunk[]` → `.hatch` |
| `trailingSpaceWarnings(hunks)` | patch-body lines that end in significant whitespace |
| `adapterForLanguage(name)` | adapter by language name |
| `adapterForFile(path)` | adapter by file extension |
| `supportedLanguages` | names and aliases in the registry |

`adapter.init()` is called once and loads the grammar; `buildMap` is synchronous
afterwards.

### Errors

`HatchError` is the base class. Each subclass carries an `exitCode` matching the CLI:
`ParseError` (2), `MatchError` (3), `AmbiguityError` (4), `ConfigError` (5),
`GrammarError` (6), `NoChanges` (7), `SynthesisError` (8), and `GitError`,
`LanguageError`, `PathError` (1).

### Types

`HatchFile`, `Hunk`, `MatchPattern`, `LanguageAdapter`, `ApplyResult`, `AppliedEdit`,
`SynthOptions`, `SynthEvent`, `Tracer`, `GenerateRequest`, `GenerateOutcome`,
`HunkLink`, `LinkFailure`, `LinkStatus`, `ResolveResult`, `Span`, `SynthesisFailure`.

### Boundaries

Only the above is exported. The matcher, patcher, canonicalizer, source map, `infra/`
and the contents of the language folders are internal and change without notice;
sub-paths (`hatch/dist/...`) are closed off by the `exports` field.

`LanguageAdapter` is available as a type: adapters are obtained from the registry and
handed back. Writing your own adapter is not supported.

## Service: hatch for an editor

`node node_modules/hatch/dist/bin/service.js` runs hatch as a long-lived process that
speaks JSON over stdio: `generate`, `resolve` and `apply` on text instead of files, and
coordinates of every hunk in the base and in the patched text. It is what the VS Code
extension talks to. The contract, and how its version is checked, is in
[PROTOCOL.md](./PROTOCOL.md); the types are published as `hatch/protocol`.

## Grammars

Parsing is done by tree-sitter, so every language needs its `.wasm` grammar. They
**ship inside hatch** — about 17 MB for all of them, 1.7 MB in the packed archive — and
nothing is downloaded at run time. Each language pins its grammar in its own folder:

```ts
grammar: {
  file: 'tree-sitter-go.wasm',
  package: 'tree-sitter-go',
  version: '0.25.0',
  sha256: '9504573f352b20be7f2f1911754d710622aedc15afff16d5ed8fb5645681aee7',
},
```

and the bytes must match the pin wherever they are found: a `.wasm` is executable code,
and another grammar can place a hunk elsewhere (F3), so a file with another sha256 fails
the run (exit `6`). A grammar missing altogether is a fault of the build, said so.

| Variable | Effect |
|---|---|
| `HATCH_GRAMMAR_DIR` | look here first — work on the core, a build of one's own; the pin still holds |

The grammars are not in the repository: `npm run grammars`
(`scripts/fetch-grammars.ts`) puts the pinned ones into `grammars/`, and `npm test` and
`npm pack` run it. `node --experimental-strip-types scripts/fetch-grammars.ts --pin
<package@version>` prints the block to paste into a new language's `index.ts`.

## Three rules fixed by decision (not derivable from syntax)

These are intentional and stable; patches rely on them:

1. **`<<<` replaces *inclusively*.** Literals between `>>>` and `<<<` are "old
   code": they must match but are not emitted — the patch body takes their place.
   Literals *outside* the markers are context and are preserved.
2. **A pattern describes the whole file.** `...` is the only way to skip. A
   missing leading `...` means the first anchor sits at offset 0; a missing
   trailing `...` means the last anchor ends at EOF.
3. **An unclosed `{` orders, it does not lock.** Matching an opening brace only
   means "the next anchor comes after it" — the search still runs to end of file,
   and leaving the block is legal. To keep an edit *inside* a construct you must
   write that construct's closing token in the pattern. This is why `generate`
   emits both the header of an enclosing function and its `}`. In Python a block
   has no closing token: the next line at its level closes it, and that line
   closes every block nested inside it too — `class Archive:` at column 0 ends the
   method and the class before it at once.

## Known limitations

What hatch does not do, on purpose or not yet — worth knowing before you rely on it:

- **Identical code with identical context cannot be told apart.** The pattern
  language has no "the n-th occurrence": when two places match word for word, their
  neighbours included, `generate` reports ambiguity and `apply` exits `4`. Write that
  anchor by hand, leaning on code that differs — often what comes *after* the edit.
- **"Already applied" is not recognized — the workflow rules it out instead.** hatch
  does not check whether a patch is in the file already: it finds the place and writes.
  Laid a second time on its own result, a patch may lay an insertion again with exit 0
  — `... void g() { ... >>> } ...` still finds the end of `g()`; on the wrong file it
  usually ends in exit `3`. So every run that matters starts from a clean base:
  `apply --verify` and `hatch-apply` read the file out of git (`--head`, `--branch`,
  `--commit` or `generate.base`), and `generate` checks every hunk on the old text it
  was given. Patch the files on disk (`hatch apply` without a git coordinate,
  `--base-from-disk`) only when they are that clean base, never a file already patched.
- **Line endings belong to the file, not to the patch.** A patch writes its lines
  with the ending of the line the edit starts on, so a patch cannot convert CRLF lines
  to LF (or back) where it starts on a CRLF line.
- **Git with `core.autocrlf=true`** (the Git for Windows default): a version read out
  of git has the line endings the repository stores (LF), while the file on disk has
  CRLF, so `generate --head --exact` sees every line as changed. Add `--eol worktree`
  (or `generate.base.eol: "worktree"` in the config) to read it with the endings of the
  file on disk, set `core.autocrlf false` for the repository (as Chromium's Windows setup
  also asks), or pass the old version
  with `--in-old`.
- **Large files full of near-identical code make `generate` slow** — seconds to minutes
  where one pattern has to be tried against many look-alike places.
- **Writing a file keeps its permission bits and writes through symlinks**, but not its
  owner, ACLs or extended attributes, and a hard link to it is split off — the write
  goes through a temp file and a rename, so that a run cut short never leaves half a file.
- **Whitespace inside a multi-line string literal is not significant** (see "The
  language"), and `.mm` is read with the Objective-C grammar (see "Language support").

## Language support

The languages Chromium is written in, and the markup of its resources:

| Language | Extensions | Heading / `--language` |
|----------|-----------|------------------------|
| C++ | `.cc` `.cpp` `.cxx` `.h` `.hpp` `.inc` | `cpp`, `c++`, `cc`, `cxx`, `h`, `hpp` |
| C | `.c` | `c` |
| Objective-C | `.m` `.mm` | `objc`, `objective-c` |
| Python | `.py` `.pyi` `.star`, `DEPS` | `python`, `py` |
| JavaScript (incl. JSX) | `.js` `.mjs` `.cjs` `.jsx` | `javascript`, `js`, `jsx` |
| TypeScript | `.ts` `.mts` `.cts` | `typescript`, `ts` |
| TSX | `.tsx` | `tsx` |
| Rust | `.rs` | `rust`, `rs` |
| Java | `.java` | `java` |
| Kotlin | `.kt` `.kts` | `kotlin`, `kt` |
| Go | `.go` | `go`, `golang` |
| HTML | `.html` `.htm` | `html`, `htm` |
| XML | `.xml` `.plist` | `xml`, `plist` |
| CSS | `.css` | `css` |
| JSON | `.json` | `json` |
| JSON5 | `.json5` | `json5` |
| IDL | `.idl` `.webidl` | `idl`, `webidl` |
| Mojom | `.mojom` | `mojom` |
| Protocol Buffers | `.proto` | `proto`, `protobuf` |
| Shell | `.sh` `.bash`, `postinst`, `postrm`, `preinst`, `prerm` | `shell`, `sh`, `bash` |
| YAML | `.yaml` `.yml` | `yaml`, `yml` |
| TOML | `.toml` | `toml` |
| Text | `.txt` | `text`, `txt` |

`generate` writes the language's own name into the heading — the first name in the
last column (`cpp`, `objc`, `python`), however the language was picked. Every
extension in the table, without its dot, is a name as well: hatch 0.2.0 and earlier
wrote that (`# match mm`), and such a `.hatch` applies the same.

Structure comes from tree-sitter, so preprocessor branches, raw strings, macros
and generics (`Map<K, V>` is a bracket pair, `a < b` is not) don't confuse the
pairing. `.h` is C++ by Chromium convention. `.mm` is Objective-C++, which no
tree-sitter grammar covers fully — the Objective-C grammar handles it best and
degrades to plain text matching on the C++-only parts.

In HTML and XML a block is an element with both tags: the start tag, attributes
included, is its header, and the end tag closes it — `<div id="a">` … `</div>` as
`{` … `}`. An element with no end tag (`<img>`, an open `<p>`) and `<br/>`, `<tag/>`
are no block. `<script>` and `<style>` are blocks whose content is text. Inside a
quoted attribute value whitespace is data, as in a string literal; elsewhere it is
free.

In CSS a block is `{` … `}` of a rule or an at-rule, the selector or `@media (…)` its
header. A space between two selectors is the descendant combinator, so it is kept:
`.a .b` and `.a.b` are different anchors. In JSON a block is an object or an array, and
the key it is the value of is its header (`"permissions": [`); an object inside an array
has no header of its own. JSON5 is read by the JavaScript grammar; there an object in an
array takes its first pair for its header (`{ name: "AIPromptAPI",`). `DEPS` and
Starlark (`.star`) are Python by syntax and read as such.

IDL, Mojom, Protocol Buffers, shell, YAML, TOML and plain text have no grammar in hatch:
they are read as text. A block is a pair of `()`, `[]` or `{}` that balances outside the
format's strings and comments, headed by what stands before its opener (`interface X {`,
`message M {`, `f() {`); `if … fi` in shell and the indentation of YAML are no blocks. In
shell, YAML and text the indentation of a line is kept, as in Python. A file of none of
these extensions is picked by name: `--language shell`, `--language text`.

### Adding a language: the one-folder rule

**A language is one folder under `src/lang/` and one `index.ts` inside it, holding
all of its rules — the grammar to load, the extensions it claims, how nesting is
balanced (`blockOf`) and how literal text is canonicalized (`normalize`). Rules are
never lifted out into a module shared between languages, not even when two
languages would spell them identically.**

What that buys: to add a language you copy one folder and edit one file, knowing
nothing about the others and touching none of them. The apparent duplication is
the price, and it is deliberate — the rules do diverge in practice (the bracket
pairs of C, Go, JavaScript and Python already differ, and Kotlin needs its own
notion of where a block's header starts). A shared "C-like rules" module would
turn every one of those into a flag.

Only language-*neutral* machinery is common — grammar loading, tree walking,
canonicalization plumbing, map building — because a language does not get to
choose it. The one shared file an addition touches is the adapter registry, and
only because that whitelist has to be a static list: a language name arrives from
an untrusted `.hatch`, so it must never become a dynamic import.

Nothing in `src/core/` changes either; that is the other test of the boundary, and
none of the languages above needed an exception. Python is the odd one out among
them — significant indentation, so its own canonicalizer and its own notion of a
block, where the opening token is the colon.

Grammars live in `grammars/*.wasm`, put there from the official tree-sitter npm packages
by `npm run grammars`, and ship inside the package.

## Project layout

```
src/
├── bin/        the only files that run anything: hatch (CLI), service, hatch-apply
├── core/       Hatch semantics — no knowledge of brackets, indents or tree-sitter
├── lang/       everything language-dependent: structure (tree-sitter) + normalization
├── generate/   diff → segments → hunks → .hatch
├── cli/        flags, questions, git coordinates, writing the result
├── service/    the JSON-lines wire: protocol types, request decoding, methods
├── infra/      disk, git, config, project layout, grammars, logging
└── index.ts    the public API of the package
```

| directory / file | what lives there |
|---|---|
| `src/bin/` | `hatch.ts`, `service.ts`, `hatch-apply.ts` — each only calls a `main`; no other module does anything when imported |
| `src/core/` | the format and its semantics: `header.ts` (the `.hatch` header, one table of fields), `hatch-parser.ts` / `hatch-printer.ts`, `matcher.ts` (search with backtracking), `patcher.ts` (one edit per hunk), `apply.ts`, `resolve.ts` (where each hunk landed), `eol.ts`, `errors.ts` (each error carries its exit code) |
| `src/lang/` | `source-map.ts` — the **only** bridge to `core/`; `canon.ts`, `build-map.ts`, `block-spans.ts`, `treesitter.ts`, `zones.ts` as shared machinery; `adapter.ts` as a closed name → adapter registry; then **one folder per language** (`cpp/`, `python/`, …), each self-contained: grammar pin, extensions, `normalize`, `blockOf` |
| `src/generate/` | `diff.ts` (atomic change segments), `synth.ts` (candidate patterns, cheapest first, each verified by applying it), `steer.ts` (synthesis a person drives), `draft.ts` (the hunk to start a change from, and the draft a run hands over when it cannot anchor one — the editor's, `SynthesisError`'s), `printer.ts`, `limits.ts`, `pipeline.ts` (the whole of `generate` in one call, on text) |
| `src/cli/` | `index.ts` (the command map), `command.ts` (one frame: args, `--help`, log, exit), `args.ts` (hand-written parsing, no commander), `apply.ts` / `generate.ts` / `init.ts`, `git-source.ts` (the git flags, one spelling for every command), `confirm.ts`, `prompt.ts`, `editor.ts` |
| `src/service/` | `protocol.ts` (the wire contract, written out field by field), `request.ts` (a line decoded before any of it is used), `handler.ts` (methods in a Map), `settings.ts`, `index.ts` (`serve`) |
| `src/infra/` | `fs.ts` (the file-system rules: atomic write, the walk up, path containment), `git.ts`, `config/`, `project.ts` (whose a file is), `pair.ts` (code ↔ patch, both ways), `out-path.ts`, `grammar-store.ts`, `runtime.ts`, `version.ts`, `log.ts` (facts → text) |
| `grammars/` | the pinned `.wasm` grammars — not in git, but in the package; put there by `scripts/fetch-grammars.ts` |
| `scripts/` | `fetch-grammars.ts` (grammars by their pins, development only), `build-apply-bin.mjs` (`hatch-apply`: esbuild → one CJS file → Node SEA) |
| `schemas/`, `hatch.config.schema.json` | the config schema of every version in the range, and the newest one for SchemaStore |
| `test/` | `unit/` per module (plus `versioning`, `protocol-types`, `hygiene`), `roundtrip/`, `golden/<language>/{apply,generate}` — apply goldens also run through every `hatch-apply` binary |

Why the boundaries fall where they do — and the one principle the whole design turns on —
is [ARCHITECTURE.md](./ARCHITECTURE.md).

## Build & run

Sources are `.ts` and run directly on **Node 22+** via type-stripping, so development
needs no build step. The published package is built (`npm run build` → `dist/`), and
that build is what `npm pack` puts in the tarball.

```bash
npm test          # unit, round-trip and golden suites
npm run typecheck # tsc --noEmit over src/, test/ and bench/
npm run check     # both
npm run build     # dist/, for the package only
```

Structure analysis uses **tree-sitter** via `web-tree-sitter` (WASM grammars —
cross-platform, no native build); these load once at startup. See
[CONTRIBUTING.md](./CONTRIBUTING.md) for the development workflow and the
reasoning behind the strict tsconfig.
