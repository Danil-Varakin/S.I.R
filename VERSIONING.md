# Versioning

These rules are binding. A change that breaks one is not merged until the rule is
followed or the rule itself is changed here first, in its own commit, with the reason.
`test/unit/versioning.test.ts` checks the parts a machine can check.

sir carries **four independent numbers** and two compatibility surfaces without one:

| what | where it lives | who depends on it |
|---|---|---|
| package version | `package.json`, `package-lock.json`, git tag `vX.Y.Z` | users, the release workflow |
| protocol range | `PROTOCOL_MIN`..`PROTOCOL_VERSION`, `src/service/protocol.ts`; announced by `version`; described in [PROTOCOL.md](./PROTOCOL.md) | service clients (the VS Code extension) |
| config schema range | `CONFIG_MIN`..`CONFIG_VERSION`, `src/infra/config/schema.ts`; `sir.config.schema.json` | `sir.config.json` files committed to projects |
| patch format range | `FORMAT_MIN`..`FORMAT_VERSION`, `src/core/header.ts`; the `Sir:` line of every `.sirp`; `core/sir-parser.ts`, `test/golden/` | every patch anyone has written |
| the CLI | `src/cli/` | scripts and CI jobs |
| `sir-apply` | the release files `sir-apply-X.Y.Z-<os>-<arch>`, `src/bin/sir-apply.ts` | the build scripts of projects |

Protocol, config and patch format are **ranges, never single numbers**: a sir serves
every client and reads every config and every patch from the minimum to the maximum. A
range is what lets an older client, config or patch keep working after the number moves.

## 1. Package version

- **P1.** `X.Y.Z`. The tag is `v` + that version exactly; the release workflow refuses a
  mismatch.
- **P2.** Before 1.0.0: **minor** (`Y`) for any new feature and for any breaking change;
  **patch** (`Z`) only for a fix that changes no documented behavior. From 1.0.0: major
  for breaking, minor for features, patch for fixes.
- **P3.** Breaking, for the package: a CLI flag removed, renamed or given another
  meaning; the same input now refused where it succeeded, or succeeding differently
  (unless the old outcome was a bug); an exit code changed; a `.md` an older release
  wrote no longer applies the same (F1), or `FORMAT_MIN` raised; `PROTOCOL_MIN` or `CONFIG_MIN` raised; an
  export of `src/index.ts` removed or changed; the minimum Node (`engines`) or the
  minimum git raised; a platform dropped from the `sir-apply` files of a release, or
  the name of those files changed (`sir-apply-X.Y.Z-<os>-<arch>`, scripts download
  them by name); a language name or a file extension no longer accepted (a `.sirp`
  headed `# match mm` must keep applying); a grammar pin changed so that an apply golden
  changes (F3).
- **P4.** A release that moves the protocol or config range is at least a minor bump.
- **P5.** The version is raised in a commit of its own, `package.json` and
  `package-lock.json` together — `npm version minor|patch` does both.
- **P6.** Every release has its `CHANGELOG.md` entry before the tag: the four numbers,
  then what changed, breaking changes first.
- **P7.** A version that went out is never re-cut: a pushed tag is not moved, deleted
  and re-pushed, or reused. A mistake is fixed by the next patch release.

## 2. Protocol

The contract is everything a client can observe through `src/service`: methods, every
field of params and results, error kinds and their `detail`, and every validation rule.

- **R1.** The server announces a range in `version`: `protocol` = **N**, the newest it
  speaks; `protocolMin` = **M**, the oldest client contract it still serves unchanged.
  `M ≤ N`, always.
- **R2.** **Every** change to the contract raises N, additions included. Nothing ships
  under a number that already meant something else. *(Why: protocol 1 changed meaning
  inside `dev` with no bump — relative `path` accepted, then refused — so "protocol 1"
  named two contracts.)*
- **R3.** One bump per release. The first protocol change after a release sets
  N = released N + 1; further changes before the next release amend that same N. A
  number is frozen the moment a release ships it.
- **R4. Additive** — an existing client cannot notice it: a new optional param, a new
  result field, a new method, a new `detail` field. N + 1, **M unchanged**.
- **R5. Breaking** — an existing client can trip over it: a field removed or renamed,
  optional made required, a meaning or a default changed, validation made stricter, a
  result field removed. N + 1 **and M = N + 1** — and it is breaking for the package
  too (P3).
- **R6.** Prefer R4 to R5: keep the old behavior reachable and add the new one beside it.
- **R7.** A server that sends no `protocolMin` (protocol 2 and older) is read as M = N.
- **R8. Clients** declare their own range `[a, b]`: `b` the newest protocol the client
  was written and tested against, `a` the oldest it still works with. They are
  compatible iff `a ≤ N` and `M ≤ b`. The client works at `min(N, b)` and does not use
  anything newer. A mismatch names the side to update: `N < a` — update sir;
  `M > b` — update the client.
- **R9.** Equality checks on the protocol number are forbidden on both sides. They break
  every client on every bump, compatible or not.
- **R10.** Every N gets a row in the protocol table below and its section in
  [PROTOCOL.md](./PROTOCOL.md) ("Protocol versions"), which describes the contract as
  it stands. A test holds both.

## 3. Config schema

- **C1.** sir reads every config whose `"version"` is in `[CONFIG_MIN, CONFIG_VERSION]`
  and writes `CONFIG_VERSION`. `sir.config.schema.json` states the same range; a test
  holds the two together.
- **C2.** A new optional key: `CONFIG_VERSION + 1`, `CONFIG_MIN` unchanged. Committed
  configs load as before, and an older sir meeting the new number says "update
  sir" instead of "unknown key".
- **C3.** A key removed or renamed, its meaning or default changed: `CONFIG_MIN` rises
  with it — breaking for the package (P3). Prefer keeping the old key readable.
- **C4.** One bump per release, frozen on release — as R3.
- **C5.** Outside the range the message names the side: newer — update sir; older —
  move the file to the current schema.
- **C6.** Every `generate` option the core supports has a config key under `generate`,
  shipped in the same release as the option — a flag, a protocol param or both. *(Why:
  what a project settles once — how much context a hunk carries, what it is compared
  against — must not have to be retyped on every run or taught to every client
  separately.)* Exempt, because they name one run and not the project: the files of
  that run (`--in`, `--in-old`, `baseText`, `newText`, `path`, `--repo-path`, and
  `keep` — the hunks of this run a person wrote, not a setting of the project), where the
  config itself comes from (`--config`, `--no-config`, `--print-config`), how the run
  talks to a person (`--agreement`, `--yes`, `--help`, `--debug`, `--log`) and
  permission to download (`allowDownload`). A new exemption is
  added here, with its reason, before the option ships without a key. A key follows C2:
  schema + 1.

## 4. The patch format, and what has no number

- **F1. The patch format.** A patch is a `.sirp` file. Every `.sirp` a released sir
  wrote must parse and apply the same in every later release. `test/golden/*/apply/`
  holds this: an apply golden whose expected result changes is a breaking change unless
  the old result was a bug, and the commit says which. `test/golden/*/generate/` is
  different — it records the form `generate` prints; changing that form breaks no
  existing patch, so it is not breaking, but it is a visible change and goes into the
  CHANGELOG. *(Changed 2026-10-02: hatch 0.1–0.3 wrote patches as `.md`, with an
  optional `<!-- hatch: target=… -->` line; from 0.4 a `.md` is not a patch anywhere.
  Changed again 2026-10-22, by the author's decision: the project is renamed from hatch
  to sir (search, insert, replace), and from 0.5 a patch is a `.sirp` — a `.hatch` is
  not a patch anywhere, `apply` included, and no number keeps the old one readable:
  protocol, config schema and patch format all raise their minimum. From 0.5 on F1
  holds for `.sirp` without exception.)*
- **H1.** A `.sirp` opens with a header of `Name: value` lines up to the first blank
  line; the first is `Sir: N`, the format number. sir reads every patch whose `N` is in
  `[FORMAT_MIN, FORMAT_VERSION]` and writes `FORMAT_VERSION`. A file with no header is
  hunks alone, in the syntax of format 1; it is read while `FORMAT_MIN` names a format
  with those hunks — formats 1 and 2 share them — and refused as older once it does not.
- **H2.** The number rises only when the syntax of the hunks changes. A new header field
  does not raise it: fields sir does not know are read past. A change an older sir
  would read wrongly rather than refuse is a new number; one it cannot read at all
  (`FORMAT_MIN` raised) is breaking (P3).
- **H3.** Outside the range the message names the side: newer — update sir; older —
  regenerate the patch. One bump per release, frozen on release — as R3.
- **H4.** The fields sir knows have fixed places — `HEADER_FIELDS` in
  `src/core/header.ts`, the table "Patch header" in §6: line 1 is `Sir`, the rest
  follow in that order, each at most once; a field left out keeps the rest in order.
  `generate` writes in that order and `apply` refuses a known field out of it. A new
  field is **appended**: the last place in the list, the last row of the table — never
  between two fields that exist. A field is never moved, renamed or given to another
  meaning; one no longer written keeps its place and its name is not reused. Fields
  sir does not know may stand anywhere after `Sir` and are read past (H2), so a
  header a newer sir wrote still reads in an older one. A field is renamed only with a
  new format number that raises `FORMAT_MIN` past every format that had the old name,
  so no file is read under both. *(Broken twice. 2026-10-19: fields 3 and 4,
  `Generated-From` and `Generated-By`, were renamed in place to `Base-Blob` and
  `Hatch-Version`, the old names read as the new. 2026-10-22, with format 2 and the
  rename of the project: field 1 `Hatch` is `Sir`, field 4 `Hatch-Version` is
  `Sir-Version`, and format 1 is read no longer, so none of the old names is read —
  `Hatch` on line 1 is only recognised, to refuse the file as older. None of them is
  reused.)*
- **F3. Grammar pins.** A grammar is part of how a `.sirp` applies: a new version can
  shape the tree differently and move where a hunk lands. Every change of a pin in
  `src/lang/*/index.ts` runs the apply goldens, through the package and through every
  `sir-apply` binary; one whose expected result changes makes
  the change breaking (P3), unless the old result was a bug, and the commit says which.
- **F2. The CLI.** `sir` and `sir-apply` alike: the commands, flags and exit codes
  of `sir-apply` are a CLI, and its flags are a subset of `sir apply`'s with the same
  meaning. A flag may be added in any minor release. Removing, renaming or
  changing one is breaking (P3), and goes through one minor release first where the old
  spelling still works and warns. A flag that never shipped in a release may still be
  renamed freely.

## 5. Releasing

1. Everything for the release is committed on `dev`, and `CHANGELOG.md` has its entry
   with the four numbers (P6). The tables below are up to date (R10). A header field
   added in this release is the last row of "Patch header" and the last name in
   `HEADER_FIELDS` (H4), with this release in its "since" column.
   A config schema version shipping for the first time gets its row in
   `SCHEMA_RELEASED_IN` (`src/infra/config/template.ts`) with this release's tag: from
   then on a written config's `"$schema"` points at that tag, which never moves (P7),
   so the released schema file cannot change under anyone.
2. `npm run check` is green.
3. The version bump, alone in its commit (P5):
   `npm version minor -m "поднята версия"` (or `patch`, by P2).
4. `git push origin dev`, then a pull request `dev` → `main`, merged.
5. `git push origin vX.Y.Z` — the tag starts `.github/workflows/release.yml`, which
   checks the tag against `package.json`, runs typecheck and tests, packs, builds
   `sir-apply` for every platform (linux-x64, linux-arm64, darwin-arm64, win-x64),
   runs the apply goldens through each binary, writes `SHA256SUMS` and publishes the
   GitHub Release with all of it. Nothing goes to the npm registry.

## 6. Compatibility

### Releases

| release | date | protocol M–N | config M–N | format M–N | |
|---|---|---|---|---|---|
| 0.1.0 | 2026-08-27 | — no service | 1–1 | — a patch was a `.md` | first release |
| 0.1.1 | 2026-08-27 | — no service | 1–1 | — a patch was a `.md` | fix |
| 0.2.0 | 2026-09-24 | 2–2 | 1–1 | — a patch was a `.md` | the service arrives |
| 0.3.0 | 2026-09-28 | 2–3 | 1–1 | — a patch was a `.md` | apply from git, hand-written hunks, CRLF, PROTOCOL.md |
| 0.4.0 | — | — | — | — | tagged, and that is all: the check of the release failed, nothing was published. The number stays burned (P7) |
| 0.4.1 | 2026-10-06 | 4–4 | 2–2 | 1–1 | the 0.4 line as it went out: a patch is a `.hatch` with a header; a project over its upstream; `hatch-apply`; the grammars inside |
| 0.5.0 | 2026-10-22 | 5–5 | 3–3 | 2–2 | renamed from hatch to sir: a patch is a `.sirp` headed `Sir: 2`, the config `sir.config.json`, the commands `sir` and `sir-apply`; nothing of hatch is read. HTML, XML, CSS, JSON and the text formats; `keep` and the draft of a failed synthesis |

### Protocol

| N | first release | kind | what changed |
|---|---|---|---|
| 1 | never released | — | lived only inside `dev`; named two contracts (R2) |
| 2 | 0.2.0 | first | `version`, `generate`, `resolve`, `apply`; `generate` takes `baseText` or `baseGit`, answers `baseSpec`; `params.path` must be absolute |
| 3 | 0.3.0 | additive, M = 2 | `resolve`/`apply` take `baseGit` and answer `baseSpec`; `version` announces `protocolMin` and `configSchemaMin`; every file extension is also a language name (`languages` grows); `generate` writes the language's own name into `# match`; `baseGit.branch` finds a branch that shares its name with a tag; `language: ""` means none in every method; a patch lands in a CRLF base with CRLF lines — a fix, the old mixed endings were the bug |
| 4 | 0.4.1 | **breaking, M = 4** (R5) | `configTemplate`: the text of a new `hatch.config.json` for a schema version and settings, `suggestedPath`, `exists`, `versions`; a `ConfigError` about keys outside the schema carries `detail.version` and `detail.keys` — a key a schema dropped with the schemas that had it (`generate.mirror`: `since: 1, until: 1`), not `since: null`; `generate` with neither `baseText` nor `baseGit` takes the config's `generate.base` (refused before); `config.settings` grows `baseHead`, `baseBranch`, `baseCommit`, `baseEol`; methods `config` (the settings `generate` would apply, the base resolved, `watch`) and `pair` (code ↔ `.hatch`, `how: "target"`, `reason` when none); `generate` answers a `.hatch` with its header (`Hatch`, `Target`, `Generated-From`, `Generated-By`, `Grammar`); `warningsAt`; `baseGit.eol`; `resolve`/`apply` with no base take `generate.base`; `resolve` answers `baseText` for a git base; hunks in `resolve`/`apply` carry `note`, `noteSpan` from a `# note` block; `cancel { id }` and the error kind `Cancelled`; `config` answers an unreadable git base as `base.kind: "unavailable"`; `pair` reasons `newer-format`, `older-format`, `bad-header` (all `unsafe-target` before); a line that is JSON but no request object, and a param of the wrong type, answer `BadRequest` (the first ended the service, the second answered `TypeError`); `SynthesisError` `reason: "no-match"` when no candidate could be built (`ambiguous` before); a line ends at `\n` alone — a request holding U+2028 or U+2029 inside a string was cut in two and answered with two `BadRequest`s, `id: 0` (a fix: the transport always said one JSON object per line) |
| 4 | 0.4.1 | the breaking part (R5) | `generate` with no changes fails with the new kind `NoChanges` (exit 7) instead of `ParseError` — a new error kind a client could notice, so `protocolMin` rises to 4. `generate` that cannot anchor a change fails with the new kind `SynthesisError` (exit 8) instead of `MatchError`/`AmbiguityError`. Replies come as requests finish, no longer in their order. `generate`'s `md` is a `.hatch`: it opens with the header, with or without a `path`. The field `md` is renamed `patch` in `generate`, `resolve`, `apply`, `pair`. The config of a file may be one whose `upstream` claims it; `configPath`; `pair` `how: "upstream"` (no `mirror`), reasons `outside-upstream`, `two-patches`; `generate` answers `outExists`, `outTarget`; `config` answers `upstreamRoot`; the param `mirror` is gone. `resolve`/`apply` take the patch's own path (code by `Target`, base from its config) and answer `code`, `header`, `warningsAt`; `config` answers `projectRoot`, `target`; `configPath` on every method; `GitError` `detail.reason`; messages name no CLI flag; every reply carries `elapsedMs`. `allowDownload` is accepted and ignored: the grammars ship inside hatch. No client of protocols 2–3 was ever released; the notice S2 asked for was removed with it |

| 5 | 0.5.0 | **breaking, M = 5** (R5) | the rename of hatch to sir: `version` answers `sir` in place of `hatch`; a patch is a `.sirp` (a `.hatch` is code); its header is format 2 — `Sir`, `Target`, `Base-Blob`, `Sir-Version`, `Grammar` — and a patch of format 1 (`Hatch: 1`) is refused as older, `pair` reason `older-format`; `header` answers `baseBlob`, `sirVersion`, and no longer `generatedFrom`, `generatedBy`; the config is `sir.config.json`, schema 3–3, `configTemplate` writes it and `suggestedPath` names it; messages say "update sir". Additive in the same number: `config` answers `language`, the word `generate` writes in `# match` for that file, or `null`; `config` answers `header`, the header `generate` would write for that file now (`Base-Blob` only for a git base that can be read, `Grammar` only with a language), or `null` for a `.sirp` with no pair; `SynthesisError` (`no-match`, `ambiguous`) answers `detail.draft` — the `.sirp` to finish by hand: header, hunks so far, a hunk to start the change from — with `draftHunk`, `draftLine`, `change`; `generate` takes `keep`, a `.sirp` of settled hunks: each must land, synthesis goes on from them, they open `patch` byte for byte; a hunk of `keep` that does not land answers its error kind with `detail.hunk`, `detail.mdLine`; the link table (`hunks` of `resolve`, `apply`, `generate`): `final` holds no text of a later hunk written at its edge, `base` no text an earlier hunk deleted at its edge — a fix, PROTOCOL.md always said what a hunk writes and what it replaces; the last hunk of `detail.draft`, laid as it is, makes the change with the blank lines above it — a fix, it dropped them; in Python one outdent closes every block nested inside: a closer past an overdue block with no closing token, nested in the block it ends, is no escape — `generate`, `resolve`, `apply` find a parent and its closer where they refused, and refuse as ambiguous a pattern that landed in a class it did not name (a fix); `ParseError` `mdLine` for a match block with no `# patch` after it at the end of the file names its `# end`, not a line past the end — a fix; `languages` grows by `html`, `htm`, `xml`, `plist`, `css`, `json`: HTML (`.html`, `.htm`), XML (`.xml`, `.plist`), CSS (`.css`), JSON (`.json`); `languages` grows by `json5` (`.json5`, read by the JavaScript grammar) and `star` (`.star` is Python); a file named `DEPS` is Python; `languages` grows by formats read as text, with no grammar — blocks by the balance of brackets: `idl` (`.idl`, `.webidl`), `mojom`, `proto` (`protobuf`), `shell` (`.sh`, `.bash`; files named `postinst`, `postrm`, `preinst`, `prerm`), `yaml` (`.yml`), `toml`, `text` (`.txt`); the header of such a patch has no `Grammar`; `generate` for a change that is the whole file spells the text it replaces — a pattern with no literal fit every file and wrote over it (a fix); a Python file opening with a BOM takes a pattern pinned to its first line (a fix) |

### Config schema

| N | first release | kind | what changed |
|---|---|---|---|
| 1 | 0.1.0 | first | `generate`: `out`, `language`, `exact`, `bridgeGap`, `parents`, `siblings` |
| 1 | 0.2.0 | **added without a bump** | `generate.mirror` — before these rules; by C2 it would be schema 2. A config using it, read by hatch 0.1.x, fails with "unknown key" rather than "update hatch". Left as released (P7); marked `unbumpedIn` in `FIELDS` and in the v1 summary |
| 2 | 0.4.1 | **breaking, M = 2** (C3) | `generate.base`: `head`, `branch`, `commit` — the old version out of git, as `--head` / `--branch` / `--commit` (C6); `generate.base.eol` (`--eol`); `upstream` (top level): the root of the code the project patches, from the config file — `generate.out` is then the root of the patch tree; `generate.mirror` removed (`"upstream": "."` takes its place), so schema 1 is read no longer |
| 3 | 0.5.0 | **breaking, M = 3** (C3) | the file is `sir.config.json` (was `hatch.config.json`), its schema `sir.config.v3.schema.json`; the keys are those of schema 2; schemas 1 and 2 are read no longer |

### Patch format

| N | first release | kind | what changed |
|---|---|---|---|
| 1 | 0.4.1 | first | `.hatch` with the header `Hatch`, `Target`, `Generated-From`, `Generated-By`, `Grammar`; the hunks as the `.md` of 0.1–0.3 wrote them |
| 2 | 0.5.0 | **breaking, M = 2** (H2, H4) | `.sirp` with the header `Sir`, `Target`, `Base-Blob`, `Sir-Version`, `Grammar`; the hunks as format 1 has them, so a file with no header still reads (H1); format 1 is read no longer — a `Hatch: 1` line is refused as older |

### Patch header

The order of the header, one row per field (H4). New fields are added as new rows at the
end.

| # | field | since | what |
|---|---|---|---|
| 1 | `Sir` | format 2, 0.5.0 | the format number; always the first line; `Hatch` in format 1 |
| 2 | `Target` | format 1, 0.4.1 | the file the patch is for, relative with `/` |
| 3 | `Base-Blob` | format 1, 0.4.1 | the git blob of the base, when it came out of git; `Generated-From` in 0.4.1 |
| 4 | `Sir-Version` | format 2, 0.5.0 | the version of sir, `0.5.0`; `Generated-By: hatch <version>` in 0.4.1 |
| 5 | `Grammar` | format 1, 0.4.1 | `<package>@<version>` of the grammar |

### Clients

| client | version | protocol it speaks | |
|---|---|---|---|
| VS Code extension (`HatchVSCodeExtension-`, now `S.I.R-VScodeExtension`) | 0.0.1, 2026-10-06 | 4–4 | range check as R8; relies on `configTemplate`, `config`, `pair`, `configPath`, `resolve`/`apply` by the patch's path — protocol 4 |
| VS Code extension (`S.I.R-VScodeExtension`) | 0.1.0, 2026-10-22 | 5–5 | range check as R8; the rename to sir: `.sirp`, `sir.config.json`, `version.sir`, `header.sirVersion`; carries sir 0.5.0 inside |

## 7. Support

- **S1.** Before 1.0.0 fixes ship only in the next release from `dev`; there are no
  patch releases of an older minor. From 1.0.0: fixes go to the latest minor (§8),
  security fixes to the latest and the previous one.
- ~~**S2.**~~ *Removed 2026-09-29.* It asked for a raise of `PROTOCOL_MIN` or
  `CONFIG_MIN` to be announced in the CHANGELOG of the release before. *(Why: protocol
  4 raises `PROTOCOL_MIN` by R5 with no client of protocols 2–3 ever released — the one
  client, the VS Code extension, ships together with it — so the notice had no one to
  reach.)* A raise still needs a release allowed to break (P2, P3) and says in its own
  entry what to update. The number stays free: it is not reused.
- **S3.** A client version that speaks the new protocol ships before, or together with,
  the sir that raises `PROTOCOL_MIN`; the Clients table in §6 is updated with it.
- **S4.** A Node version is dropped only after its end of life, only in a release that is
  allowed to break, and announced in the `CHANGELOG.md` entry of the release before.
  The same holds for the minimum git.

## 8. Patch releases from 1.0.0

Before 1.0.0 there are none (S1). From 1.0.0, a fix for a released line that must not
wait for everything else on `dev`:

1. A branch `release/X.Y.x` from the tag `vX.Y.0` (or the last `vX.Y.Z`).
2. Only fixes on it: nothing that changes documented behavior (P2), and neither range
   moves (P4).
3. The fix is committed there, or cherry-picked from `dev`; `CHANGELOG.md` gets the
   `X.Y.Z+1` entry; `npm version patch` alone in its commit (P5); the tag goes from
   this branch — the release workflow starts from the tag, whatever the branch.
4. The fix and its `CHANGELOG.md` entry are merged forward into `dev` and `main`.

