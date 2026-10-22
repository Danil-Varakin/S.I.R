# The service protocol

sir can run as a long-lived process that speaks JSON over stdio. It is the same core
as the CLI — generate, resolve, apply — behind a different door: text in, coordinates
out. It is what the VS Code extension talks to, and anything else can talk to it too.

The contract below is binding and versioned: [VERSIONING.md](./VERSIONING.md) §2 says
when the protocol number moves and what a client may rely on. The TypeScript types are
in `src/service/protocol.ts`, published as `sir/protocol`.

## Why a service and not the CLI

- **Unsaved text.** The CLI reads files; an editor has a buffer that is not on disk.
  The service takes text and writes no files.
- **Coordinates, not text.** The CLI prints a `.sirp`. An editor needs offsets — where
  each hunk lands — to jump between patch and file, underline, and show CodeLens.
- **One grammar load.** Grammars load once per process; a live process pays once.
- **Progress.** Synthesis reports progress as messages, not as lines in stderr.

## Starting it

```bash
node node_modules/sir/dist/bin/service.js
```

From a clone: `npm run service`. From code: `import { serve } from 'sir/service'`,
which takes an input and an output stream. The grammars ship inside sir: nothing is
downloaded.

## Transport

- One JSON object per line, UTF-8, both ways. Line breaks inside strings are escaped
  by JSON, so a patch body never breaks a line. A line ends at `\n` alone (a `\r` before
  it is dropped): U+2028 and U+2029, which JSON leaves unescaped inside a string, are
  text, never the end of a line (protocol 4).
- **stdout carries the protocol and nothing else.** Diagnostics (grammar loading and
  the like) go to stderr.
- Every request is answered **when it is done, not in the order it came** (protocol 4).
  Match replies to requests by `id`. `generate`
  hands the service back after each change, so a `pair` or a `config` sent while it
  runs is answered first.
- **To cancel**, send `cancel` with the request's `id` (protocol 4, below): `generate`
  stops before its next change. Killing the process still works; the next start pays
  one grammar load.
- Every reply carries `elapsedMs`: how long the request took, from its arrival to the
  reply, in whole milliseconds (protocol 4) — for a client's log and its "slow" hint.
- A line that is not JSON gets an error reply with `id: 0`. Empty lines are skipped.
  A request whose `id` is not a number is answered with `id: 0`. A line that is JSON
  but not a request object — `null`, `42`, an array — is a `BadRequest` with `id: 0`
  (protocol 4); the service goes on with the next line.

```jsonc
{ "id": 1, "method": "generate", "params": { … } }                        // request
{ "id": 1, "ok": true,  "result": { … }, "elapsedMs": 41 }                // reply
{ "id": 1, "ok": false, "error": { … }, "elapsedMs": 3 }                  // the CALL failed
{ "method": "progress", "params": { "id": 1, "done": 3, "total": 12 } }   // notification
```

## Two levels of failure

A client must tell them apart:

| where | what it looks like | for example |
|---|---|---|
| **the call failed** | `ok: false`, `error` instead of `result` | the `.sirp` does not parse, the language is unknown, the grammar is missing |
| **one hunk did not land** | `ok: true`, that hunk's `status` is not `ok` | an anchor not found, a pattern that fits twice |

The second is normal, not a crash: hunk 2 failing says nothing about hunk 1, and the
other hunks are resolved as usual. `apply` still returns `text` — with the hunks that
landed.

### The error object

| field | |
|---|---|
| `kind` | `BadRequest` for a malformed request — not an object, an unknown method, no params, a param of the wrong type (`params.path must be a string (got number)`; values a config checks — `exact`, `bridgeGap`, `out`, the keys of `limits` — answer `ConfigError`, as the config would); `Cancelled` for a request taken back with `cancel`; otherwise the error class: `ParseError`, `MatchError`, `AmbiguityError`, `ConfigError`, `GrammarError`, `LanguageError`, `GitError`, `PathError`, `NoChanges`, `SynthesisError`; anything unexpected keeps its own name |
| `message` | a human sentence, English. It names no CLI flag (protocol 4): `nope: no such branch …`, where the CLI says `--branch nope: no such branch …` |
| `exitCode` | what the CLI would exit with for the same failure |
| `detail` | machine fields, present when the kind has any (below) |

| kind | `detail` |
|---|---|
| `ParseError` | `mdLine`, `hint?` |
| `MatchError` | `failedStepIndex`, `totalSteps?`, `origPos?`, `anchorText?`; `hunk`, `mdLine` for a hunk of `generate`'s `keep` that does not land (protocol 5) |
| `AmbiguityError` | `positions`; `hunk`, `mdLine` as for `MatchError` (protocol 5) |
| `PathError` | `path`, `blocker` |
| `LanguageError` | `language?`, `extension?` |
| `GitError` | `reason` (protocol 4) — `no-such-file` (not in that revision: deleted or renamed upstream), `not-a-file` (a directory there), `no-such-branch` (no fetch yet?), `not-a-branch` (a tag or a sha named as the branch), `no-such-commit`, `not-on-branch` (the commit is not on the branch named beside it), `no-commits` (the repository has none), `no-repository`, `outside-repository` (the path leaves the repository), `bad-coordinate` (a value starting with `-`), `no-git` (git cannot be run); `revision?`. The list is part of the contract |
| `GrammarError` | `grammar?` |
| `ConfigError` | `file?`; `version`, `keys` for keys outside a schema (`configTemplate`) |
| `NoChanges` | `baseSpec` — what the base was, `null` for text (protocol 4) |
| `SynthesisError` | `reason` — `no-match` (no pattern fitted — or none could be built around the change), `ambiguous` (the last pattern tried fitted in more than one place) or `unreproduced` (the hunks do not give `newText`: a fault of synthesis); `newLine?` — the line of `newText` the change starts on, from 1 (protocol 4); for `no-match` and `ambiguous`, the draft to write the change by hand (protocol 5): `draft` — the `.sirp` to finish and send back as `generate`'s `keep`, `draftHunk` — its last hunk, the one to write, from 1, `draftLine` — the line of that hunk's `# match` in `draft`, `change` — `{ line, removed, added }`: its line in the text the hunks so far make of the base, the lines it takes out and puts in |

## Versions: a range on each side

The first call is `version`. It announces a **range**: `protocol` is the newest
protocol this sir speaks, `protocolMin` the oldest client contract it still serves
unchanged. A client declares its own range `[a, b]` — `b` the newest protocol it was
written and tested against, `a` the oldest it still works with — and:

- they are compatible when `a ≤ protocol` and `protocolMin ≤ b`;
- the client then works at `min(protocol, b)` and uses nothing newer;
- a mismatch names the side to update: `protocol < a` — update sir;
  `protocolMin > b` — update the client;
- **never compare protocol numbers for equality.** That breaks every client on every
  release, compatible or not.

A server that sends no `protocolMin` (protocol 2) is read as `protocolMin = protocol`.
Every change to this contract raises `protocol`, once per release; a change an existing
client can trip over raises `protocolMin` with it. A client must ignore fields it does
not know — a new field is how most changes arrive.

## Methods

Params shared by methods that look at a language:

| param | |
|---|---|
| `language` | a language name — any of `version().languages` |
| `path` | the file this is about, **absolute**: the service has no meaningful current directory. Gives the language by extension when neither `language` nor the `.sirp` heading names one, and anchors `baseGit` and the config search |
| `allowDownload` | accepted and ignored (protocol 4): the grammars ship inside sir, nothing is downloaded |

The language is taken from `language`, else the `# match` heading of the `.sirp`
(`resolve`, `apply`), else the extension of `path`. An empty `language` is the same as
none.

### The base: sent as text, or named in git

`generate`, `resolve` and `apply` each work from one version of the file — the OLD one
for `generate`, the one to patch for `resolve`/`apply`. Send **exactly one** of:

- `baseText` — the text;
- `baseGit` — `{ branch?, commit?, repoPath?, eol? }`: the same three coordinates as
  the CLI's `--branch`, `--commit`, `--repo-path`, and how the text comes back. What is
  left out takes its default:

  | field | left out means |
  |---|---|
  | `branch` | the branch the repository is on |
  | `commit` | the last commit of that branch |
  | `repoPath` | the path of `path` inside the repository; a relative one counts from the repository root |
  | `eol` | `"repository"`: the line endings git stores. `"worktree"` (protocol 4): those of the file at `path` on disk, read off its first line — no file there, or one without a line break, leaves the text as stored |

  `baseGit: {}` is "this same file, as of the last commit here". It needs `path`: the
  repository is found from it. A field outside the three is refused by name, and so is
  an empty one; a `branch` or `commit` that starts with `-` is refused too — git would
  read it as an option. `branch` must be a branch, local or remote-tracking — also when
  a tag shares its name. A `commit` alone is taken as given; beside a `branch` it must
  be one that branch holds.

  The base out of git has the line endings the repository stores, unless `eol` says
  `"worktree"`. In a repository with `core.autocrlf=true` the repository stores LF while
  the file on disk has CRLF: send `eol: "worktree"` (or `baseText`), or offsets and
  `apply`'s `text` are in LF, and `generate` with `exact` sees every line as changed.
  The conversion is sir's own, the same rule a patch lands by: the endings of the
  file. Git's filters (`.gitattributes`, smudge) are not run.

`generate`, `resolve` and `apply` may send neither (protocol 4) when they send a `path`:
then the base is the one the project's config names in `generate.base` — `{ head?,
branch?, commit?, eol? }`, read as `baseGit` with those fields. With no `generate.base`
either, the request is refused. `resolve`/`apply` read the config for the base only
then: a request that sends its base does not depend on the config.

**Nothing is asked over a pipe.** Where the CLI asks before going on (a commit off the
named branch, a tag given as the branch), there is no one to answer, so the service
answers no and replies with a `GitError` carrying the same message. A client that wants
to ask its user shows that message and, on a yes, sends a request that does not
contradict itself — the commit without the branch, say.

Every result that read a base says what it read: `baseSpec` is `<revision>:<path>` for
a base out of git, `null` for one sent as text.

### `version`

No params.

```jsonc
{ "sir": "0.5.0", "protocol": 5, "protocolMin": 5,
  "configSchema": 3, "configSchemaMin": 3, "languages": ["cpp", "c++", …] }
```

`configSchema`/`configSchemaMin` is the range of `sir.config.json` versions this
sir reads. `languages` is every name `language` and the `# match` heading accept,
each file extension without its dot included (`mm`, `pyi`).

### `generate`

The `.sirp` that turns the base into `newText`.

| param | |
|---|---|
| `newText` | the new version — typically the unsaved buffer. Required |
| the base | `baseText` or `baseGit`, above |
| `language`, `path`, `allowDownload` | above |
| `exact` | reproduce `newText` byte for byte, not only after normalization |
| `bridgeGap` | join edits separated by at most this many unchanged lines into one hunk |
| `limits` | anchoring limits: `minParents`, `maxParents` (a number or `"all"`), `parentDetailBase`, `minSiblings`, `maxSiblings`, `siblingDetailBase`, `parentsRequired` |
| `out` | where the `.sirp` belongs, as `generate.out` — only reported back, nothing is written |
| `configPath` | absolute: the config to use, no search — for a project beside its upstream (protocol 4) |
| `keep` | a `.sirp` whose hunks are settled — typically `SynthesisError`'s `detail.draft`, finished by hand (below). Not a config setting (protocol 5) |

**The config** (protocol 4). With `configPath` that file. Else, with a `path` to a file
of code: `sir.config.json` upward from the file's directory to its repository root;
else a config that **claims** the file — its `upstream` holds it — in the immediate
subdirectories of every repository root on the way up (`work/*/sir.config.json`: a
project inside its upstream) and in the directories above the repository (an upstream inside the
project); else `$SIR_CONFIG` of the service's environment. Two claims are a
`ConfigError` that names both. A `.sirp` finds its config upward from itself. The
search never enters the home directory. Params override the config the way flags
override it in the CLI. Without a `path` or `configPath` no config file is read.

**The upstream.** A config with `"upstream"` names the root of the code the project
patches, from the config file. The patch of a file is then
`<config dir>/<generate.out>/<path from the upstream>.sirp` and its `Target` is that
path; a file outside the upstream has no patch (`ConfigError`).

| result | |
|---|---|
| `patch` | the `.sirp`. Its heading names the language by its own name (`# match cpp`). It opens with the header (below) |
| `language` | that name |
| `baseSpec` | what the base was |
| `warnings` | e.g. a patch line whose trailing whitespace is significant |
| `warningsAt` | the warnings about one hunk, each `{ hunk, mdLine, message }`: the hunk (from 1), the line of `patch` (from 1), the same sentence as in `warnings` (protocol 4) |
| `hunks` | the link table (below), resolved against the base |
| `reproducesNew` | `false` when applying `patch` to the base does not give `newText` byte for byte — reported, not hidden |
| `outPath` | where the CLI would write this `.sirp`, or `null` without a `path` |
| `outExists` | a file is at `outPath` already (protocol 4) |
| `outTarget` | the `Target` that file names, or `null`. When it is not this file's, the CLI would ask before writing over another file's patch — a client asks too (protocol 4) |
| `config` | `{ file, settings, origins }`: the config file used (or `null`), every setting, and where each came from |

While it works, `generate` sends `progress` notifications: `done` of `total`, where
`total` is known before synthesis starts.

**No changes** (protocol 4). When `newText` is the base — line for line as the language
normalizes it, blank lines not counted; with `exact`, byte for byte — there is no `.sirp`
to write, and the call fails with `NoChanges` (`exitCode` 7, `detail.baseSpec`). It is
the first thing `generate` checks, for a base sent as text and out of git alike.

**A change it cannot anchor** (protocol 4). When no pattern made of the text around a
change lands there and only there, the call fails with `SynthesisError` (`exitCode` 8,
`detail.reason`, `detail.newLine`).

**Writing that hunk by hand** (protocol 5) — the CLI's editor round trip, with no
session: all the state is in the text that goes back and forth. The `SynthesisError`
carries `detail.draft`, the `.sirp` the CLI would hand the editor, without the comment
lines the CLI puts on top: the header `generate` writes, every hunk so far, and last a hunk to start the change from —
the change with the lines above it, most likely ambiguous as it stands; laid as it is,
it makes the change, blank lines between it and those lines included. `draftHunk` and
`draftLine` say where that hunk is; `change` is the change itself, for the client to
show. The client lets the person finish the draft — any hunk of it, pattern and body —
and sends the result back as `keep`, with the same base and `newText`:

1. `keep` is checked as the CLI checks an edit: it parses (else `ParseError`, `mdLine` in
   `keep`), its heading is the language's (else `LanguageError`), and every hunk lands on
   the base, in order — else the error of the first that does not (`MatchError`,
   `AmbiguityError`), its message opening `hunk N (line L) does not land:`, and
   `detail.hunk`, `detail.mdLine` in `keep`.
2. Its hunks are settled: what they wrote is not offered again. Synthesis goes on with
   the changes still between the text they make and `newText`.
3. The next change it cannot anchor is a `SynthesisError` again, its `draft` holding the
   hunks of `keep` as they were written — and the client goes round once more.
4. Otherwise the result is the patch: the hunks of `keep` first, byte for byte as sent,
   `# note` included, then the hunks synthesized after them. A body written to differ
   from `newText` stays: `reproducesNew` is `false`, and `warnings` says so.

The header of `keep` is not kept: `patch` opens with the header `generate` writes now.
`cancel` stops the run between two changes, as without `keep`.

**The header** (protocol 4; `Base-Blob`, `Sir-Version`: protocol 5). `patch` is a
`.sirp`, and starts with

```
Sir: 2
Target: src/a.cc
Base-Blob: 3b18e512dba79e4c8300dd08aeb37f8e728b8dad
Sir-Version: 0.5.0
Grammar: tree-sitter-cpp@0.23.4

# match cpp
```

`Sir` is the format number, always first. `Target` is the file the patch is for,
relative with `/`, measured from the repository root around the patch (at `outPath`),
outside a repository from the patch's directory; without a `path`, or when the file is
not under that root, there is none. `Base-Blob` is the id of the git blob the base was
read from, only for a base out of git. `Sir-Version` (the bare version) and `Grammar`
are always there. `mdSpan` and `mdLine` count the header lines. `pair` reads `Target` back. A
reader ignores fields it does not know.

### `resolve`

Where the hunks of a `.sirp` land — without the text.

| param | |
|---|---|
| `path` | absolute: the file of code — or **the `.sirp` itself** (protocol 4): then its text is read from it unless `patch` is sent, the code is the file its `Target` names (as `pair`), and the config is the patch's own |
| `patch` | the `.sirp`. Required unless `path` is the patch |
| the base | `baseText` or `baseGit`; neither — `generate.base` of the config |
| `configPath` | absolute: the config to use, no search (protocol 4) |
| `language`, `allowDownload` | needed only when the heading names no language |

```jsonc
{ "method": "resolve", "params": { "path": "/work/myfork/patches/src/ui/window.cc.sirp" } }
→ { "hunks": [ … ], "baseSpec": "HEAD:src/ui/window.cc", "baseText": "…",
    "code": "/work/src/ui/window.cc",
    "header": { "format": 2, "target": "src/ui/window.cc",
                "baseBlob": "3b18…", "sirVersion": "0.5.0", "grammar": "tree-sitter-cpp@0.23.4" },
    "warningsAt": [] }
```

Result: `hunks` (below), `baseSpec`, and — when the base came out of git, named or from
the config — `baseText`: the text the `base` offsets count in, with the line endings
`eol` gave it (protocol 4). A base sent as text is the client's own, and is not sent
back. Protocol 4 adds:

| field | |
|---|---|
| `code` | the file the patch was laid on, absolute — `path`, or the file `Target` names; `null` without a `path` |
| `header` | the patch's header as read: `format`, and `target`, `baseBlob`, `sirVersion`, `grammar` when present (`baseBlob`, `sirVersion`: protocol 5). A patch with no header is `{ "format": 2 }` |
| `warningsAt` | as in `generate`, computed on the patch as it is now — a patch edited by hand keeps its marks; headings spelled `## patch:` are found as well |

A `path` to a patch that names no file (no `Target`, and no place in the layout to undo)
is a `BadRequest` that says why (`pair`'s `reason`). **One call per `.sirp`**, not per hunk: hunks are
replayed in order, hunk *k* matched against the text in which hunks 1..*k*−1 already
landed.

### `apply`

What `resolve` returns, plus `text` — the base with the hunks applied. A separate
method only so that `resolve`, called often, does not send the whole file back each
time.

A patch takes the line endings of the base: in a CRLF base every line it writes ends in
CRLF (protocol 3).

### `configTemplate`

The text of a new `sir.config.json` (protocol 4). The service writes nothing: asking
the user, writing the file, overwriting one that is there and trusting the workspace
are the client's.

| param | |
|---|---|
| `path` | **absolute**, required — a file or the workspace folder; the repository root is found from it |
| `version` | the config schema to write, within `configSchemaMin..configSchema`; the newest when left out |
| `settings` | initial values in the paths of the config, nested (`{"generate": {"out": "patches/"}}`) or dotted (`{"generate.out": "patches/"}`); checked as the loader checks a file |

```jsonc
{ "text": "{\n  \"$schema\": \"…/schemas/sir.config.v3.schema.json\",\n  \"version\": 3\n}\n",
  "version": 3,
  "suggestedPath": "/work/repo/sir.config.json",
  "exists": false,
  "versions": [{ "version": 3, "summary": "v3: upstream; generate: out, language, …" }] }
```

`text` holds `$schema`, `version`, then only the settings sent, in schema order: a
default is never written out, so a later change of it reaches the project. The core
reads `text` back to exactly `settings`. `suggestedPath` is where the core itself looks
from `path`: the repository root, outside a repository the directory of `path`.

Errors: `BadRequest` for a missing or relative `path`, a `version` that is not a number,
`settings` that is not an object. `ConfigError` for a version outside the range (the
message names the side: newer — update sir; older — move the file to the current
schema), a value the loader refuses, and keys outside the chosen schema — all of them
in one error, with `detail`:

```jsonc
{ "version": 3, "keys": [{ "path": "generate.x", "since": null, "until": null }] }
```

`since`/`until` are the schemas a key belongs to; `since: null` — no schema has it.

### `config`

The settings `generate` would apply, and where its base would come from — without
generating (protocol 4). Nothing is written and nothing is watched.

| param | |
|---|---|
| `path` | **absolute**, required — a file of code, or a `.sirp` (then `base` is that of the file `pair` names for it) |
| `configPath` | absolute: the config to use, no search — the same as `overrides.configPath`; both, and they must agree (protocol 4) |
| `overrides` | what the request would set over the config — `generate`'s own params `language`, `exact`, `bridgeGap`, `limits`, `out`, `configPath`, and its base: `baseGit`, or `base: "text"` for "the client sends `baseText`" |

`config` with a `path` and `overrides` answers exactly what `generate` with that `path`
and those params applies: the same code reads both.

```jsonc
{ "file": "/work/repo/sir.config.json",   // or null
  "schemaVersion": 2,                        // the file's "version"; null without a file
  "settings": { … },  "origins": { … },      // as `config` in generate's result
  "repoRoot": "/work/repo",                  // or null outside a repository
  "projectRoot": "/work/repo",               // the config's directory; or null
  "upstreamRoot": null,                      // the config's upstream, absolute; or null
  "target": "src/a.cc",                      // the pair's Target; or null
  "language": "cpp",                         // the word of `# match`; or null (protocol 5)
  "header": "Sir: 2\nTarget: src/a.cc\nBase-Blob: 9d2b…41\nSir-Version: 0.5.0\nGrammar: tree-sitter-cpp@0.23.4\n\n",
                                             // the header generate would write; or null (protocol 5)
  "base": { "kind": "git", "spec": "HEAD:src/a.cc",
            "sha": "4f1c…e2", "eol": "worktree" },
  "watch": ["/work/repo/src/sir.config.json", "/work/repo/sir.config.json",
            "/work/repo/.git/HEAD", "/work/repo/.git/packed-refs",
            "/work/repo/.git/refs/heads/main"] }
```

| field | |
|---|---|
| `target` | the `Target` of the pair: what the patch of this file would name — or, for a `.sirp`, what it names; `null` when there is none (outside the upstream, no place) |
| `language` | the language `generate` would name in `# match` for this file — its own name, picked as `generate` picks it: `overrides.language`, else the config's `generate.language`, else the extension (`cpp` for `.cc`, `objc` for `.mm`); for a `.sirp`, that of the file `pair` names for it. No grammar is loaded. `null` when none is picked — an extension no language has, a name no language answers to, a `.sirp` with no pair; `config` does not fail for it (protocol 5) |
| `header` | the header `generate` would write for this file now, with the same `overrides` — the same code, its blank line after it, ready to open a patch written by hand: `Sir`, then `Target` (as `target`), `Base-Blob` (the git blob of the file in the base revision), `Sir-Version`, `Grammar` (the grammar of `language`). A field with no value is left out, not an error: no `Base-Blob` when the base is text, none, or `unavailable`; no `Grammar` when `language` is `null`; no `Target` when `target` is `null`. For a `.sirp`, the header of the file `pair` names for it; `null` when there is none. The blob is named by git, not read; no grammar is loaded. A client writes it as it comes and keeps no list of fields of its own (protocol 5) |
| `base` | `{ "kind": "text" }` — the client sends it; `{ "kind": "git", spec, sha, eol }` — the revision resolved now: `spec` as `baseSpec`, `sha` the full hash of the commit; `{ "kind": "unavailable", error }` — a git base is named but cannot be read now (the file is not in that revision yet, no such branch): `error` is what `generate` would fail with, as an error object; `null` — `generate` would refuse for want of a base |
| `watch` | absolute paths whose change may change this answer: every place from `path`'s directory up where a `sir.config.json` would be found — up to the one found, else to the repository root — and the config found by its claim, then, for a git base, `HEAD`, `packed-refs` and the ref the revision goes through, where git keeps them (a linked worktree has its own `HEAD` and shares the refs) |

Errors: `BadRequest` for a missing or relative `path`, `overrides` that is not an
object, a `base` other than `"text"`, both `base` and `baseGit`. `ConfigError` as
`generate` gets it from the config (C5: the side to update). A git base that cannot be
resolved is no error of `config`: it answers `base: { "kind": "unavailable" }`, and
`watch` still names `HEAD` and the branch it is on — the next commit may change the
answer.

### `pair`

A file of code and its `.sirp`, either way (protocol 4). Forward is the very function
`generate` names `outPath` with.

| param | |
|---|---|
| `path` | **absolute**, required. A path ending in `.sirp` is a patch; anything else is code |
| `patch` | the `.sirp`'s text when the client has it unsaved; else it is read from `path` |
| `configPath` | absolute: the config to use, no search (protocol 4) |
| `overrides` | as for `config`; only `out` and `configPath` matter |

For code:

```jsonc
{ "kind": "code", "patchPath": "/work/repo/patches/src/a.cc.sirp", "exists": true, "how": "upstream" }
```

For a `.sirp` — the header's `Target` first (from the upstream root, else from the
repository around the patch), then the layout of `generate.out` and `upstream`, checked
forward (only a file `generate` would write this `.sirp` for is its code):

```jsonc
{ "kind": "patch", "code": "/work/repo/src/a.cc", "exists": true, "how": "target" }
```

`how`: `target`, `upstream` (the patch tree of a project with an upstream), `beside`
(next to the file), `out` (a directory or file named in `generate.out`). When no pair
can be named the answer is a fact, not an error: `patchPath`/`code` `null`, `how`
`null`, and `reason`:

| `reason` | |
|---|---|
| `no-out` | `generate.out` is `-`: the `.sirp` goes to stdout, it has no place |
| `outside-upstream` | the file is outside the project's upstream: it has no patch |
| `flat-out` | a `.sirp` in a directory `out` names without an upstream: where its file was is not kept |
| `outside-out` | with an upstream, the `.sirp` is not under `<config dir>/<out>` |
| `not-a-patch-name` | the `.sirp`'s name is not `<file>.sirp` beside its file |
| `unsafe-target` | `Target` leaves its root: a `..` step, an absolute path, a drive or UNC path — data from a file that may have come with somebody else's repository |
| `two-patches` | one file, two patches: the one at its place and one beside the file; both in `patchPaths` |
| `newer-format` | the `.sirp` is of a format newer than this sir reads: update sir (protocol 4) |
| `older-format` | older than this sir still reads: regenerate the patch (protocol 4) |
| `bad-header` | the header does not read: a line that is not `Name: value`, a field twice or out of its place, `Sir` not a number (protocol 4) |

The list is part of the contract: a new reason is a new protocol number.

### `cancel`

Takes back a request still running (protocol 4).

| param | |
|---|---|
| `id` | the `id` of that request. Required, a number |

```jsonc
{ "id": 7, "method": "cancel", "params": { "id": 3 } }
{ "id": 7, "ok": true, "result": { "cancelled": true } }
{ "id": 3, "ok": false, "error": { "kind": "Cancelled", "message": "request 3 was cancelled", "exitCode": 1 } }
```

`cancelled: true` — the request was running and is told to stop. `generate` stops
before its next change — the change under way is finished first — and answers
`Cancelled`; if it had no change left, or was past them, it answers as usual. The other
methods do not stop: they answer as usual. `cancelled: false` — no request with that
`id` is running, finished or never sent; that is no error. `cancel` itself cannot be
cancelled.

## The link table: `hunks`

One entry per hunk, in the order of the `.sirp` — which is also the order they apply in.

| field | |
|---|---|
| `index` | the hunk's position in the `.sirp`; the key a client ties its CodeLens, underline and own table to |
| `status` | `ok` · `no-match` · `ambiguous` · `error` |
| `mdSpan` | `[from, to]`, lines of the `.sirp` from `# match` to the closing `# end`, counted from 1 |
| `note` | the text of the hunk's `# note` block, edge blank lines trimmed; absent when it has none (protocol 4) |
| `noteSpan` | `[from, to]`, lines of the `.sirp` from `# note` to its `# end`; with `note` only (protocol 4) |
| `base` | `{ start, end }` — what the hunk REPLACES, in base coordinates; `start === end` is an insertion |
| `final` | `{ start, end }` — what the hunk WRITES, in coordinates of the applied text |
| `finalText` | the text at `final`, so a client can compare it with its buffer without a second call |
| `dependsOnEarlier` | the pattern does not match the clean base and lands only after earlier hunks |
| `failure` | when `status` is not `ok`: the machine fields of the failure |

**Offsets are UTF-16 code units** (JavaScript string indices), not bytes — what
`String.slice` counts and what VS Code's `positionAt` takes. Do not mix them with
`Buffer.byteLength`.

`base` and `final` are two projections, not one number told twice: hunk *k* matches in
a text where the earlier hunks have landed, a stage no open editor shows. `resolve`
carries each edit back through the earlier ones and forward through the later ones.
A hunk with `dependsOnEarlier` has no place of its own in the base: its `base` is the
point an earlier hunk writes to. A client should not offer a jump into the base for
it, but name the hunk it depends on; its `final` is exact.

`failure`:

| field | |
|---|---|
| `kind` | `MatchError`, `AmbiguityError`, or the error's class |
| `message` | the human sentence |
| `mdLine` | the `.sirp` line of the anchor that did not match — **where to underline** |
| `failedStepIndex`, `totalSteps` | "anchor 3 of 5 not found" |
| `origPos` | how far the pattern got before it gave up, in base coordinates |
| `anchorText` | the anchor that did not match |
| `candidates` | for `ambiguous`: every place the pattern fits, in base coordinates |

## Not in the replies, on purpose

- **File contents it was not asked for.** The service takes text and returns
  coordinates. Paths it does answer — `outPath`, `config`, `pair` — are advice: nothing
  is written, nothing is watched.
- **The `.sirp` in a `resolve` reply.** The client has it.
- **Positions of individual anchors.** The matcher reports the insertion point and the
  end of the replacement; on failure `failedStepIndex` and `origPos` are enough.

## Protocol versions

Each number, what it added and what a client written for it can count on. The
compatibility table is in [VERSIONING.md](./VERSIONING.md) §6. Protocols 1–4 are those of
hatch, the name of the project until 0.5, and are described as they shipped.

### Protocol 1

Never released. It lived inside `dev` only and named two contracts — a relative `path`
accepted, then refused — which is why every change now raises the number.

### Protocol 2

hatch 0.2.0. `version`, `generate`, `resolve`, `apply`, `progress`. `generate` takes
`baseText` or `baseGit` and answers `baseSpec`; `resolve`/`apply` take `baseText`.
`params.path` must be absolute.

### Protocol 3

hatch 0.3.0; `protocolMin` 2 — a client written for protocol 2 works unchanged.

- `resolve` and `apply` take `baseGit` as `generate` does, and answer `baseSpec`.
- `version` announces `protocolMin` and `configSchemaMin`.
- `languages` includes every file extension without its dot.
- `generate` writes the language's own name into `# match`, however the language was
  named.
- `baseGit.branch` finds a branch that shares its name with a tag; a `branch` or
  `commit` starting with `-` is refused with a `GitError` that says why (it was refused
  before as well, with a message about something else).
- An empty `language` is the same as none, in `generate` as in `resolve`/`apply`
  (`generate` used to answer a `ConfigError`).
- In a CRLF base, `resolve`/`apply` write patch lines with CRLF. A fix: the old mixed
  line endings were the bug.

### Protocol 4

`protocolMin` 4 — a client written for protocol 2 or 3 is refused: `generate` with no
changes answers a new error kind, `generate` that cannot anchor a change answers
another, and replies no longer come in the order of the requests (R5). Everything else
below is additive.

- `configTemplate`: the text of a new `hatch.config.json` for a schema version and
  initial settings, with `suggestedPath`, `exists` and `versions`.
- A `ConfigError` about config keys outside a schema carries `detail.version` and
  `detail.keys`.
- `generate` that sends neither `baseText` nor `baseGit` takes the base the project's
  config names in `generate.base` (config schema 2) — before, such a request was
  refused. Without `generate.base` it is still refused. `config.settings` in the
  result carries `baseHead`, `baseBranch`, `baseCommit`; a base sent in the request
  replaces the config's whole, and `config.origins` names the param.
- `config`: the settings `generate` would apply, the schema version of the config file,
  the repository root, the base resolved (`spec`, `sha`, `eol`) and the paths to watch.
- `pair`: a file of code and its `.hatch`, either way; `reason` when there is none.
- The project and its upstream: the config search claims a file for the config whose
  `upstream` holds it; `configPath` names one outright; `pair` answers `how: "upstream"`,
  the reasons `outside-upstream` and `two-patches` (with `patchPaths`); `generate`
  answers `outExists`, `outTarget`; `config` answers `upstreamRoot`. The param `mirror`
  and `how: "mirror"` are gone.
- `resolve`/`apply` take the patch's own path: the code by `Target`, the base from the
  patch's config; they answer `code`, `header` and `warningsAt` (X1). `config` answers
  `projectRoot` and `target`; `config` and `pair` take `configPath` beside `overrides`.
- `GitError` carries `detail.reason` (X2); no error message names a CLI flag — the CLI
  puts it in front (X3). Every reply carries `elapsedMs` (X4).
- The field `md` is called `patch` (protocol 4): `generate` answers it, `resolve`, `apply`
  and `pair` take it. In protocols 2–3 it was `md`.
- `generate` answers `patch` as a `.hatch`, header first: `Hatch`, `Target` with a `path`,
  `Generated-From` for a git base, `Generated-By`, `Grammar`. `mdSpan` counts the header
  lines. `pair` takes only `.hatch` for a patch; a `.md` is code.
- `generate` answers `warningsAt` beside `warnings`: `{ hunk, mdLine, message }`.
- `generate` with no changes fails with `NoChanges` (`exitCode` 7, `detail.baseSpec`)
  instead of `ParseError`, checked before synthesis; spacing and blank lines alone are
  no change. **A new error kind for a request that already failed** — R5: the reason
  `protocolMin` is 4.
- `baseGit.eol` (`"repository"` | `"worktree"`) and `generate.base.eol`: the base out
  of git with the line endings of the file on disk. The default is the old behavior.
- `resolve`/`apply` with a `path` and no base take the config's `generate.base` —
  refused before. `resolve` answers `baseText` when the base came out of git.
- A hunk in `hunks` carries `note` and `noteSpan` when the `.hatch` has a `# note` …
  `# end` block right before its `# match`. `mdSpan` still starts at `# match`. A `.hatch`
  with text between hunks outside a note is refused as before — a `ParseError`, now
  with a message that names the note block.
- `generate` that cannot anchor a change fails with `SynthesisError` (`exitCode` 8,
  `detail.reason`, `detail.newLine`) instead of the `MatchError` or `AmbiguityError` of
  the last pattern tried. **A new error kind for a request that already failed** — R5.
- Replies go out when each request is done, not in the order of the requests;
  `generate` hands the service back after every change. **A client that paired replies
  by order trips** — R5. Match them by `id`.
- `cancel { id }`: `generate` stops before its next change and answers the new error
  kind `Cancelled`; `{ cancelled: false }` for an `id` not running.
- `config` answers a git base that cannot be read as `base: { kind: "unavailable",
  error }`, and still watches `HEAD` and the branch.
- A line that is JSON but not a request object is answered with `BadRequest` and `id: 0`
  (it ended the service before). A param of the wrong type is a `BadRequest` naming it,
  not the `TypeError` of the code it reached.
- `pair` tells why a `.hatch` names no file: `newer-format`, `older-format`,
  `bad-header` beside `unsafe-target` (which they all were before).
- `SynthesisError` answers `reason: "no-match"` when no candidate could be built around
  the change (it said `ambiguous`).

### Protocol 5

sir 0.5.0, the project renamed from hatch; `protocolMin` 5 — a client written for
protocol 4 is refused (R5): the patch, its header, the config file and a field of
`version` are named anew, and nothing of protocol 4 is kept beside them.

- `version` answers `sir`, the version of sir, in place of `hatch`; `configSchema`
  and `configSchemaMin` are 3.
- A patch is a `.sirp`. `pair`, `resolve` and `apply` take only a `.sirp` for a patch,
  and `generate` writes one; a `.hatch` is a file of code, as a `.md` was from protocol 4.
- The header is format 2: line 1 is `Sir: 2`, field 4 is `Sir-Version` (the bare
  version, `0.5.0`), field 3 is `Base-Blob` (the git blob of the base). `generate`
  writes `Sir`, `Target`, `Base-Blob`, `Sir-Version`, `Grammar`. A patch of format 1 —
  one that opens with `Hatch: 1` — is refused as older (`ParseError`, hint
  "regenerate the patch"; `pair` reason `older-format`). `Generated-From`,
  `Generated-By` and `Hatch-Version` are fields sir does not know, read past. A file
  with no header is hunks alone, read as format 2.
- `header` in `resolve`/`apply` answers `format`, `target`, `baseBlob`, `sirVersion`,
  `grammar`; `generatedFrom` and `generatedBy` are gone.
- The config is `sir.config.json`, schema 3 (`configSchemaMin` 3): the keys of schema
  2, under a new name. `configTemplate` writes schema 3 and `suggestedPath` names
  `sir.config.json`; a config of schema 1 or 2 is a `ConfigError` that says to move
  the file to v3. A `hatch.config.json` is not read.
- Messages that name the side to update say "update sir".

Everything below is additive within protocol 5.

- `config` answers `language`: the word `generate` writes in `# match` for the same
  `path` and `overrides` (`cpp` for `.cc`), or `null` when no language is picked. A
  client making a patch by hand needs no table of extensions of its own.
- `config` answers `header`: the header `generate` would write for the same `path` and
  `overrides`, blank line included — `Base-Blob` only for a git base that can be read,
  `Grammar` only when a language is picked, `Target` only when there is one; for a
  `.sirp`, its pair's; `null` with no pair. A patch made by hand opens with it.
- `SynthesisError` for `no-match` and `ambiguous` answers `detail.draft`, `draftHunk`,
  `draftLine` and `change`: the `.sirp` to finish by hand and where its hunk to write is.
- `generate` takes `keep`: a `.sirp` of settled hunks — typically that draft, finished.
  Every hunk must land on the base, in order; synthesis goes on from them; they open
  `patch` byte for byte. A hunk that does not land answers its error kind with
  `detail.hunk` and `detail.mdLine`. Without `keep`, `generate` is as in protocol 4.
- `languages` grows by `html` and `htm` (HTML), `xml` and `plist` (XML), `css` (CSS),
  `json` (JSON), `json5` (JSON5) and `star` (Starlark, read as Python): `language`,
  `# match` and the file's extension accept them in every method. A file named `DEPS`,
  with no extension, is Python.
- `languages` grows by formats read as text, with no grammar: `idl` (and `webidl`),
  `mojom`, `proto` (and `protobuf`), `shell` (and `sh`, `bash`), `yaml` (and `yml`),
  `toml`, `text` (and `txt`). A block there is a pair of `()`, `[]` or `{}` that balances
  outside the format's strings and comments. A `.sirp` for such a file has no
  `Grammar` in its header, and `config` answers a `header` without it.
